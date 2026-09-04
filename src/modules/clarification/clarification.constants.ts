import type { ClarificationStatus } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* De-identification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * *** READ THIS BEFORE TOUCHING ANYTHING ELSE IN THIS MODULE. ***
 *
 * `clarification-cases.schema.ts` states two independent checks: WHO may be
 * asked (`seniority_level = expert`) and WHAT they may see
 * (`expert_doctor_id`). This constant is about a THIRD, separate concern —
 * what the case is ALLOWED TO CONTAIN in the first place — and it is the one
 * this module can only partly guarantee.
 *
 * `clarification_cases` has no `patient_name`, `patient_phone`,
 * `patient_address` or `patient_email` column, and `CreateClarificationCaseDto`
 * has no such field either (`whitelist: true` on the global `ValidationPipe`
 * strips anything else the client sends). That half is a STRUCTURAL guarantee:
 * there is no column and no field for a direct identifier to occupy, so no
 * runtime stripping is needed to make it true.
 *
 * The other half is NOT structural, and this module does not pretend it is.
 * `briefHistory`, `diagnosis`, `currentPlan` and `specificDoubt` are free
 * text, typed by the treating doctor. Nothing parses them, and nothing
 * redacts them — "patient's mother Sunita called from Andheri" inside
 * `briefHistory` reaches the expert exactly as written, because there is no
 * field-level rule that could catch it. Claiming otherwise would be a false
 * guarantee, so this module states the limitation instead: the system
 * guarantees only that no direct-identifier COLUMN exists to carry PII
 * through; keeping a name, place or phone number out of the free text the
 * treating doctor types is the treating doctor's responsibility, every time,
 * and the warning below is shown before every post specifically because nothing
 * downstream of it will catch what it misses.
 */
export const DEIDENTIFICATION_NOTICE =
  'Before you post: this case carries only the fields below — there is no name, phone number, address or ' +
  'email column here for one to leak through. But the free-text fields (brief history, diagnosis, current ' +
  'plan, the specific doubt) are exactly what you type, and nothing in this system reads, checks or redacts ' +
  'them. Re-read every free-text field yourself and remove anything that could identify the patient — a ' +
  'name, a relative’s name, a place, a phone number, or a detail specific enough to work like one. The ' +
  'system cannot verify this for you; de-identifying the free text you write is your responsibility.';

/* -------------------------------------------------------------------------- */
/* Field limits                                                               */
/* -------------------------------------------------------------------------- */

export const CLARIFICATION_FIELD_LIMITS = {
  TITLE: 200,
  BRIEF_HISTORY: 8000,
  DIAGNOSIS: 4000,
  CURRENT_PLAN: 4000,
  SPECIFIC_DOUBT: 4000,
  MESSAGE_BODY: 4000,
  MIN_PATIENT_AGE: 0,
  /** `smallint` column; this is a sanity ceiling, not a clinical one. */
  MAX_PATIENT_AGE: 130,
} as const;

/** Cap on the length of one case's `messages` array — a runaway thread is a data-quality problem, not a use case. */
export const CLARIFICATION_MAX_MESSAGES = 200;

/* -------------------------------------------------------------------------- */
/* The status state machine                                                   */
/* -------------------------------------------------------------------------- */

