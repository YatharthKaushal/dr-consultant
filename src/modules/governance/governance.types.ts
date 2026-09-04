import type { ComplaintStatus, ConsultationStatus, RiskCategory, SafetyAlertType } from '../../schema/enums.schema';

/**
 * A consultation's doctor/patient identity and live booking status, as
 * `GovernanceEnrichmentService#resolve` composes it — never stored here.
 * `docs/MODULES.md`'s M-20 "Data owned" line is short on purpose ("queue
 * views, quality metrics, escalation records"): this module reads the
 * consultation id every other queue item already carries and asks
 * `BookingFacade`/`DoctorFacade`/`PatientFacade` who it belongs to, live,
 * every time — the same rule `followup.service.ts#getCarePlan`'s header
 * states for the Care Plan ("stores nothing of its own; it reads through
 * each owning module").
 */
export interface GovernanceCaseParties {
  doctorId: string | null;
  doctorName: string | null;
  patientId: string | null;
  patientName: string | null;
  /** The consultation's CURRENT status, read live from `BookingFacade.getBooking` — not a snapshot. `null` only if the booking itself could not be found. */
  consultationStatus: ConsultationStatus | null;
}

/**
 * FR-18.5's "pending case summaries" working-queue row — one unfinalised
 * `clinical_records` draft (`ClinicalContract#listPendingCaseSummaries`),
 * enriched with WHO it belongs to and WHERE the underlying consultation
 * currently stands.
 */
export interface PendingCaseSummaryQueueItem extends GovernanceCaseParties {
  consultationId: string;
  riskCategory: RiskCategory;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * FR-18.5's "high-risk alerts" AND "follow-up alerts" working queues, which
 * are ONE feed split by `triage` — see `FollowupContract#listOpenAlerts`'s
 * doc comment for why these are not two separately-paginated lists.
 */
export interface SafetyAlertQueueItem extends GovernanceCaseParties {
  id: string;
  alertType: SafetyAlertType;
  /** `red_flag` -> `'high_risk'`; every other `SafetyAlertType` -> `'follow_up'`. The client groups on this field rather than re-deriving it from `alertType`. */
  triage: 'high_risk' | 'follow_up';
  consultationId: string;
  reason: string | null;
  createdAt: Date;
}

/**
 * FR-18.6's quality dashboard. Every field is a live composition across
 * another module's facade — see `GovernanceQualityService#getDashboard`'s
 * doc comment for exactly which facade/method backs each one; nothing here
 * is computed from money, and nothing here is stored.
 */
export interface QualityDashboardView {
  /** `BookingFacade.countByStatus()['completed']`. */
  completedCases: number;
  /** `ClinicalFacade.countPendingCaseSummaries()`. */
  pendingCaseSummaries: number;
  /** `FollowupFacade.countOpenAlertsByType()['red_flag']` — FR-18.6's "red flags", same signal as the working queue's "high-risk alerts". */
  redFlags: number;
  /** `FollowupFacade.countOpenAlertsByType()`, summed over every type OTHER than `red_flag`. */
  followUpAlerts: number;
  /** `GOVERNANCE_COMPLAINTS_PORT.countComplaintsByStatus()` — `0` for every status until M-19 merges. */
  complaintsByStatus: Record<ComplaintStatus, number>;
  generatedAt: Date;
}
