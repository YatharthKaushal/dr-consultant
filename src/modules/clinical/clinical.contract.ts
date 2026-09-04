import type { RiskCategory } from '../../schema/enums.schema';

/**
 * One medicine line. The shape `clinical_records.medicines` and
 * `doctor_clinical_templates.medicines` both store, and the shape
 * `specialties.prescription_template` seeds — three tables, one shape, stated
 * once here so a template can be copied into a record with no mapping layer
 * (`doctor-clinical-templates.schema.ts`: "a field-for-field copy").
 */
export interface ClinicalMedicine {
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  /** Optional free text — "after food", "taper over a week". */
  instructions?: string;
}

/** The four advice/therapy-plan fields, written by EVERY professional (FR-9.5, `docs/MODULES.md` M-15). */
export interface ClinicalAdvice {
  /** What was covered this session. */
  covered: string | null;
  /** Home practice for the patient. */
  homePractice: string | null;
  /** Focus for the next session. */
  nextFocus: string | null;
  /** Surfaced on the patient Care Plan (FR-14.1) and read by M-16 through this contract. */
  warningSigns: string | null;
}

/**
 * A whole `clinical_records` row as any caller outside this module sees it.
 *
 * *** THERE IS NO CLINICAL-DOUBT FLAG, AND THAT IS DELIBERATE. ***
 * `clinical-records.schema.ts` settles it: "There is no `has_clinical_doubt`
 * flag — a doubt IS a `clarification_cases` row with `source_consultation_id`
 * set." That row is M-17's to write, so FR-11.4's "optional clinical doubt
 * flag" is served by the existence of a clarification case, not by a boolean
 * here. Adding one would be a second, drifting source of truth for the same
 * fact.
 *
 * There is no `recommendedContentIds` either — doctor-recommended Care Hub
 * items are `content_recommendations` rows, owned by M-18.
 */
export interface ClinicalRecordView {
  id: string;
  consultationId: string;
  chiefComplaint: string;
  clinicalHistory: string | null;
  diagnosis: string | null;
  isDiagnosisProvisional: boolean;
  riskCategory: RiskCategory;
  /** Set = an in-person or emergency referral was advised, and this is it. There is no separate `referralAdvised` boolean. */
  referralNote: string | null;
  medicines: ClinicalMedicine[];
  advice: ClinicalAdvice;
  /** 3-5 lines (FR-11.3). Required before finalising. */
  caseSummary: string | null;
  /** *** THE COMPLETION GATE. *** `null` = still a draft. */
  finalisedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The narrow projection M-16 (Follow-Up and Patient Safety) composes its Care
 * Plan from — FR-14.1's "prescription and warning signs from M-15".
 *
 * Deliberately NOT `ClinicalRecordView`. The Care Plan renders the medicines,
 * the warning signs and the plan for the patient; it never renders the
 * diagnosis, the clinical history or the case summary, and `docs/MODULES.md`
 * is explicit that the Care Plan "stores nothing of its own; it reads through
 * each owning module". A projection that carried the diagnosis would make it
 * one deploy away from displaying it.
 *
 * `null` until the record is finalised: an unfinished draft is not a care plan,
 * and half-written warning signs are worse than none.
 */
export interface ClinicalCarePlanView {
  consultationId: string;
  medicines: ClinicalMedicine[];
  advice: ClinicalAdvice;
  finalisedAt: Date;
}

/**
 * One `audit_log` row for a consultation, as the FR-11.6 trail exposes it.
 * Deliberately no `ipAddress` — the trail answers "what happened to this case",
 * not "from where", and an operator reading clinical governance has no
 * minimum-necessary claim on an actor's network address (SRS §6.2).
 */
export interface ClinicalAuditEntryView {
  /** `audit_log.id` is a `bigserial`, not a uuid. */
  id: number;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

/**
 * M-15's public surface (`backend/README.md` §2).
 *
 * Shaped around the consumers that are NAMED as depending on this module and
 * nothing more — the same restraint `catalogue.contract.ts`,
 * `document.contract.ts` and `instant.contract.ts` apply.
 *
 *   M-16 (Follow-Up)      `getCarePlanInputs`. FR-14.1's Care Plan composes
 *                         the prescription and the warning signs from here,
 *                         copying nothing.
 *
 *   M-17 (Clarification)  `getRecordByConsultationId`. A treating doctor
 *                         raising a de-identified case starts from the record
 *                         they wrote. *** M-17 IS RESPONSIBLE FOR STRIPPING
 *                         IDENTIFIERS *** — this view is the full clinical
 *                         record and carries no de-identification of its own.
 *
 * WHAT IS DELIBERATELY ABSENT: every WRITE. Creating, editing and finalising a
 * clinical record are the treating doctor's acts, reached through this module's
 * own controllers; no other module may finalise a consultation on a doctor's
 * behalf, because finalising is what asserts the clinical work was done.
 *
 * Neither method applies an ownership check — trusted module-to-module reads,
 * the CALLER authorizes, the same rule `BookingContract.findById` and
 * `DocumentContract.getPatientFileById` both state.
 */
export interface ClinicalContract {
  /** The whole record for one consultation, or `null` if none has been started. Includes drafts — `finalisedAt` tells them apart. */
  getRecordByConsultationId(consultationId: string): Promise<ClinicalRecordView | null>;