/**
 * *** THE WHOLE STATE MACHINE, IN ONE PLACE. *** Copies the shape
 * `LEGAL_VIDEO_STATUS_TRANSITIONS` (`src/modules/video/video.constants.ts`)
 * and `booking.service.ts#transitionConsultationStatus`'s `to`/`from` pair
 * use: read each entry as "a case may ENTER <key> from any of <value>", so a
 * caller writes `CLARIFICATION_STATUS_TRANSITIONS[target]` and the repository
 * enforces it as a guarded `UPDATE ... WHERE id = ? AND status IN (from)`
 * under the row lock, rather than any call site hand-rolling a subtly
 * different legal set.
 *
 * Unlike M-14's table, this module owns its own status column outright —
 * there is no cross-module row lock to coordinate, so every transition is a
 * single-repository write inside this module's own transaction.
 *
 * *** IT IS DELIBERATELY TURN-BASED, WITH NO SELF-LOOP. *** At any moment
 * exactly one side may act on a case, and acting always moves the status —
 * there is no "add another message, status unchanged" path. That is a
 * simplification FR-12.6's status list does not spell out, made explicit here
 * rather than left implicit in code: a status that can both change and not
 * change on the same call is much harder to reason about, and to test, than
 * one where "which status is it in" always answers "whose turn is it".
 *
 * The moves, and who drives each one (enforced by `clarification.service.ts`,
 * not by this table — this table only says which moves EXIST; each method
 * below narrows `from` further, to only the single source ITS OWN actor may
 * move from, even where the table lists more than one for that target):
 *
 *   draft -> posted               the treating doctor posts the case
 *                                 (`postCase`).
 *   posted -> awaiting_response   an admin assigns an expert
 *                                 (`assignExpert`, `from: ['posted']` only);
 *                                 this is what "awaiting" means — nobody is
 *                                 on it until someone is.
 *   awaiting_response -> response_received
 *                                 the expert's turn: a substantive reply
 *                                 (`respondAsExpert`, any `messageType`
 *                                 except `clarification_request`).
 *   awaiting_response -> clarification_asked
 *                                 the expert's turn: their reply IS a
 *                                 request for more information
 *                                 (`respondAsExpert`,
 *                                 `messageType: 'clarification_request'`).
 *   clarification_asked -> awaiting_response
 *                                 the treating doctor's turn: they answer
 *                                 (`replyToClarification`,
 *                                 `from: ['clarification_asked']` only); the
 *                                 case goes back onto the expert's queue.
 *   response_received -> reviewed the treating doctor marks the expert's
 *                                 input as read and acted on
 *                                 (`markReviewed`). There is no path back to
 *                                 `awaiting_response` from here — a treating
 *                                 doctor who wants further expert input once
 *                                 a case is `response_received` posts a NEW
 *                                 case, the same "no re-open" discipline
 *                                 `closed` below states.
 *   {posted, awaiting_response, response_received, clarification_asked,
 *    reviewed} -> closed          the treating doctor closes the thread
 *                                 (`closeCase`). Reachable from every
 *                                 non-draft, non-closed state because
 *                                 FR-12.7 makes the treating doctor
 *                                 "responsible for the final treatment plan"
 *                                 — they must be able to end a case whenever
 *                                 they judge it settled, not only after
 *                                 `reviewed`.
 *
 * `draft` has no `from` — it is the row's insert-time value
 * (`clarification_cases.status` defaults to `'draft'`), never a target of a
 * transition, and there is deliberately no "un-post" move back into it: a
 * posted case that needs correcting is closed and re-posted as a new case,
 * the same "no unfinalise" discipline `clinical.controller.ts#finalise`
 * documents for its own domain.
 */
export const CLARIFICATION_STATUS_TRANSITIONS: Record<ClarificationStatus, readonly ClarificationStatus[]> = {
  draft: [],
  posted: ['draft'],
  awaiting_response: ['posted', 'clarification_asked'],
  response_received: ['awaiting_response'],
  clarification_asked: ['awaiting_response'],
  reviewed: ['response_received'],
  closed: ['posted', 'awaiting_response', 'response_received', 'clarification_asked', 'reviewed'],
};

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const CLARIFICATION_AUDIT_ENTITY_TYPES = {
  CLARIFICATION_CASE: 'clarification_case',
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const CLARIFICATION_ERROR_CODES = {
  /**
   * One code for "does not exist" and "is not yours" — deliberately, so a
   * doctor (treating OR expert) cannot probe for the existence of another
   * doctor's case by id. Same reasoning `CLINICAL_ERROR_CODES
   * .CONSULTATION_NOT_FOUND` gives, and the same M-14 adversarial-pass
   * standard this module was built against: "whether a refused join leaks
   * existence".
   */
  CASE_NOT_FOUND: 'CLARIFICATION_CASE_NOT_FOUND',
  /** The case exists and is the caller's, but is not in a status the attempted write is legal from. */
  ILLEGAL_TRANSITION: 'CLARIFICATION_ILLEGAL_TRANSITION',
  /** A draft field edit was attempted on a case that has already been posted — drafts are the only editable state. */
  NOT_A_DRAFT: 'CLARIFICATION_NOT_A_DRAFT',
  /** `expertDoctorId` does not resolve to a verified doctor with `seniorityLevel = 'expert'` — the WHO-MAY-BE-ASKED gate. */
  NOT_AN_EXPERT: 'CLARIFICATION_NOT_AN_EXPERT',
  /** The case's `messages` array is already at `CLARIFICATION_MAX_MESSAGES`. */
  MESSAGE_LIMIT_REACHED: 'CLARIFICATION_MESSAGE_LIMIT_REACHED',
} as const;
