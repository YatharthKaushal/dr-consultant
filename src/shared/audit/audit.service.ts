import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { auditLogTable } from '../../schema/audit-log.schema';
import type { AuditEntry } from './audit.types';

/**
 * The audit entry writer named in `backend/README.md`'s M-01 feature list
 * ("Audit entry writer used by every module") and `docs/MODULES.md`'s
 * "Shared authorisation checks... Audit entry writer used by every module" —
 * built here because `identity` is the first of ~15 modules that needs one,
 * and `audit_log` (schema-only until now) has no writer.
 *
 * Two call modes, both genuinely used:
 *   - transactional (`tx` passed) — the write commits or rolls back with the
 *     state change it audits. Every RBAC grant/revoke in this module uses
 *     this, because a role or permission change must never exist un-audited.
 *   - best-effort (no `tx`) — the write is attempted and its failure is
 *     logged and swallowed, never thrown. A login succeeding is more
 *     important than its log line; failing a user's sign-in because the
 *     audit insert failed would be a self-inflicted outage.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async write(entry: AuditEntry, tx?: Database | DatabaseTransaction): Promise<void> {
    const executor = tx ?? this.db;
    const row = {
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      consultationId: entry.consultationId ?? null,
      metadata: entry.metadata ?? null,
      ipAddress: entry.ipAddress ?? null,
    };

    if (tx) {
      // Transactional: let a failure propagate and roll back the caller's transaction.
      await executor.insert(auditLogTable).values(row);
      return;
    }

    // Best-effort: never let a log-write failure fail the caller's flow.
    try {
      await executor.insert(auditLogTable).values(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to write audit log entry (best-effort, swallowed): ${message}`);
    }
  }
}