  /** The Care Plan projection, or `null` when there is no record or it is not finalised yet. */
  getCarePlanInputs(consultationId: string): Promise<ClinicalCarePlanView | null>;

  /**
   * ADDITIVE (M-20/governance and quality): FR-18.5's "pending case
   * summaries" working queue — every DRAFT clinical record
   * (`finalisedAt: null`), oldest first, so the longest-outstanding
   * documentation surfaces first. Includes drafts, whatever the underlying
   * consultation's status; this module has no opinion on booking status.
   * Governance enriches each item with `BookingFacade.getBooking` for the
   * doctor/patient identity this table does not carry.
   */
  listPendingCaseSummaries(limit: number, offset: number): Promise<ClinicalRecordView[]>;

  /** ADDITIVE (M-20/governance and quality): the dashboard-number companion to `listPendingCaseSummaries` — FR-18.6's "pending summaries" figure. Same predicate, no page. */
  countPendingCaseSummaries(): Promise<number>;
}

/**
 * *** THE M-15 -> M-16 SEAM. *** Emitted once, from `ClinicalService#finalise`,
 * as the fourth of finalising's cross-module consequences (after moving the
 * consultation to `completed`, clearing the completion gate, and generating
 * the PDF). `followup`'s listener (`followup-clinical.listener.ts`) resolves
 * a `pathwayCode` from `concernId` and calls `FollowupFacade.assignPathway`.
 *
 * An event rather than a direct call for the same reason
 * `booking-payment.listener.ts` gives for `PAYMENT_CAPTURED_EVENT`: `followup`
 * already depends on `ClinicalFacade` (to read the prescription and warning
 * signs for the Care Plan), so a direct `clinical -> followup` call would
 * close a module cycle. `EventsModule` is `@Global()`, so no import is needed
 * to listen.
 *
 * *** FIRE-AND-FORGET, WITH NO RECONCILING SWEEP BEHIND IT. *** Unlike
 * `PAYMENT_CAPTURED_EVENT` (backed by `booking-slot-hold.service.ts`'s
 * two-tier sweep) or the completion gate (idempotent and re-triggerable), a
 * dropped or failing delivery of this event today means that consultation's
 * pathway is simply never assigned — nothing retries it. Acceptable for this
 * round because `assignPathway` itself remains directly callable (an admin or
 * a future retry path can call `FollowupFacade.assignPathway` by hand), but
 * this is a real gap, not a designed degradation, and should be closed before
 * this is relied on in production.
 */
export const CLINICAL_RECORD_FINALISED_EVENT = 'clinical.record_finalised';

/**
 * Payload of {@link CLINICAL_RECORD_FINALISED_EVENT}. JSON-safe, like every
 * value on this surface. Deliberately just the id: `ClinicalConsultationView`
 * (what `finalise` actually has in hand) carries `specialtyId` but not
 * `concernId` — widening that port's shape for one event felt like the wrong
 * cost, since the listener already has a direct `BookingFacade` dependency
 * and can read the full `BookingView` (specialty AND concern) itself.
 */
export interface ClinicalRecordFinalisedEvent {
  consultationId: string;
}
