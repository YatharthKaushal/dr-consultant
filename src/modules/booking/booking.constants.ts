import type { ConsultationStatus } from '../../schema/enums.schema';

/** `audit_log.entity_type` values this module writes. */
export const BOOKING_AUDIT_ENTITY_TYPES = {
  CONSULTATION: 'consultation',
  /**
   * The ADMIN RESOLUTION QUEUE. Not a table — a distinguished `audit_log`
   * entity type, queried by `booking.repository.ts#listAdminResolutionQueue`
   * and served by `GET /admin/bookings/resolution-queue`.
   *
   * Why an audit row rather than a new table or a new column: the two cases
   * that reach it (a late capture whose slot was taken, and a cancellation
   * whose refund the policy cannot decide) are both "money is held and a
   * human must choose what happens next". That is an EVENT about a
   * consultation, not new state on one — the consultation's own status
   * already says what happened to the slot. `audit_log` is already the
   * durable, append-only, queryable record this module is required to write
   * to (`docs/MODULES.md` §7 rule 6), it already carries a first-class
   * `consultation_id`, and using it costs no migration — which matters,
   * because M-12 is being built in a parallel worktree and a same-numbered
   * migration is a collision this project has already hit once.
   */
  ADMIN_RESOLUTION: 'booking_admin_resolution',
} as const;

/**
 * The `metadata.kind` discriminator on an `ADMIN_RESOLUTION` audit row —
 * what a human is being asked to decide.
 */
export const BOOKING_RESOLUTION_KINDS = {
  /** A payment captured after its hold expired, and the slot has since been taken by someone else. Money is held, NOT auto-refunded. */
  LATE_CAPTURE_SLOT_TAKEN: 'late_capture_slot_taken',
  /** A cancellation the refund policy cannot price on its own — see `booking-policy.engine.ts`. */
  REFUND_NEEDS_REVIEW: 'refund_needs_review',
} as const;
export type BookingResolutionKind = (typeof BOOKING_RESOLUTION_KINDS)[keyof typeof BOOKING_RESOLUTION_KINDS];

export const BOOKING_ERROR_CODES = {
  /** No consultation with this id, or it is not the caller's — deliberately the same code for both, so a caller with no relationship cannot probe for existence. */
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  /** The patient id on the booking request does not resolve to a patient profile. */
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
  /** The doctor does not exist, is not `verified`, or is not listed. */
  DOCTOR_NOT_BOOKABLE: 'DOCTOR_NOT_BOOKABLE',
  /** The specialty id does not exist, or is not active (a new booking may only be taken under an active specialty). */
  SPECIALTY_NOT_BOOKABLE: 'SPECIALTY_NOT_BOOKABLE',
  /** The concern id does not exist, or belongs to a different specialty than the one booked. */
  CONCERN_NOT_BOOKABLE: 'CONCERN_NOT_BOOKABLE',
  /** The chosen doctor does not practise the chosen specialty — the `consultations_doctor_specialty_fk` composite FK, checked early for a clean 400. */
  DOCTOR_SPECIALTY_MISMATCH: 'DOCTOR_SPECIALTY_MISMATCH',
  /** `AvailabilityFacade.isSlotBookable` said no. Carries `reason` from `SlotBookability`. */
  SLOT_NOT_BOOKABLE: 'SLOT_NOT_BOOKABLE',
  /**
   * THE AUTHORITATIVE double-booking answer: the partial unique index
   * `consultations_doctor_slot_unique_idx` rejected the insert. Distinct from
   * `SLOT_NOT_BOOKABLE` on purpose — that one is the advisory pre-check, this
   * one is the database refusing, and only this one is race-proof.
   */
  SLOT_ALREADY_TAKEN: 'SLOT_ALREADY_TAKEN',
  /** The consultation is not in a status this transition is legal from. */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  /** A scheduled booking needs a `scheduledStartAt`; an instant one must not carry a slot. */
  INVALID_BOOKING_SHAPE: 'INVALID_BOOKING_SHAPE',
  /**
   * ANY throw from `BOOKING_PAYMENT_PORT`, rewrapped. A raw gateway or
   * payment-module error must never reach a patient — see
   * `booking.service.ts#createBooking`.
   */
  PAYMENT_SETUP_FAILED: 'PAYMENT_SETUP_FAILED',
  /** The consultation has no payment row to move, refund or reconcile. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** `booking.cancellation_policy` / `booking.reschedule_policy` in `app_config` is malformed. Never surfaces to a patient — the compiled-in default is used instead; this code exists for the admin validation endpoint. */
  INVALID_POLICY_SHAPE: 'INVALID_POLICY_SHAPE',
  /** The document id does not exist, or does not belong to the patient on this consultation. */
  DOCUMENT_NOT_ATTACHABLE: 'DOCUMENT_NOT_ATTACHABLE',
  /**
   * `generateReferenceCode` could not find a free `reference_code` in five
   * tries. A transient SERVER-side failure, not anything the caller did — it
   * previously reused `INVALID_STATE_TRANSITION`, which is a client-facing
   * "this booking is in the wrong state" code and carries a `currentStatus` a
   * client will read; a client switching on the code would have rendered a
   * state message for a booking that has no state yet.
   */
  REFERENCE_ALLOCATION_FAILED: 'REFERENCE_ALLOCATION_FAILED',
} as const;
export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[keyof typeof BOOKING_ERROR_CODES];

