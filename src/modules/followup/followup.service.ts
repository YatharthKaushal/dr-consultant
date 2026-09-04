import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookingFacade } from '../booking/booking.facade';
import { ClinicalFacade } from '../clinical/clinical.facade';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AuditService } from '../../shared/audit/audit.service';
import type { CareHubPort } from './followup-care-hub.contract';
import { addDaysToIsoDate, isoDateLessThan, todayIstDate } from './followup-ist.util';
import type { FollowupAnswers, FollowupQuestion, RedFlagRule } from './followup-question.types';
import { validateAnswers, scoreCheckin } from './followup-scoring.util';
import { FollowupAlertService } from './followup-alert.service';
import { FollowupPathwayService } from './followup-pathway.service';
import { CARE_HUB_PORT, FOLLOWUP_AUDIT_ENTITY_TYPES, FOLLOWUP_ERROR_CODES } from './followup.constants';
import type {
  CarePlanView,
  CheckinResponseView,
  FollowUpBookingRecommendation,
  FollowupAssignmentView,
  SubmitCheckinResult,
} from './followup.contract';
import { toAssignmentView, toCheckinResponseView } from './followup.mapper';
import { FollowupRepository } from './followup.repository';

/**
 * M-16's core rules: pathway assignment (FR-13.7's pinning), daily check-in
 * scoring (FR-13.1-13.5), FR-13.6's booking recommendation, and the Care Plan
 * composition (FR-14.1). `backend/README.md` §2: "services hold the rules."
 *
 * `BookingFacade` and `ClinicalFacade` are injected DIRECTLY, not through a
 * local port — both modules are already merged in this worktree, the same
 * reasoning `clinical.module.ts` gives for consuming `BookingFacade`
 * directly rather than through `CLINICAL_BOOKING_PORT`. Only genuinely
 * not-yet-existing or not-yet-reachable dependencies get a port here:
 * `CARE_HUB_PORT` (M-18 does not exist) and `ADMIN_DIRECTORY_PORT`/
 * `FOLLOWUP_NOTIFICATION_PORT` (in `followup-alert.service.ts`).
 */
