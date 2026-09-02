import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { ToolRegistry } from '../search/tools/search-tool.registry';
import { MCP_AUDIT_ENTITY_TYPES, MCP_ERROR_CODES } from './mcp.constants';
import type { CreatedMcpClient, McpClientContext, PublicMcpClient } from './mcp.contract';
import { McpClientRepository } from './mcp-client.repository';
import { extractKeyPrefix, generateMcpKey, spendDecoyVerification, verifyMcpKey } from './mcp-client-key.util';
import { toPublicMcpClient } from './mcp.mapper';

export interface CreateMcpClientInput {
  name: string;
  scopes: string[];
}

export interface UpdateMcpClientInput {
  name?: string;
  scopes?: string[];
  isActive?: boolean;
}

/**
 * `mcp_clients` CRUD plus the authentication of a presented key.
 *
 * Every mutation writes an `audit_log` row with before/after. NONE of those
 * rows ever carries key material: the audited "after" of a creation is the
 * public projection (`keyPrefix`/`keyLast4`/`scopes`), never the plaintext
 * key and never the digest. An audit log is read by more people, and kept
 * longer, than almost anything else in the system, so it is the last place a
 * credential should be able to reach.
 */
@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);

  constructor(
    private readonly repo: McpClientRepository,
    private readonly registry: ToolRegistry,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Admin CRUD                                                              */
  /* ---------------------------------------------------------------------- */

  async list(): Promise<PublicMcpClient[]> {
    const rows = await this.repo.list();
    return rows.map(toPublicMcpClient);
  }

  async getById(id: string): Promise<PublicMcpClient> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException({ code: MCP_ERROR_CODES.CLIENT_NOT_FOUND, message: 'No MCP client with that id.' });
    }
    return toPublicMcpClient(row);
  }

  /** The ONLY method that ever produces a plaintext key, and it is never persisted. */
  async create(adminId: string, input: CreateMcpClientInput): Promise<CreatedMcpClient> {
    this.assertKnownScopes(input.scopes);

    const existing = await this.repo.findByName(input.name);
    if (existing) {
      throw new ConflictException({ code: MCP_ERROR_CODES.CLIENT_NAME_TAKEN, message: 'An MCP client with that name already exists.' });
    }

    const key = await generateMcpKey();

    let row;
    try {
      row = await this.repo.create({
        name: input.name,
        hashedKey: key.hashedKey,
        keyPrefix: key.keyPrefix,
        keyLast4: key.keyLast4,
        scopes: input.scopes,
      });
    } catch (error) {
      // Two admins creating the same name concurrently both pass the SELECT
      // above; the second hits the unique index. Same safety net the doctor
      // and catalogue services put under their own duplicate checks.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({ code: MCP_ERROR_CODES.CLIENT_NAME_TAKEN, message: 'An MCP client with that name already exists.' });
      }
      throw error;
    }

    const client = toPublicMcpClient(row);
    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'create',
      entityType: MCP_AUDIT_ENTITY_TYPES.CLIENT,
      entityId: row.id,
      // `client` is the public projection — no digest, no plaintext key.
      metadata: { before: null, after: client },
    });

    return { client, plaintextKey: key.plaintextKey };
  }

  async update(adminId: string, id: string, input: UpdateMcpClientInput): Promise<PublicMcpClient> {
    if (input.scopes !== undefined) {
      this.assertKnownScopes(input.scopes);
    }

    const before = await this.repo.findById(id);
    if (!before) {
      throw new NotFoundException({ code: MCP_ERROR_CODES.CLIENT_NOT_FOUND, message: 'No MCP client with that id.' });
    }

    const fields = this.definedFieldsOnly(input);
    if (Object.keys(fields).length === 0) {
      return toPublicMcpClient(before);
    }

    if (fields.name !== undefined && fields.name !== before.name) {
      const clash = await this.repo.findByName(fields.name);
      if (clash) {
        throw new ConflictException({ code: MCP_ERROR_CODES.CLIENT_NAME_TAKEN, message: 'An MCP client with that name already exists.' });
      }
    }

    let updated;
    try {
      updated = await this.repo.update(id, fields);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({ code: MCP_ERROR_CODES.CLIENT_NAME_TAKEN, message: 'An MCP client with that name already exists.' });
      }
      throw error;
    }

    if (!updated) {
      throw new NotFoundException({ code: MCP_ERROR_CODES.CLIENT_NOT_FOUND, message: 'No MCP client with that id.' });
    }

    const after = toPublicMcpClient(updated);
    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'update',
      entityType: MCP_AUDIT_ENTITY_TYPES.CLIENT,
      entityId: id,
      metadata: { before: toPublicMcpClient(before), after },
    });

    return after;
  }

  async remove(adminId: string, id: string): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) {
      throw new NotFoundException({ code: MCP_ERROR_CODES.CLIENT_NOT_FOUND, message: 'No MCP client with that id.' });
    }

    await this.repo.delete(id);

    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'delete',
      entityType: MCP_AUDIT_ENTITY_TYPES.CLIENT,
      entityId: id,
      metadata: { before: toPublicMcpClient(before), after: null },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Verifies a presented key and returns the caller's context, or `null`.
   *
   * ONE `null` FOR EVERY FAILURE — malformed key, unknown prefix, wrong key,
   * deactivated client. The caller reports a single `MCP_UNAUTHENTICATED`, so
   * the response never distinguishes "no such client" from "wrong key" from
   * "this client was switched off", which would otherwise let a holder of a
   * revoked key confirm the integration still exists. Same discipline
   * `auth.constants.ts` documents for `resolveAccessToken`.
   *
   * Both branches spend comparable scrypt work — an unknown prefix runs
   * `spendDecoyVerification` — so response latency does not reveal which
   * prefixes are real.
   */
  async authenticate(presentedKey: string): Promise<McpClientContext | null> {
    const prefix = extractKeyPrefix(presentedKey);
    const row = await this.repo.findByKeyPrefix(prefix);

    if (!row) {
      await spendDecoyVerification(presentedKey);
      return null;
    }

    const matches = await verifyMcpKey(presentedKey, row.hashedKey);
    if (!matches || !row.isActive) {
      return null;
    }

    // Best-effort: an MCP request must not fail because a convenience
    // timestamp could not be written.
    try {
      await this.repo.touchLastUsed(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to update mcp_clients.last_used_at (best-effort, swallowed): ${message}`);
    }

    return { clientId: row.id, name: row.name, scopes: row.scopes };
  }

  /* ---------------------------------------------------------------------- */

  /** Scopes must name real tools — a typo'd scope would otherwise silently grant nothing and be very hard to spot. */
  private assertKnownScopes(scopes: string[]): void {
    const unknown = scopes.filter((scope) => !this.registry.has(scope));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: MCP_ERROR_CODES.UNKNOWN_SCOPE,
        message: `Unknown tool name(s) in scopes: ${unknown.join(', ')}. Valid names: ${this.registry.listNames().join(', ')}.`,
      });
    }
  }

  private definedFieldsOnly(input: UpdateMcpClientInput): UpdateMcpClientInput {
    const fields: UpdateMcpClientInput = {};
    if (input.name !== undefined) fields.name = input.name;
    if (input.scopes !== undefined) fields.scopes = input.scopes;
    if (input.isActive !== undefined) fields.isActive = input.isActive;
    return fields;
  }
}
