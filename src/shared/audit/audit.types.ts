import type { ActorType, AuditAction } from '../../schema/enums.schema';

/**
 * One `audit_log` row, pre-validation. Mirrors the table's columns
 * (`src/schema/audit-log.schema.ts`) one-to-one — this is the write
 * contract every module composes against, not a DTO.
 */
export interface AuditEntry {
  actorType: ActorType;
  /** Null for `actorType: 'system'`. */
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  consultationId?: string;
  /** Before/after for config, raw payload for webhooks, identifier for login attempts, document id for verification. */
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}
