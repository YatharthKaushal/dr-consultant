import type { ClinicalAdvice, ClinicalMedicine } from '../clinical/clinical.contract';
import type { CheckinStatus, ConsultationStatus, FollowupStatus, SafetyAlertType } from '../../schema/enums.schema';
import type { RecommendedCareHubItem } from './followup-care-hub.contract';
import type { FollowupQuestion, RedFlagRule } from './followup-question.types';

/** One pathway version as any caller sees it — the admin editor's unit of work. */
export interface FollowupPathwayView {
  id: string;
  code: string;
  name: string;
  version: number;
  durationDays: number;
  questions: FollowupQuestion[];
  redFlagRules: RedFlagRule[];
  isCurrent: boolean;
  createdAt: Date;
}

/** One consultation's pinned follow-up assignment — the version + window it started with, immune to a later admin edit (FR-13.7). */
export interface FollowupAssignmentView {
  id: string;
  consultationId: string;
  pathwayId: string;
  pathwayCode: string;
  pathwayName: string;
  pathwayVersion: number;
  /** IST calendar date, `YYYY-MM-DD`. */
  startsOn: string;
  durationDays: number;
  status: FollowupStatus;
  createdAt: Date;
}

/** One day's check-in as any caller sees it. */
export interface CheckinResponseView {
  id: string;
  consultationId: string;
  checkinDate: string;
  answers: Record<string, string>;
  status: CheckinStatus;
  submittedAt: Date;
}

/** Result of a submission — the response plus what it triggered, so the client can show emergency guidance immediately (FR-13.4) without a second round trip. */
export interface SubmitCheckinResult {
  response: CheckinResponseView;
  alertRaised: SafetyAlertView | null;
}

export interface SafetyAlertView {
  id: string;
  alertType: SafetyAlertType;
  consultationId: string;
  checkinResponseId: string | null;
  reason: string | null;
  acknowledgedByAdminId: string | null;
  acknowledgedByDoctorId: string | null;
  acknowledgedAt: Date | null;
  closedAt: Date | null;
  closingNote: string | null;
  createdAt: Date;
}

/** FR-13.6: same doctor by default, earliest available doctor when urgent. See `followup.service.ts#recommendFollowUpBooking`'s header for what this module can and cannot do about actually creating the booking. */
export interface FollowUpBookingRecommendation {
  recommendedDoctorId: string | null;
  specialtyId: string;
  urgent: boolean;
  /** `false` only when urgent and no same-doctor continuity applies — the caller (app or coordinator-wired flow) must pick any available doctor for this specialty. Never a refusal to recommend at all. */
  sameDoctor: boolean;
}

/**
 * FR-14.1's Care Plan, composed live across every owning module. *** STORES
 * NOTHING OF ITS OWN. *** `docs/MODULES.md`: "Care Plan stores nothing of its
 * own; it reads through each owning module." Every field below is either this
 * module's own data (`checkins`, `followUp`) or a live read through another
 * module's facade (`prescription` via `ClinicalFacade`, `booking` via
 * `BookingFacade`, `recommendedSelfHelp` via `CARE_HUB_PORT`) — there is no
 * table backing this type.
 */
export interface CarePlanView {
  consultationId: string;
  /** `null` when the clinical record has no finalised version yet — an unfinished draft is not a prescription. */
  prescription: { medicines: ClinicalMedicine[]; advice: ClinicalAdvice; finalisedAt: Date } | null;
  checkins: CheckinResponseView[];
  followUp: FollowupAssignmentView | null;
  booking: { status: ConsultationStatus; scheduledStartAt: Date | null; doctorId: string | null } | null;
  recommendedFollowUpBooking: FollowUpBookingRecommendation | null;
  recommendedSelfHelp: RecommendedCareHubItem[];
}

/**
 * M-16's public surface (`backend/README.md` §2).
 *
 * `assignPathway` is the one method with no caller wired yet — see its own
 * doc comment for the seam (who calls it when a consult completes) and
 * `followup.service.ts#assignPathway`'s header for the full account.
 */
export interface FollowupContract {
  /**
   * *** THE M-15/COMPLETION -> M-16 SEAM. NO CALLER IS WIRED IN THIS
   * WORKTREE. *** Pins the CURRENT version of `pathwayCode` to `consultationId`
   * (FR-13.7: an in-flight assignment must not shift under a later admin
   * edit) and opens the check-in window.
   *
   * Whoever decides a consultation is complete and which pathway applies
   * calls this — most plausibly `clinical.service.ts#finalise`, alongside its
   * existing `completeConsultation`/`clearCompletionGate` calls, choosing
   * `pathwayCode` from the specialty/concern the same way it already chooses
   * whether prescribing is allowed. That call site does not exist yet: M-15
   * was built and merged before this module existed, so it has no knowledge
   * of `FollowupFacade`. THE COORDINATOR ADDS THE CALL post-merge — see this
   * module's build report for the exact assumption made here.
   *
   * Idempotent: a second call for a consultation that already has an
   * assignment returns the EXISTING one unchanged rather than erroring — the
   * caller may retry after a partial failure with no special handling.
   */
  assignPathway(input: { consultationId: string; pathwayCode: string; startsOn?: Date }): Promise<FollowupAssignmentView>;

  getAssignment(consultationId: string): Promise<FollowupAssignmentView | null>;

  /** FR-13.1 through FR-13.5: scores the answers against the pinned pathway version, persists the response, and raises a `safety_alerts` row + notifications on amber/red. Refuses a duplicate `(consultationId, checkinDate)` with a 409. */
  submitCheckin(input: {
    consultationId: string;
    /** Defaults to today, IST. A caller-supplied date exists for the sweep's own reconciliation path and for tests — never for the patient app, which always means "today". */
    checkinDate?: string;
    answers: Record<string, string>;
    actorPatientId: string;
  }): Promise<SubmitCheckinResult>;

  listCheckins(consultationId: string): Promise<CheckinResponseView[]>;

  listAlertsForConsultation(consultationId: string): Promise<SafetyAlertView[]>;

  /** FR-13.6. See `FollowUpBookingRecommendation`'s own doc comment for what this returns and does not attempt. */
  recommendFollowUpBooking(consultationId: string, urgent: boolean): Promise<FollowUpBookingRecommendation>;

  /** FR-14.1/FR-14.2. See `CarePlanView`'s header — reads through M-15/M-11/M-18, stores nothing. */
  getCarePlan(consultationId: string): Promise<CarePlanView>;

  /**
   * ADDITIVE (M-20/governance and quality): FR-18.5's "high-risk alerts" and
   * "follow-up alerts" working queues are ONE underlying feed —
   * `safety_alerts` rows with neither `acknowledgedAt` nor `closedAt` set,
   * newest first — split by `alertType` on the READING side, not by two
   * separate queries: `red_flag` reads as "high-risk alerts", the other four
   * types (`amber`, `missed_checkin`, `medication_side_effect`,
   * `followup_due`) read as "follow-up alerts". This exposes exactly what
   * `admin/safety-alerts` (`followup-alert-admin.controller.ts`) already
   * serves internally as `listOpenAlertsForAdmin`, through the facade so
   * governance can compose it without a deep import.
   */
  listOpenAlerts(limit: number, offset: number): Promise<SafetyAlertView[]>;

  /** ADDITIVE (M-20/governance and quality): the dashboard-number companion to `listOpenAlerts` — FR-18.6's "red flags"/"follow-up alerts" figures. See `followup.repository.ts#countOpenAlertsByType`. */
  countOpenAlertsByType(): Promise<Partial<Record<SafetyAlertType, number>>>;
}
