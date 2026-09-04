import type { ComplaintStatus } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* Field limits                                                               */
/* -------------------------------------------------------------------------- */

export const FEEDBACK_FIELD_LIMITS = {
  MIN_RATING: 1,
  MAX_RATING: 5,
  COMMENT: 2000,
} as const;

export const COMPLAINT_FIELD_LIMITS = {
  SUBJECT: 200,
  DESCRIPTION: 4000,
  MESSAGE_BODY: 4000,
  RESOLUTION_NOTE: 2000,
} as const;

/** Cap on the length of one complaint's `messages` array — `clarification.constants.ts#CLARIFICATION_MAX_MESSAGES`'s reasoning: a runaway thread is a data-quality problem, not a use case. */
export const COMPLAINT_MAX_MESSAGES = 200;

/* -------------------------------------------------------------------------- */
/* Reference codes                                                             */
/* -------------------------------------------------------------------------- */

/** `complaints.reference_code` is `varchar(24)`; this prefix plus the generated body must stay inside that — `booking.constants.ts#BOOKING_REFERENCE_PREFIX`'s sizing note, applied here. */
export const COMPLAINT_REFERENCE_PREFIX = 'CMP';

/** How many times `generateReferenceCode` retries on a `UNIQUE(reference_code)` collision before giving up — `booking.service.ts#generateReferenceCode`'s number. */
export const COMPLAINT_REFERENCE_ALLOCATION_ATTEMPTS = 5;

/* -------------------------------------------------------------------------- */
/* The complaint status state machine                                        */
/* -------------------------------------------------------------------------- */

/**
 * *** THE WHOLE STATE MACHINE, IN ONE PLACE. *** Copies the shape
 * `LEGAL_VIDEO_STATUS_TRANSITIONS` (`src/modules/video/video.constants.ts`)
 * and `CLARIFICATION_STATUS_TRANSITIONS`
 * (`src/modules/clarification/clarification.constants.ts`) use: read each
 * entry as "a complaint may ENTER <key> from any of <value>", so a caller
 * writes `COMPLAINT_STATUS_TRANSITIONS[target]` and
 * `complaint.repository.ts#updateStatusIfIn` enforces it as a guarded
 * `UPDATE ... WHERE id = ? AND status IN (from)` under the row lock, rather
 * than any call site hand-rolling a subtly different legal set.
 *
 * `docs/MODULES.md`/this brief state the diagram literally as
 * `open -> in_progress -> resolved | rejected`, and this table follows that
 * literally rather than adding leniency an admin never asked for:
 *
 *   open -> in_progress   `assign` (`complaint.service.ts#assignComplaint`) —
 *                          an admin takes ownership, writing
 *                          `assigned_to_admin_id`. Only legal FROM `open`:
 *                          reassigning a complaint someone is already
 *                          working is deliberately out of this round's scope
 *                          (the same kind of scope line `clarification.
 *                          constants.ts` draws elsewhere) — a complaint
 *                          already `in_progress` keeps its current assignee
 *                          until it resolves or is rejected.
 *   in_progress -> resolved   `resolve` — the one and only entry into
 *                          `resolved`, and the one and only place
 *                          `resolved_at` is ever set (`complaints.schema.ts`'s
 *                          own header: "rejected is not resolved, and
 *                          neither is derivable from the other").
 *   in_progress -> rejected   `reject` — no `resolved_at` written, ever.
 *
 * `open` has no `from` — it is the row's insert-time value
 * (`complaints.status` defaults to `'open'`), never a transition target.
 * There is deliberately no path back to `open` from anywhere: a
 * mis-resolved or mis-rejected complaint is not re-opened by this module —
 * the patient can always raise a fresh complaint, `messages` keeps the full
 * history either way, and "can a closed complaint un-close itself" is
 * exactly the "no unfinalise" discipline `clinical.controller.ts#finalise`
 * documents for its own domain.
 */
export const COMPLAINT_STATUS_TRANSITIONS: Record<ComplaintStatus, readonly ComplaintStatus[]> = {
  open: [],
  in_progress: ['open'],
  resolved: ['in_progress'],
  rejected: ['in_progress'],
};

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export const FEEDBACK_AUDIT_ENTITY_TYPES = {
  FEEDBACK: 'feedback',
  COMPLAINT: 'complaint',
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const FEEDBACK_ERROR_CODES = {
  /** Same booking-ownership-check convention every module here follows: a stranger's consultation id and one that does not exist produce the identical 404. */
  CONSULTATION_NOT_FOUND: 'FEEDBACK_CONSULTATION_NOT_FOUND',
  /** `UNIQUE(consultation_id)` — a second submission for the same consult. */
  ALREADY_SUBMITTED: 'FEEDBACK_ALREADY_SUBMITTED',
  NOT_FOUND: 'FEEDBACK_NOT_FOUND',
} as const;

export const COMPLAINT_ERROR_CODES = {
  /** One code for "does not exist" and "is not yours" — `clarification.constants.ts#CLARIFICATION_ERROR_CODES.CASE_NOT_FOUND`'s reasoning, applied here. */
  COMPLAINT_NOT_FOUND: 'COMPLAINT_NOT_FOUND',
  CONSULTATION_NOT_FOUND: 'COMPLAINT_CONSULTATION_NOT_FOUND',
  ILLEGAL_TRANSITION: 'COMPLAINT_ILLEGAL_TRANSITION',
  MESSAGE_LIMIT_REACHED: 'COMPLAINT_MESSAGE_LIMIT_REACHED',
  REFERENCE_ALLOCATION_FAILED: 'COMPLAINT_REFERENCE_ALLOCATION_FAILED',
} as const;
