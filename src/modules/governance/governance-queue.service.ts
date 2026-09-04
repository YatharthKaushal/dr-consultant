import { Injectable } from '@nestjs/common';
import { ClinicalFacade } from '../clinical/clinical.facade';
import { FollowupFacade } from '../followup/followup.facade';
import { GovernanceEnrichmentService } from './governance-enrichment.service';
import type { PendingCaseSummaryQueueItem, SafetyAlertQueueItem } from './governance.types';

/**
 * FR-18.5's clinical-governance working queues: "pending case summaries,
 * high-risk alerts, follow-up alerts."
 *
 * *** THE FOURTH QUEUE FR-18.5 NAMES — THE CASE CLARIFICATION TRACKER — IS
 * DELIBERATELY NOT HERE. *** `clarification-admin.controller.ts`'s own
 * header already anticipated M-20 and says plainly: "these routes ARE that
 * tracker... these routes do not need to move for that to work." Duplicating
 * `GET /admin/clarification-cases` here would be exactly the "copy a row from
 * another module's table" mistake this module's build task warns against —
 * it is not even a table copy, it would be a whole SECOND admin surface for
 * the same live data. See this module's build report for the full account.
 *
 * Both queues below share one shape: a base list from the owning module's
 * facade, enriched with WHO/WHERE via `GovernanceEnrichmentService`. Neither
 * queue is a stored view — every call re-reads the owning module live.
 */
@Injectable()
export class GovernanceQueueService {
  constructor(
    private readonly clinical: ClinicalFacade,
    private readonly followup: FollowupFacade,
    private readonly enrichment: GovernanceEnrichmentService,
  ) {}

  /** `ClinicalFacade.listPendingCaseSummaries`, oldest-outstanding first, enriched. */
  async listPendingCaseSummaries(limit: number, offset: number): Promise<PendingCaseSummaryQueueItem[]> {
    const records = await this.clinical.listPendingCaseSummaries(limit, offset);
    const parties = await this.enrichment.resolveMany(records.map((record) => record.consultationId));

    return records.map((record) => ({
      consultationId: record.consultationId,
      riskCategory: record.riskCategory,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(parties.get(record.consultationId) ?? {
        doctorId: null,
        doctorName: null,
        patientId: null,
        patientName: null,
        consultationStatus: null,
      }),
    }));
  }

  /**
   * `FollowupFacade.listOpenAlerts` — ONE open-alert feed, enriched, with
   * `triage` derived per row so a caller can group "high-risk" (`red_flag`)
   * separately from "follow-up" (everything else) without a second query.
   */
  async listSafetyAlerts(limit: number, offset: number): Promise<SafetyAlertQueueItem[]> {
    const alerts = await this.followup.listOpenAlerts(limit, offset);
    const parties = await this.enrichment.resolveMany(alerts.map((alert) => alert.consultationId));

    return alerts.map((alert) => ({
      id: alert.id,
      alertType: alert.alertType,
      triage: alert.alertType === 'red_flag' ? ('high_risk' as const) : ('follow_up' as const),
      consultationId: alert.consultationId,
      reason: alert.reason,
      createdAt: alert.createdAt,
      ...(parties.get(alert.consultationId) ?? {
        doctorId: null,
        doctorName: null,
        patientId: null,
        patientName: null,
        consultationStatus: null,
      }),
    }));
  }
}
