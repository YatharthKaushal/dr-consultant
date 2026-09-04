import { Injectable } from '@nestjs/common';
import { toCsvDocument } from '../../shared/csv/csv.util';
import { AuditService } from '../../shared/audit/audit.service';
import { AUDIT_AUDIT_ENTITY_TYPES, AUDIT_EXPORT_MAX_ROWS } from './audit.constants';
import { AuditRepository } from './audit.repository';
import type { AuditLogFilter } from './audit.types';
import { toAuditLogView } from './audit-mapper.util';

export interface AuditCsvExport {
  filename: string;
  content: string;
  rowCount: number;
}

/**
 * `audit.export` — CSV, row-capped rather than streamed (`AUDIT_EXPORT_MAX_
 * ROWS`, same honesty `payment.constants.ts#PAYMENT_EXPORT_MAX_ROWS` states).
 *
 * Re-runs the SAME filtered query the search screen uses
 * (`AuditRepository.listForAdmin`), capped to `AUDIT_EXPORT_MAX_ROWS` rows
 * from `offset: 0` regardless of what the caller passed for `limit`/
 * `offset` — an export is "give me everything matching, up to the cap", not
 * one page of it.
 *
 * *** NO `ipAddress` COLUMN, SAME AS THE SEARCH VIEW. *** `audit.types.ts
 * #AuditLogView`'s header is the reasoning; the export renders exactly that
 * view, so there is exactly one place in this module that decides whether an
 * IP address ever reaches an admin, not two that could quietly drift apart.
 *
 * The export itself is audited (`action: 'export'`) — the same self-
 * referential entry `governance-export.service.ts` and `payment-admin
 * .service.ts`'s exports write for their own tables.
 */
@Injectable()
export class AuditExportService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly audit: AuditService,
  ) {}

  async exportCsv(filter: Omit<AuditLogFilter, 'limit' | 'offset'>, actingAdminId: string): Promise<AuditCsvExport> {
    const rows = await this.repo.listForAdmin({ ...filter, limit: AUDIT_EXPORT_MAX_ROWS, offset: 0 });
    const views = rows.map(toAuditLogView);

    const header = ['id', 'actor_type', 'actor_id', 'action', 'entity_type', 'entity_id', 'consultation_id', 'metadata', 'created_at'];
    const body = views.map((view) => [
      view.id,
      view.actorType,
      view.actorId,
      view.action,
      view.entityType,
      view.entityId,
      view.consultationId,
      view.metadata === null || view.metadata === undefined ? null : JSON.stringify(view.metadata),
      view.createdAt,
    ]);

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'export',
      entityType: AUDIT_AUDIT_ENTITY_TYPES.EXPORT,
      entityId: 'audit_log',
      metadata: {
        rowCount: body.length,
        truncated: body.length >= AUDIT_EXPORT_MAX_ROWS,
        filter: {
          actorType: filter.actorType ?? null,
          actorId: filter.actorId ?? null,
          entityType: filter.entityType ?? null,
          action: filter.action ?? null,
          from: filter.from?.toISOString() ?? null,
          to: filter.to?.toISOString() ?? null,
        },
      },
    });

    return {
      filename: `audit-log-${isoDate()}.csv`,
      content: toCsvDocument(header, body),
      rowCount: body.length,
    };
  }
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
