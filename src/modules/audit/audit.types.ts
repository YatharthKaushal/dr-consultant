import type { ActorType, AuditAction } from '../../schema/enums.schema';

/**
 * One `audit_log` row as this module's own search/export surface shows it.
 *
 * *** DELIBERATELY NO `ipAddress`. *** This follows `clinical.contract.ts`'s
 * `ClinicalAuditEntryView` precedent exactly, rather than inventing a second,
 * separate visibility-tiering system for the same column: "the trail answers
 * 'what happened to this case', not 'from where', and an operator reading
 * clinical governance has no minimum-necessary claim on an actor's network
 * address (SRS §6.2)." Nothing in SRS §6.1 ("Security") or §6.7
 * ("Auditability") asks for a finer-grained, per-admin visibility tier on
 * this column — both sections describe WHAT must be logged and searchable,
 * never who specifically may see an IP once logged — so this module holds
 * the line `clinical` already drew rather than widening it. `ipAddress` is
 * still WRITTEN to every row (`audit_log.schema.ts`, `AuditService.write`);
 * it is simply never read back out through this surface.
 */
export interface AuditLogView {
  /** `audit_log.id` is a `bigserial`, not a uuid. */
  id: number;
  actorType: ActorType;
  /** Null for `actorType: 'system'`. */
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  consultationId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/** `GET /admin/audit/log`'s filter set — actor, module (`entityType`), date range and `action`, all optional and AND-combined. */
export interface AuditLogFilter {
  actorType?: ActorType;
  actorId?: string;
  entityType?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}
