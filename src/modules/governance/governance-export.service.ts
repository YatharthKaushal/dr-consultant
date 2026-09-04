import { Injectable } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { toCsvDocument } from './governance-csv.util';
import { GOVERNANCE_AUDIT_ENTITY_TYPES, GOVERNANCE_EXPORT_MAX_ROWS } from './governance.constants';
import { GovernanceQueueService } from './governance-queue.service';

/** What every export method returns — mirrors `payment-admin.service.ts#exportPaymentsCsv`'s return shape exactly, so `governance-admin.controller.ts`'s `sendCsv` helper is the same one-liner. */
export interface GovernanceCsvExport {
  filename: string;
  content: string;
  rowCount: number;
}

/**
 * CSV export for governance's two working queues (`governance.export`,
 * FR-18.5/FR-18.6, SRS 6.7). Row-capped rather than streamed — see
 * `governance.constants.ts#GOVERNANCE_EXPORT_MAX_ROWS`'s own comment, the
 * same honesty `payment.constants.ts#PAYMENT_EXPORT_MAX_ROWS` states.
 *
 * Each export re-runs the SAME composed queue read the screen uses
 * (`GovernanceQueueService`), just with `limit: GOVERNANCE_EXPORT_MAX_ROWS,
 * offset: 0` — one query, not a page-by-page loop, so there is exactly one
 * enrichment pass and one audit entry per export.
 */
@Injectable()
export class GovernanceExportService {
  constructor(
    private readonly queues: GovernanceQueueService,
    private readonly audit: AuditService,
  ) {}

  async exportPendingCaseSummariesCsv(actingAdminId: string): Promise<GovernanceCsvExport> {
    const items = await this.queues.listPendingCaseSummaries(GOVERNANCE_EXPORT_MAX_ROWS, 0);

    const header = [
      'consultation_id',
      'risk_category',
      'consultation_status',
      'doctor_id',
      'doctor_name',
      'patient_id',
      'patient_name',
      'created_at',
      'updated_at',
    ];
    const body = items.map((item) => [
      item.consultationId,
      item.riskCategory,
      item.consultationStatus,
      item.doctorId,
      item.doctorName,
      item.patientId,
      item.patientName,
      item.createdAt,
      item.updatedAt,
    ]);

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'export',
      entityType: GOVERNANCE_AUDIT_ENTITY_TYPES.PENDING_CASE_SUMMARIES_EXPORT,
      entityId: 'pending_case_summaries',
      metadata: { rowCount: body.length, truncated: body.length >= GOVERNANCE_EXPORT_MAX_ROWS },
    });

    return {
      filename: `governance-pending-case-summaries-${isoDate()}.csv`,
      content: toCsvDocument(header, body),
      rowCount: body.length,
    };
  }

  async exportSafetyAlertsCsv(actingAdminId: string): Promise<GovernanceCsvExport> {
    const items = await this.queues.listSafetyAlerts(GOVERNANCE_EXPORT_MAX_ROWS, 0);

    const header = [
      'alert_id',
      'alert_type',
      'triage',
      'consultation_id',
      'consultation_status',
      'reason',
      'doctor_id',
      'doctor_name',
      'patient_id',
      'patient_name',
      'created_at',
    ];
    const body = items.map((item) => [
      item.id,
      item.alertType,
      item.triage,
      item.consultationId,
      item.consultationStatus,
      item.reason,
      item.doctorId,
      item.doctorName,
      item.patientId,
      item.patientName,
      item.createdAt,
    ]);

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'export',
      entityType: GOVERNANCE_AUDIT_ENTITY_TYPES.SAFETY_ALERTS_EXPORT,
      entityId: 'safety_alerts',
      metadata: { rowCount: body.length, truncated: body.length >= GOVERNANCE_EXPORT_MAX_ROWS },
    });

    return {
      filename: `governance-safety-alerts-${isoDate()}.csv`,
      content: toCsvDocument(header, body),
      rowCount: body.length,
    };
  }
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
