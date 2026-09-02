import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AI_AUDIT_ENTITY_TYPES, AI_ERROR_CODES } from './ai.constants';
import type { CreateAgentCredentialDto, UpdateAgentCredentialDto } from './ai.dto';
import { AgentCredentialRepository, type AgentCredentialUpdate } from './agent-credential.repository';
import { AgentProfileService, profileNotFound } from './agent-profile.service';
import { AiCryptoService } from './ai-crypto.service';
import { AiRotationService } from './ai-rotation.service';
import type { CredentialTestResult } from './ai.mapper';
import { toPublicAgentCredential } from './ai.mapper';
import { LlmProviderRegistry } from './llm-provider.registry';

/**
 * The credential-test probe: the smallest possible real completion.
 *
 * Deliberately trivial — a one-field boolean schema and a two-sentence
 * prompt. The button answers "can this key reach this model and come back
 * with a valid structured answer", and every extra token is billed to the
 * client for a question that a handful of tokens already answers. It is a
 * REAL structured-output call, not a `/models` list or a ping, because a key
 * that can list models but cannot invoke the configured one would pass a
 * cheaper check and still be useless.
 */
const PROBE_SCHEMA = z.object({ ok: z.boolean() });

const PROBE_REQUEST = {
  system: 'You are a connectivity probe. Reply with the JSON object {"ok": true} and nothing else.',
  user: 'Reply with ok set to true.',
  schema: PROBE_SCHEMA,
  maxTokens: 64,
};

/** Shared 404 shape for a missing credential id. */
export function credentialNotFound(): NotFoundException {
  return new NotFoundException({
    code: AI_ERROR_CODES.CREDENTIAL_NOT_FOUND,
    message: 'Agent credential not found.',
  });
}

function credentialLabelTaken(): ConflictException {
  return new ConflictException({
    code: AI_ERROR_CODES.CREDENTIAL_LABEL_TAKEN,
    message: 'A credential with this label already exists under this profile.',
  });
}

/**
 * `agent_credentials` admin CRUD — the one place a plaintext provider API key
 * legitimately exists, and the one place responsible for making sure it never
 * goes anywhere else.
 *
 * The rule this file exists to keep: a plaintext key arrives in a DTO, is
 * handed straight to `AiCryptoService.encrypt`, and the plaintext is not
 * referenced again. It is never returned (the mapper has no field for it),
 * never logged, and never written to `audit_log` — every audit row below
 * carries `label` and `keyLast4` and nothing else about the key. The
 * `metadata` objects are built by hand, field by field, rather than spread
 * from the DTO, precisely so a future field cannot ride along by accident.
 * `agent-credential.service.spec.ts` asserts this directly.
 */
@Injectable()
export class AgentCredentialService {
  constructor(
    private readonly repo: AgentCredentialRepository,
    private readonly profileService: AgentProfileService,
    private readonly crypto: AiCryptoService,
    private readonly audit: AuditService,
    private readonly rotation: AiRotationService,
    private readonly registry: LlmProviderRegistry,
  ) {}

  async adminListByProfile(profileId: string): Promise<AgentCredentialRow[]> {
    const profile = await this.profileService.findRawById(profileId);
    if (!profile) throw profileNotFound();
    return this.repo.listByProfile(profileId);
  }

  async adminGetById(id: string): Promise<AgentCredentialRow> {
    const credential = await this.repo.findById(id);
    if (!credential) throw credentialNotFound();
    return credential;
  }