/**
 * `app_config` keys this module reads. All three are GENUINELY NEW — neither
 * `docs/erd.sql`'s example key list nor any SRS section defines them, and the
 * JSON shape behind the two policy keys is defined nowhere in the docs at all.
 * Flagged here rather than invented silently, exactly as
 * `availability.constants.ts` flags its own three.
 */
export const BOOKING_CONFIG_KEYS = {
  SLOT_HOLD_MINUTES: 'booking.slot_hold_minutes',
  CANCELLATION_POLICY: 'booking.cancellation_policy',
  RESCHEDULE_POLICY: 'booking.reschedule_policy',
} as const;

/**
 * *** WHY 20 MINUTES, AND WHY IT MUST STAY LONGER THAN THE GATEWAY WINDOW ***
 *
 * While `status = 'pending_payment'`, the consultation row IS the slot hold
 * (`consultations.schema.ts`), and the partial unique index makes that hold
 * exclusive. `hold_expires_at` is how long we promise to keep it.
 *
 * Razorpay's checkout session is the constraint. A UPI collect request
 * expires in ~5 minutes; a card/netbanking/3-D Secure journey can legitimately
 * run to the checkout modal's ~15-minute ceiling. If our hold were SHORTER
 * than that window, the ordinary, entirely legitimate case — patient finishes
 * paying at minute 16 — would find its slot already released and possibly
 * resold, turning a successful payment into a refund-or-argue situation. That
 * is the "stranded payment" this module exists to make impossible.
 *
 * So the hold is deliberately set LONGER than the gateway's own window: 20
 * minutes gives ~5 minutes of headroom past the 15-minute ceiling, so a
 * legitimate capture webhook essentially always lands inside a LIVE hold and
 * takes the ordinary `confirmPayment` path. The late-capture path
 * (`booking-slot-hold.service.ts#confirmLateCapture`) still exists, because
 * "essentially always" is not "always" — but it is an exception path, not the
 * common one.
 *
 * The cost of the extra headroom is small and bounded: a slot sits held for
 * at most 20 minutes after an abandoned checkout. Tier 1 of the sweep cuts
 * even that short — an abandonment that never reached the gateway (no
 * `gateway_order_id`) is released as soon as the hold lapses, without waiting
 * on anything. Do not lower this below the gateway's checkout window to
 * "free slots faster": it trades a bounded, self-healing delay for an
 * unbounded money problem.
 */
