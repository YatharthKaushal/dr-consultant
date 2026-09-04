import type { AuditLogRow } from '../../schema/audit-log.schema';
import type { AuditLogView } from './audit.types';

/** `AuditLogRow` (carries `ipAddress`) -> `AuditLogView` (never does). See `audit.types.ts#AuditLogView`'s header. */
export function toAuditLogView(row: AuditLogRow): AuditLogView {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    consultationId: row.consultationId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}
