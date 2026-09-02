import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AgentProfileRow } from '../../schema/agent-profiles.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AI_AUDIT_ENTITY_TYPES, AI_ERROR_CODES } from './ai.constants';
import type { CreateAgentProfileDto, UpdateAgentProfileDto } from './ai.dto';
import { AgentCredentialRepository } from './agent-credential.repository';
import { AgentProfileRepository, type AgentProfileUpdate } from './agent-profile.repository';

/** Shared 404 shape for a missing profile id — also used by `agent-credential.service.ts` when validating a `profileId`. */
export function profileNotFound(): NotFoundException {
  return new NotFoundException({ code: AI_ERROR_CODES.PROFILE_NOT_FOUND, message: 'Agent profile not found.' });
}

function profileNameTaken(): ConflictException {
  return new ConflictException({
    code: AI_ERROR_CODES.PROFILE_NAME_TAKEN,
    message: 'An agent profile with this name already exists.',
  });
}

/**
 * `agent_profiles` admin CRUD. Every mutation writes an `audit_log` row with
 * before/after — this table decides which third party the client's money is
 * spent with, so "who changed the model to the expensive one" has to be
 * answerable.
 *
 * Nothing here touches credentials beyond counting them for the delete guard;
 * key material never passes through this file at all.
 */
@Injectable()
export class AgentProfileService {
  constructor(
    private readonly repo: AgentProfileRepository,
    private readonly credentialRepo: AgentCredentialRepository,
    private readonly audit: AuditService,
  ) {}

  async adminList(): Promise<AgentProfileRow[]> {
    return this.repo.list();
  }

  async adminGetById(id: string): Promise<AgentProfileRow> {
    const profile = await this.repo.findById(id);
    if (!profile) throw profileNotFound();
    return profile;
  }

  /** Rejects a duplicate `name` cleanly (409) — same check-first-then-catch-the-race pattern as `catalogue/specialty.service.ts#adminCreate`. */
  async adminCreate(actingAdminId: string, dto: CreateAgentProfileDto): Promise<AgentProfileRow> {
    const existing = await this.repo.findByName(dto.name);
    if (existing) throw profileNameTaken();

    let profile: AgentProfileRow;
    try {
      profile = await this.repo.create({
        name: dto.name,
        provider: dto.provider,
        model: dto.model,
        baseUrl: dto.baseUrl ?? null,
        config: dto.config,
        priority: dto.priority,
        isActive: dto.isActive,
      });
    } catch (error) {
      // Safety net for the check-then-insert race: two concurrent callers can
      // both pass the `findByName` check above before either inserts, so the
      // second insert hits the `agent_profiles_name_unique` constraint
      // instead. Converts that raw driver error into the same 409 the
      // sequential check already throws.
      if (isUniqueConstraintViolation(error)) throw profileNameTaken();
      throw error;
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_PROFILE,
      entityId: profile.id,
      metadata: { after: this.definedFieldsOnly(dto) },
    });
    return profile;
  }

  /** Skips the update AND the audit write entirely when the DTO carries no defined fields — same discipline as `catalogue/specialty.service.ts#adminUpdate`. */
  async adminUpdate(actingAdminId: string, id: string, dto: UpdateAgentProfileDto): Promise<AgentProfileRow> {
    const profile = await this.repo.findById(id);
    if (!profile) throw profileNotFound();

    const fields = this.definedFieldsOnly(dto);
    if (Object.keys(fields).length === 0) {
      return profile;
    }

    if (fields.name !== undefined && fields.name !== profile.name) {
      const clash = await this.repo.findByName(fields.name);
      if (clash && clash.id !== id) throw profileNameTaken();
    }

    const before = this.extractBefore(profile, fields);
    let updated: AgentProfileRow | null;
    try {
      updated = await this.repo.update(id, fields);
    } catch (error) {
      // Same check-then-update race as `adminCreate`'s.
      if (isUniqueConstraintViolation(error)) throw profileNameTaken();
      throw error;
    }
    if (!updated) throw profileNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_PROFILE,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /**
   * REFUSES to delete a profile that still has credentials (409), rather than
   * cascading — even though the FK would happily cascade.
   *
   * This is the deliberate safety choice between the two options the design
   * allowed:
   *   - Cascading destroys N third-party API keys behind one click. They are
   *     not recoverable from us: the admin would have to go back to each
   *     provider's dashboard and mint new ones, and any key they cannot mint
   *     again (a shared account, a departed colleague's key) is simply gone.
   *   - Cascading also writes ONE audit row, naming the profile. The record
   *     of which keys existed and when they were destroyed disappears with
   *     them, which is exactly the record an incident review would want.
   *
   * Making the admin delete each credential first costs one extra click per
   * key and produces one audit row per key. The FK's `ON DELETE CASCADE`
   * stays as a data-integrity backstop for direct-SQL deletes; the API never
   * relies on it.
   */
  async adminDelete(actingAdminId: string, id: string): Promise<void> {
    const profile = await this.repo.findById(id);
    if (!profile) throw profileNotFound();

    const credentialCount = await this.credentialRepo.countByProfile(id);
    if (credentialCount > 0) {
      throw new ConflictException({
        code: AI_ERROR_CODES.PROFILE_HAS_CREDENTIALS,
        message: `This profile still has ${credentialCount} credential(s). Delete them first — they are not recoverable once removed.`,
        credentialCount,
      });
    }

    const deleted = await this.repo.deleteById(id);
    if (!deleted) throw profileNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'delete',
      entityType: AI_AUDIT_ENTITY_TYPES.AGENT_PROFILE,
      entityId: id,
      metadata: {
        before: {
          name: profile.name,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          priority: profile.priority,
          isActive: profile.isActive,
        },
      },
    });
  }

  /** Used by `agent-credential.service.ts` to validate a `profileId` exists before creating a credential under it. */
  async findRawById(id: string): Promise<AgentProfileRow | null> {
    return this.repo.findById(id);
  }

  private definedFieldsOnly(dto: CreateAgentProfileDto | UpdateAgentProfileDto): AgentProfileUpdate {
    const fields: AgentProfileUpdate = {};
    if (dto.name !== undefined) fields.name = dto.name;
    if (dto.provider !== undefined) fields.provider = dto.provider;
    if (dto.model !== undefined) fields.model = dto.model;
    if (dto.baseUrl !== undefined) fields.baseUrl = dto.baseUrl;
    if (dto.config !== undefined) fields.config = dto.config;
    if (dto.priority !== undefined) fields.priority = dto.priority;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;
    return fields;
  }

  private extractBefore(row: AgentProfileRow, fields: object): Record<string, unknown> {
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      before[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return before;
  }
}