  /** Validates the profile exists (404) before creating, then rejects a duplicate `(profileId, label)` pair (409) — the same shape as `catalogue/concern.service.ts#adminCreate`'s specialty-existence check. */
  async adminCreate(
    actingAdminId: string,
    profileId: string,
    dto: CreateAgentCredentialDto,
  ): Promise<AgentCredentialRow> {
    const profile = await this.profileService.findRawById(profileId);
    if (!profile) throw profileNotFound();

    const existing = await this.repo.findByProfileAndLabel(profileId, dto.label);
    if (existing) throw credentialLabelTaken();

    const keyLast4 = this.crypto.lastFour(dto.key);

    let credential: AgentCredentialRow;
    try {
      credential = await this.repo.create({
        profileId,
        label: dto.label,
        encryptedKey: this.crypto.encrypt(dto.key),
        keyLast4,
        priority: dto.priority,
        isActive: dto.isActive,
      });
    } catch (error) {
      // Safety net for the check-then-insert race: two concurrent callers can
      // both pass the `findByProfileAndLabel` check above before either
      // inserts, so the second insert hits the
      // `agent_credentials_profile_id_label_index` unique index instead.
      if (isUniqueConstraintViolation(error)) throw credentialLabelTaken();
      throw error;
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_CREDENTIAL,
      entityId: credential.id,
      // Key material is NOT here and must never be. `keyLast4` identifies
      // which key was added without being enough to use one.
      metadata: {
        after: {
          profileId,
          label: dto.label,
          keyLast4,
          priority: dto.priority,
          isActive: dto.isActive,
        },
      },
    });
    return credential;
  }

  /**
   * Relabel/reprioritise/enable/disable, and optionally rotate the key in
   * place (same credential id, same position in the rotation order).
   *
   * Two no-op guards, both deliberate:
   *   - An empty DTO writes nothing and audits nothing — same discipline as
   *     `catalogue/specialty.service.ts#adminUpdate`.
   *   - A `key` that is byte-identical to the stored one is dropped from the
   *     update rather than re-encrypted. Re-encrypting would produce new
   *     ciphertext (fresh IV) and so would look like a real change forever
   *     after, filling the audit log with rotations that never happened. The
   *     comparison is constant-time (`AiCryptoService.matches`) so it cannot
   *     be used as an oracle.
   *
   * Rotating the key deliberately does NOT reset the health columns. A key
   * that was cooling down stays cooling down: the admin has replaced the
   * secret, not proved the new one works, and the credential-test endpoint
   * exists for exactly that. Clearing the cooldown here would put an unproven
   * key at the front of the rotation queue on the strength of a paste.
   */
  async adminUpdate(actingAdminId: string, id: string, dto: UpdateAgentCredentialDto): Promise<AgentCredentialRow> {
    const credential = await this.repo.findById(id);
    if (!credential) throw credentialNotFound();

    const fields: AgentCredentialUpdate = {};
    if (dto.label !== undefined) fields.label = dto.label;
    if (dto.priority !== undefined) fields.priority = dto.priority;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;

    const keyChanged = dto.key !== undefined && !this.crypto.matches(credential.encryptedKey, dto.key);
    if (keyChanged) {
      fields.encryptedKey = this.crypto.encrypt(dto.key as string);
      fields.keyLast4 = this.crypto.lastFour(dto.key as string);
    }

    if (Object.keys(fields).length === 0) {
      return credential;
    }

    if (fields.label !== undefined && fields.label !== credential.label) {
      const clash = await this.repo.findByProfileAndLabel(credential.profileId, fields.label);
      if (clash && clash.id !== id) throw credentialLabelTaken();
    }

    let updated: AgentCredentialRow | null;
    try {
      updated = await this.repo.update(id, fields);
    } catch (error) {
      // Same check-then-update race as `adminCreate`'s.
      if (isUniqueConstraintViolation(error)) throw credentialLabelTaken();
      throw error;
    }
    if (!updated) throw credentialNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_CREDENTIAL,
      entityId: id,
      // Built by hand rather than from `fields`, because `fields` carries
      // `encryptedKey`. The rotation is recorded as a boolean plus the new
      // last-four; the ciphertext is not audit-worthy and the plaintext is
      // certainly not.
      metadata: {
        before: this.auditableBefore(credential, fields, keyChanged),
        after: this.auditableAfter(fields, keyChanged),
      },
    });
    return updated;
  }

  async adminDelete(actingAdminId: string, id: string): Promise<void> {
    const credential = await this.repo.findById(id);
    if (!credential) throw credentialNotFound();

    const deleted = await this.repo.deleteById(id);
    if (!deleted) throw credentialNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'delete',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_CREDENTIAL,
      entityId: id,
      metadata: {
        before: {
          profileId: credential.profileId,
          label: credential.label,
          keyLast4: credential.keyLast4,
          priority: credential.priority,
          isActive: credential.isActive,
        },
      },
    });
  }

  /**
   * Live probe of one credential — `POST /admin/ai/credentials/:id/test`.
   *
   * Answers with a RESULT, not an exception, when the provider rejects the
   * key: the admin asked "does this work", and "no, the quota is exhausted"
   * is the answer to that question, not a failure of their request. The two
   * cases that DO throw are the ones where no call was made at all —
   * `UNSUPPORTED_PROVIDER` (this build has no adapter for the stored provider
   * string) and `PROVIDER_NOT_CONFIGURED` (an adapter exists but cannot be
   * constructed, i.e. the Bedrock stub). Reporting those as a provider
   * failure would tell the admin their key is bad when it may be perfectly
   * good.
   *
   * The probe records health exactly like a real attempt, which is the second
   * reason the button exists: a successful test CLEARS a stale cooldown and
   * puts a recovered key straight back into rotation, without waiting for it
   * to expire and without the admin touching `is_active`.
   *
   * Audited as a `verify` action. The metadata carries the outcome and
   * `keyLast4` — never the key, and never the raw vendor detail (which is
   * redacted but still vendor-controlled text, and `audit_log` is not the
   * place for it; it goes to the server log instead).
   */
  async adminTest(actingAdminId: string, id: string): Promise<CredentialTestResult> {
    const candidate = await this.repo.findByIdWithProfile(id);
    if (!candidate) throw credentialNotFound();

    // Throws 400 UNSUPPORTED_PROVIDER when the stored provider string has no
    // adapter — a data problem the admin can act on, not a probe result.
    this.registry.require(candidate.profile.provider);

    const outcome = await this.rotation.probe(candidate, PROBE_REQUEST);

    if (outcome.providerNotConfigured) {
      throw new ServiceUnavailableException({
        code: AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        message: `Provider "${candidate.profile.provider}" is not configured in this build, so this credential cannot be tested.`,
      });
    }

    // Re-read so the response carries the health columns as they stand AFTER
    // the probe was recorded — the whole point of the button is to see the
    // cooldown clear (or appear).
    const refreshed = (await this.repo.findById(id)) ?? candidate.credential;

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'verify',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_CREDENTIAL,
      entityId: id,
      metadata: {
        profileId: candidate.profile.id,
        label: candidate.credential.label,
        keyLast4: candidate.credential.keyLast4,
        ok: outcome.ok,
        failureKind: outcome.failureKind,
        latencyMs: outcome.latencyMs,
      },
    });

    return {
      ok: outcome.ok,
      failureKind: outcome.failureKind,
      detail: outcome.detail,
      latencyMs: outcome.latencyMs,
      credential: toPublicAgentCredential(refreshed),
    };
  }

  private auditableBefore(
    row: AgentCredentialRow,
    fields: AgentCredentialUpdate,
    keyChanged: boolean,
  ): Record<string, unknown> {
    const before: Record<string, unknown> = {};
    if (fields.label !== undefined) before.label = row.label;
    if (fields.priority !== undefined) before.priority = row.priority;
    if (fields.isActive !== undefined) before.isActive = row.isActive;
    if (keyChanged) before.keyLast4 = row.keyLast4;
    return before;
  }

  private auditableAfter(fields: AgentCredentialUpdate, keyChanged: boolean): Record<string, unknown> {
    const after: Record<string, unknown> = {};
    if (fields.label !== undefined) after.label = fields.label;
    if (fields.priority !== undefined) after.priority = fields.priority;
    if (fields.isActive !== undefined) after.isActive = fields.isActive;
    if (keyChanged) {
      after.keyRotated = true;
      after.keyLast4 = fields.keyLast4;
    }
    return after;
  }
}
