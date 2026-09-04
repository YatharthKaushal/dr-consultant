import { Inject, Injectable, Logger } from '@nestjs/common';
import { COMPLAINT_STATUSES, SAFETY_ALERT_TYPES, type ComplaintStatus } from '../../schema/enums.schema';
import { BookingFacade } from '../booking/booking.facade';
import { ClinicalFacade } from '../clinical/clinical.facade';
import type { DoctorReliabilityMetrics } from '../doctor/doctor.contract';
import { DoctorFacade } from '../doctor/doctor.facade';
import { FollowupFacade } from '../followup/followup.facade';
import { GOVERNANCE_COMPLAINTS_PORT, type GovernanceComplaintsPort } from './governance-complaints.contract';
import type { QualityDashboardView } from './governance.types';

/**
 * FR-18.6's quality dashboard: "completed cases, pending summaries, red
 * flags, follow-up alerts, complaints, and doctor reliability metrics."
 *
 * *** NO MONEY ARITHMETIC HAPPENS HERE, AND NONE EVER SHOULD. *** Every
 * number below is a COUNT, never a sum of a `numeric` column — this module's
 * build task is explicit that a monetary total belongs to `payment`/
 * `pricing`, never re-derived a second place. If a future dashboard number
 * needs a monetary figure, it must come from `PaymentFacade`/`PricingFacade`
 * as a value already computed there, not a `sum(amount)` written here.
 */
@Injectable()
export class GovernanceQualityService {
  private readonly logger = new Logger(GovernanceQualityService.name);

  constructor(
    private readonly booking: BookingFacade,
    private readonly clinical: ClinicalFacade,
    private readonly followup: FollowupFacade,
    private readonly doctor: DoctorFacade,
    @Inject(GOVERNANCE_COMPLAINTS_PORT) private readonly complaints: GovernanceComplaintsPort,
  ) {}

  /**
   * One dashboard read, five independent composed queries run concurrently.
   * Source of each field:
   *   completedCases       `BookingFacade.countByStatus()['completed']`
   *   pendingCaseSummaries `ClinicalFacade.countPendingCaseSummaries()`
   *   redFlags             `FollowupFacade.countOpenAlertsByType()['red_flag']`
   *   followUpAlerts       the same call, summed over every OTHER `SafetyAlertType`
   *   complaintsByStatus   `GOVERNANCE_COMPLAINTS_PORT.countComplaintsByStatus()`
   */
  async getDashboard(): Promise<QualityDashboardView> {
    const [statusCounts, pendingCaseSummaries, alertCounts, complaintsByStatus] = await Promise.all([
      this.booking.countByStatus(),
      this.clinical.countPendingCaseSummaries(),
      this.followup.countOpenAlertsByType(),
      this.safeCountComplaints(),
    ]);

    const redFlags = alertCounts.red_flag ?? 0;
    const followUpAlerts = SAFETY_ALERT_TYPES.filter((type) => type !== 'red_flag').reduce(
      (sum, type) => sum + (alertCounts[type] ?? 0),
      0,
    );

    return {
      completedCases: statusCounts.completed ?? 0,
      pendingCaseSummaries,
      redFlags,
      followUpAlerts,
      complaintsByStatus,
      generatedAt: new Date(),
    };
  }

  /**
   * FR-18.6's per-doctor reliability drill-down — a thin pass-through to
   * `DoctorFacade.getReliabilityMetrics`, which is itself a thin pass-through
   * to the exact computation `admin/doctors/:id/reliability` already served
   * before this module existed. Throws the same `doctorNotFound` a bad id
   * throws there.
   */
  async getDoctorReliability(doctorId: string): Promise<DoctorReliabilityMetrics> {
    return this.doctor.getReliabilityMetrics(doctorId);
  }

  /**
   * Wrapped even though `GovernanceComplaintsPort`'s own contract promises
   * never to throw — the same "a port is a promise, not a guarantee" defence
   * `followup.service.ts#safeCareHubFetch` and `instant.service.ts#notify`
   * both apply, because the four other numbers on this dashboard must render
   * even if the eventual M-19 facade misbehaves.
   */
  private async safeCountComplaints(): Promise<Record<ComplaintStatus, number>> {
    try {
      return await this.complaints.countComplaintsByStatus();
    } catch (error) {
      this.logger.warn(`Complaints port threw; reporting zero complaints. ${describeError(error)}`);
      return Object.fromEntries(COMPLAINT_STATUSES.map((status) => [status, 0])) as Record<ComplaintStatus, number>;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