@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);

  constructor(
    private readonly repo: FollowupRepository,
    private readonly pathways: FollowupPathwayService,
    private readonly alerts: FollowupAlertService,
    private readonly audit: AuditService,
    private readonly booking: BookingFacade,
    private readonly clinical: ClinicalFacade,
    @Inject(CARE_HUB_PORT) private readonly careHub: CareHubPort,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Pathway assignment (FR-13.7's pinning)                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * *** THE M-15/COMPLETION -> M-16 SEAM. WIRED POST-MERGE: see
   * `followup-clinical.listener.ts`, `@OnEvent(CLINICAL_RECORD_FINALISED_EVENT)`.
   * The rest of this comment is this worktree's original account of the gap,
   * kept because the reasoning it gives still explains why this method takes
   * a pre-resolved `pathwayCode` rather than doing that resolution itself. ***
   *
   * `docs/MODULES.md` M-16: "When a consultation completes... a pathway is
   * assigned." M-15's `ClinicalService#finalise` is the natural caller — it
   * already runs `BookingFacade.completeConsultation` and
   * `InstantFacade.clearCompletionGate` as its two cross-module consequences
   * of finalising, and this would be a third. M-15 was built and merged
   * BEFORE this module existed, so `clinical.service.ts` has no knowledge of
   * `FollowupFacade` or `pathwayCode` selection, and this worktree's
   * guardrails leave `src/modules/clinical/*` untouched.
   *
   * *** THE ASSUMPTION THIS WORKTREE MAKES, STATED SO IT CAN BE RECONCILED:
   * *** the caller resolves `pathwayCode` from the specialty (or, later, the
   * doctor's own choice at finalisation) BEFORE calling this — this method
   * does no clinical judgment of its own, matching `docs/MODULES.md` §7's
   * "modules provide the tools, not the wording."
   *
   * *** WHAT THIS DOES NOT DO, AND WHY: *** it does not write
   * `consultations.followup_pathway_id`/`followup_starts_on`/
   * `followup_status`. Those columns exist for exactly this
   * (`consultations.schema.ts`'s own comments), but they are BOOKING's
   * (`booking.mapper.ts`: "belong to M-16... this module has no business
   * publishing them") and reaching them needs an ADDITIVE `BookingContract`
   * method — the same seam `clinical-booking.contract.ts` documents for
   * `completeConsultation` — which is out of scope for this worktree
   * (`src/modules/booking/*` is untouched). This module tracks its OWN pin in
   * `followup_assignments` (see that schema file's header for the full
   * argument) and is fully correct standing alone; the coordinator MAY choose
   * to also mirror the pin onto `consultations` by growing `BookingContract`,
   * but nothing in this module depends on that happening.
   *
   * Idempotent: a second call for an already-assigned consultation returns
   * the EXISTING assignment, pathway and all, rather than erroring or
   * re-pinning — a caller retrying after a partial failure needs no special
   * handling, and a consultation is never silently re-pinned to a newer
   * `pathwayCode` by a repeated call.
   */
  async assignPathway(input: { consultationId: string; pathwayCode: string; startsOn?: Date }): Promise<FollowupAssignmentView> {
    const existing = await this.repo.findAssignmentByConsultationId(input.consultationId);
    if (existing) {
      const pathway = await this.pathways.getByIdOrThrow(existing.pathwayId);
      return toAssignmentView(existing, pathway);
    }

    const booking = await this.booking.getBooking(input.consultationId);
    if (!booking) throw this.consultationNotFound();

    const pathway = await this.pathways.getCurrentByCodeOrThrow(input.pathwayCode);
    const startsOn = todayIstDate(input.startsOn ?? new Date());

    try {
      const row = await this.repo.insertAssignment({
        consultationId: input.consultationId,
        pathwayId: pathway.id,
        startsOn,
        status: 'active',
      });

      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.FOLLOWUP_ASSIGNMENT,
        entityId: row.id,
        consultationId: input.consultationId,
        metadata: { pathwayCode: pathway.code, pathwayVersion: pathway.version, startsOn },
      });

      return toAssignmentView(row, pathway);
    } catch (error) {
      // Two concurrent callers both reading "no assignment yet" before either
      // inserts — the unique index on `consultation_id` is the authoritative
      // guard, and the loser reads back what the winner wrote.
      if (isUniqueConstraintViolation(error)) {
        const race = await this.repo.findAssignmentByConsultationId(input.consultationId);
        if (race) {
          const racePathway = await this.pathways.getByIdOrThrow(race.pathwayId);
          return toAssignmentView(race, racePathway);
        }
      }
      throw error;
    }
  }

  async getAssignment(consultationId: string): Promise<FollowupAssignmentView | null> {
    const row = await this.repo.findAssignmentByConsultationId(consultationId);
    if (!row) return null;
    const pathway = await this.pathways.getByIdOrThrow(row.pathwayId);
    return toAssignmentView(row, pathway);
  }

  /* ---------------------------------------------------------------------- */
  /* Daily check-in (FR-13.1 - FR-13.5)                                      */
  /* ---------------------------------------------------------------------- */

  async submitCheckin(input: {
    consultationId: string;
    checkinDate?: string;
    answers: unknown;
    actorPatientId: string;
  }): Promise<SubmitCheckinResult> {
    const assignment = await this.repo.findAssignmentByConsultationId(input.consultationId);
    if (!assignment) throw this.assignmentNotFound();
    if (assignment.status !== 'active') throw this.checkinOutsideWindow();

    const booking = await this.assertPatientOwnsConsultation(input.consultationId, input.actorPatientId);

    const pathway = await this.pathways.getByIdOrThrow(assignment.pathwayId);
    const questions = pathway.questions as FollowupQuestion[];
    const redFlagRules = pathway.redFlagRules as RedFlagRule[];

    const checkinDate = input.checkinDate ?? todayIstDate();
    const windowEnd = addDaysToIsoDate(assignment.startsOn, pathway.durationDays);
    if (isoDateLessThan(checkinDate, assignment.startsOn) || !isoDateLessThan(checkinDate, windowEnd)) {
      throw this.checkinOutsideWindow();
    }

    const answers: FollowupAnswers = validateAnswers(input.answers, questions);
    const { status, firedRules } = scoreCheckin(questions, redFlagRules, answers);

    let response;
    try {
      response = await this.repo.insertCheckin({
        consultationId: input.consultationId,
        checkinDate,
        answers,
        status,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw this.checkinAlreadySubmitted();
      throw error;
    }

    await this.audit.write({
      actorType: 'patient',
      actorId: input.actorPatientId,
      action: 'create',
      entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.CHECKIN_RESPONSE,
      entityId: response.id,
      consultationId: input.consultationId,
      metadata: { checkinDate, status },
    });

    const view: CheckinResponseView = toCheckinResponseView(response);

    if (status === 'green') return { response: view, alertRaised: null };

    // FR-13.4: red shows emergency guidance and alerts immediately; FR-13.3:
    // amber prompts a follow-up booking or doctor review. Both are
    // `safety_alerts` rows — `red_flag`/`amber` respectively — the type this
    // check-in produces.
    const reason =
      firedRules[0]?.reason ?? (status === 'red' ? 'A red-flag answer was reported in a check-in.' : 'A worsening answer was reported in a check-in.');

    const alertRaised = await this.alerts.raiseAlert({
      alertType: status === 'red' ? 'red_flag' : 'amber',
      consultationId: input.consultationId,
      checkinResponseId: response.id,
      reason,
      doctorId: booking.doctorId,
    });

    return { response: view, alertRaised };
  }

  async listCheckins(consultationId: string): Promise<CheckinResponseView[]> {
    const rows = await this.repo.listCheckinsForConsultation(consultationId);
    return rows.map(toCheckinResponseView);
  }

  /* ---------------------------------------------------------------------- */
  /* Safety alerts — thin delegation to `FollowupAlertService`               */
  /* ---------------------------------------------------------------------- */

  async listAlertsForConsultation(consultationId: string) {
    return this.alerts.listAlertsForConsultation(consultationId);
  }

  /* ---------------------------------------------------------------------- */
  /* Follow-up booking (FR-13.6)                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * *** WHAT THIS RETURNS, AND — LOUDLY — WHAT IT DOES NOT DO. ***
   *
   * FR-13.6: "continue with the same doctor, or book the earliest available
   * doctor when review is urgent." This method resolves WHICH doctor/
   * specialty a follow-up should target; it does NOT create a new booking.
   *
   * Two real gaps, both because `BookingContract` (M-11, already merged, out
   * of scope for this worktree to extend) exposes no method to create a
   * booking linked via `followup_of_consultation_id`, and no facade this
   * module can reach resolves "earliest available doctor for this specialty"
   * (that is `availability`/`search`'s domain, also out of scope here):
   *
   *   1. `recommendedDoctorId` is always the ORIGINAL treating doctor. When
   *      `urgent` is true, `sameDoctor: false` tells the caller that doctor
   *      is a fallback, not a resolved "earliest available" answer — the
   *      caller must still search for one.
   *   2. Nothing here calls a booking-creation endpoint. The caller (the
   *      patient app, hitting the ORDINARY booking-creation flow with this
   *      recommendation) or the coordinator (adding a `createFollowUpBooking`
   *      sibling to `BookingContract`, mirroring `createBooking` but
   *      accepting a `followupOfConsultationId`) closes the loop.
   */
  async recommendFollowUpBooking(consultationId: string, urgent: boolean): Promise<FollowUpBookingRecommendation> {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking) throw this.consultationNotFound();

    return {
      recommendedDoctorId: booking.doctorId,
      specialtyId: booking.specialtyId,
      urgent,
      sameDoctor: !urgent,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Care Plan composition (FR-14.1/FR-14.2) — STORES NOTHING OF ITS OWN.    */
  /* ---------------------------------------------------------------------- */

  async getCarePlan(consultationId: string): Promise<CarePlanView> {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking) throw this.consultationNotFound();

    const [clinicalCarePlan, checkinRows, assignmentRow, recommendedSelfHelp] = await Promise.all([
      this.clinical.getCarePlanInputs(consultationId),
      this.repo.listCheckinsForConsultation(consultationId),
      this.repo.findAssignmentByConsultationId(consultationId),
      this.safeCareHubFetch(consultationId),
    ]);

    let followUp: FollowupAssignmentView | null = null;
    if (assignmentRow) {
      const pathway = await this.pathways.getByIdOrThrow(assignmentRow.pathwayId);
      followUp = toAssignmentView(assignmentRow, pathway);
    }

    const recommendedFollowUpBooking = followUp ? await this.recommendFollowUpBooking(consultationId, false) : null;

    return {
      consultationId,
      prescription: clinicalCarePlan
        ? { medicines: clinicalCarePlan.medicines, advice: clinicalCarePlan.advice, finalisedAt: clinicalCarePlan.finalisedAt }
        : null,
      checkins: checkinRows.map(toCheckinResponseView),
      followUp,
      booking: { status: booking.status, scheduledStartAt: booking.scheduledStartAt, doctorId: booking.doctorId },
      recommendedFollowUpBooking,
      recommendedSelfHelp,
    };
  }

  /** `CARE_HUB_PORT`'s own contract says never throws; wrapped anyway for the same "a port is a promise, not a guarantee" reason `followup-alert.service.ts#notify` is. */
  private async safeCareHubFetch(consultationId: string) {
    try {
      return await this.careHub.getRecommendedForConsultation(consultationId);
    } catch (error) {
      this.logger.warn(`Care Hub lookup failed for ${consultationId}; recommending nothing. ${describeError(error)}`);
      return [];
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Patient-owned reads — the ownership check `followup.controller.ts`      */
  /* delegates to, the same convention `clinical.controller.ts`'s header     */
  /* states for `ClinicalService#getOwnRecord`.                              */
  /* ---------------------------------------------------------------------- */

  async getCarePlanForPatient(consultationId: string, patientId: string): Promise<CarePlanView> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);
    return this.getCarePlan(consultationId);
  }

  async getAssignmentForPatient(consultationId: string, patientId: string): Promise<FollowupAssignmentView | null> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);
    return this.getAssignment(consultationId);
  }

  async listCheckinsForPatient(consultationId: string, patientId: string): Promise<CheckinResponseView[]> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);
    return this.listCheckins(consultationId);
  }

  async recommendFollowUpBookingForPatient(consultationId: string, patientId: string, urgent: boolean): Promise<FollowUpBookingRecommendation> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);
    return this.recommendFollowUpBooking(consultationId, urgent);
  }

  /** Same 404 a stranger gets when the consultation is not theirs, so a patient cannot probe for another patient's consultation — the convention `clinical.controller.ts`'s header states for the same reason. Returns the booking so a caller that also needs it (`submitCheckin`) does not re-fetch. */
  private async assertPatientOwnsConsultation(consultationId: string, patientId: string) {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking || booking.patientId !== patientId) throw this.consultationNotFound();
    return booking;
  }

  /* ---------------------------------------------------------------------- */

  private consultationNotFound(): NotFoundException {
    return new NotFoundException({ code: FOLLOWUP_ERROR_CODES.CONSULTATION_NOT_FOUND, message: 'Consultation not found.' });
  }

  private assignmentNotFound(): NotFoundException {
    return new NotFoundException({
      code: FOLLOWUP_ERROR_CODES.ASSIGNMENT_NOT_FOUND,
      message: 'No follow-up pathway has been assigned to this consultation yet.',
    });
  }

  private checkinOutsideWindow(): ForbiddenException {
    return new ForbiddenException({
      code: FOLLOWUP_ERROR_CODES.CHECKIN_OUTSIDE_WINDOW,
      message: 'This date is outside the active follow-up window.',
    });
  }

  private checkinAlreadySubmitted(): ConflictException {
    return new ConflictException({
      code: FOLLOWUP_ERROR_CODES.CHECKIN_ALREADY_SUBMITTED,
      message: 'A check-in has already been submitted for this date.',
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