export const BOOKING_CONFIG_FALLBACKS = {
  SLOT_HOLD_MINUTES: 20,
} as const;

/**
 * DI token for the `BookingPaymentPort` implementation, bound in
 * `booking.module.ts` — mirrors `search.constants.ts`'s `SEARCH_AI_PORT` and
 * `document.constants.ts`'s `DOCUMENT_STORAGE_PORT`.
 *
 * Bound to `UnavailableBookingPaymentProvider` (a null object that throws
 * `PAYMENT_PORT_UNAVAILABLE`) until `modules/payment` (M-12) is merged; the
 * COORDINATOR then rebinds it to `PaymentFacade`, which satisfies
 * `BookingPaymentPort` structurally — see `booking-payment.contract.ts`.
 */
export const BOOKING_PAYMENT_PORT = Symbol('BOOKING_PAYMENT_PORT');

/**
 * The consultation statuses that OCCUPY a doctor's calendar slot — an exact
 * mirror of the `WHERE` clause of `consultations_doctor_slot_unique_idx`
 * (`drizzle/0003_consultations_double_booking_guard.sql`). Anything NOT in
 * this list (`cancelled`, `no_show`, `expired`) frees the slot, which is what
 * makes cancel-then-rebook and the reschedule path work at all.
 *
 * Kept as a literal list here rather than imported from the migration (which
 * is SQL, not TS), for the same reason `consultation-busy-interval.provider.
 * ts` keeps its own copy: a change to one must be a visible diff, not silent
 * drift. IF YOU CHANGE THE MIGRATION'S LIST, CHANGE THIS ONE TOO — and the
 * copy in `consultation-busy-interval.provider.ts`.
 */
export const SLOT_OCCUPYING_STATUSES = [
  'pending_payment',
  'scheduled',
  'awaiting_doctor',
  'in_progress',
  'awaiting_documentation',
  'completed',
] as const satisfies readonly ConsultationStatus[];

/**
 * Statuses a booking may be CANCELLED from. `completed`/`no_show` are
 * terminal records of something that actually happened and must not be
 * rewritten; `cancelled`/`expired` are already released. `in_progress` is
 * excluded deliberately — a consult that is under way is ended by the
 * clinical module, not cancelled out from under it.
 */
export const CANCELLABLE_STATUSES = [
  'pending_payment',
  'scheduled',
  'awaiting_doctor',
] as const satisfies readonly ConsultationStatus[];

/**
 * Statuses a booking may be RESCHEDULED from. Deliberately narrower than
 * `CANCELLABLE_STATUSES`: reschedule MOVES AN EXISTING PAYMENT to a new
 * consultation row, so it only makes sense once there is a settled payment to
 * move. A `pending_payment` booking has no payment worth moving — the patient
 * should abandon it (the sweep releases the slot) and book afresh.
 */
export const RESCHEDULABLE_STATUSES = ['scheduled'] as const satisfies readonly ConsultationStatus[];

/**
 * Statuses a doctor may mark NO-SHOW from. The patient never turned up to a
 * consult that was due, so the booking must have been live and payable-for.
 */
export const NO_SHOW_STATUSES = [
  'scheduled',
  'awaiting_doctor',
  'in_progress',
] as const satisfies readonly ConsultationStatus[];

/** Upper bound on one page of a booking list, so a patient/doctor listing can never become an unbounded scan. */
export const MAX_BOOKING_PAGE_SIZE = 100;
export const DEFAULT_BOOKING_PAGE_SIZE = 20;

/** How many rows one admin-resolution-queue page returns. */
export const MAX_RESOLUTION_QUEUE_PAGE_SIZE = 100;

/** `consultations.reference_code` is `varchar(24)`; this prefix plus the generated body must stay inside that. */
export const BOOKING_REFERENCE_PREFIX = 'DRC';
