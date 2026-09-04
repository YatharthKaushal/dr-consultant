import type { ConsultationStatus } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `audit_log.entity_type` values this module writes.
 *
 * *** EVERY ONE OF THEM CARRIES `consultation_id`. *** `docs/MODULES.md`'s
 * M-15 done-when is "the full record rebuilds from the consultation ID", and
 * FR-11.6 asks that one id tie booking, session metadata, prescription and
 * case summary together. `audit_log.consultation_id` is already indexed for
 * exactly that lookup, so a write here that omitted it would quietly take a
 * row out of the trail the requirement is about.
 */
export const CLINICAL_AUDIT_ENTITY_TYPES = {
  CLINICAL_RECORD: 'clinical_record',
  DOCTOR_CLINICAL_TEMPLATE: 'doctor_clinical_template',
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const CLINICAL_ERROR_CODES = {
  /**
   * The consultation id is unknown, or it is not the calling doctor's —
   * deliberately ONE code for both, so a doctor cannot probe for another
   * doctor's consultations. Same reasoning `DOCUMENT_ERROR_CODES
   * .CONSULTATION_NOT_FOUND` and `BOOKING_ERROR_CODES.BOOKING_NOT_FOUND` give.
   */
  CONSULTATION_NOT_FOUND: 'CLINICAL_CONSULTATION_NOT_FOUND',
  /** No `clinical_records` row exists for this consultation yet. */
  RECORD_NOT_FOUND: 'CLINICAL_RECORD_NOT_FOUND',
  /** The consultation is not in a status a clinical record may be written against — see `CLINICAL_RECORD_WRITABLE_STATUSES`. */
  CONSULTATION_NOT_WRITABLE: 'CLINICAL_CONSULTATION_NOT_WRITABLE',
  /** The record is already finalised. A finalised record is immutable; there is no unfinalise. */
  RECORD_ALREADY_FINALISED: 'CLINICAL_RECORD_ALREADY_FINALISED',

  /* ── The completion gate (FR-11.5) ─────────────────────────────────────── */

  /** *** THE COMPLETION GATE. *** `case_summary` is missing or blank (FR-11.3). */
  CASE_SUMMARY_REQUIRED: 'CLINICAL_CASE_SUMMARY_REQUIRED',
  /**
   * *** THE COMPLETION GATE. *** Neither a medicine line nor a complete
   * advice/therapy plan is present (FR-11.2: "prescription or advice is
   * mandatory where applicable").
   */
  PRESCRIPTION_OR_ADVICE_REQUIRED: 'CLINICAL_PRESCRIPTION_OR_ADVICE_REQUIRED',

  /* ── The prescribing gate ──────────────────────────────────────────────── */

  /**
   * *** THE PRESCRIBING GATE. *** A medicine line was submitted against a
   * consultation whose booked specialty has `can_prescribe = false`, or into
   * a personal template belonging to a doctor whose primary specialty does
   * not allow prescribing.
   */
  MEDICINES_NOT_PERMITTED: 'CLINICAL_MEDICINES_NOT_PERMITTED',
  /** A `medicines` entry is not `{ name, dose, frequency, duration, instructions? }` with non-blank required fields, or there are too many of them. */
  MEDICINE_LINE_INVALID: 'CLINICAL_MEDICINE_LINE_INVALID',

  /* ── Templates (FR-9.6) ────────────────────────────────────────────────── */

  /** The template id is unknown or belongs to another doctor — one code for both. */
  TEMPLATE_NOT_FOUND: 'CLINICAL_TEMPLATE_NOT_FOUND',
  /** `doctor_clinical_templates` has a unique index on `(doctor_id, name)`. */
  TEMPLATE_NAME_TAKEN: 'CLINICAL_TEMPLATE_NAME_TAKEN',
  /** `specialtyId` was set to a specialty this doctor does not practise — the composite FK to `doctor_specialties` refused it. */
  TEMPLATE_SPECIALTY_NOT_PRACTISED: 'CLINICAL_TEMPLATE_SPECIALTY_NOT_PRACTISED',
} as const;
export type ClinicalErrorCode = (typeof CLINICAL_ERROR_CODES)[keyof typeof CLINICAL_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* Consultation statuses                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The statuses a clinical record may be created or edited against.
 *
 * *** BOTH ARE M-14'S TO SET. *** `in_progress` is "the call is running" and
 * `awaiting_documentation` is FR-10.5's "the call ended, the notes are owed".
 * Nothing in this worktree moves a consultation into either — M-14 (video) is
 * being built in a parallel worktree and owns that move — so this list is the
 * seam, and `clinical-booking.contract.ts` is the port that closes it.
 *
 * Deliberately NOT including `scheduled`/`awaiting_doctor`: writing clinical
 * notes for a consultation that has not happened is not a convenience, it is a
 * fabricated record. And deliberately not including `completed`: finalising is
 * what PUTS a consultation there, and a finalised record is immutable.
 */
export const CLINICAL_RECORD_WRITABLE_STATUSES = [
  'in_progress',
  'awaiting_documentation',
] as const satisfies readonly ConsultationStatus[];

/* -------------------------------------------------------------------------- */
/* Medicines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on `clinical_records.medicines` / `doctor_clinical_templates
 * .medicines`. `jsonb` has no length constraint of its own, and an unbounded
 * array is an unbounded PDF and an unbounded row. Thirty lines is far past any
 * real psychiatric prescription and still small enough to render.
 */
export const MAX_MEDICINE_LINES = 30;

/** Per-field caps on one medicine line. Mirrored by `clinical.dto.ts`; re-applied in the service, because a template's `medicines` arrives as `jsonb`, never through a DTO. */
export const MEDICINE_FIELD_LIMITS = {
  NAME: 200,
  DOSE: 80,
  FREQUENCY: 80,
  DURATION: 80,
  INSTRUCTIONS: 500,
} as const;

/**
 * Ceiling on one consultation's FR-11.6 audit trail.
 *
 * A trail is bounded in practice — a consultation accrues a couple of dozen
 * entries across booking, payment, documents and clinical notes — so this is a
 * guard against a pathological row count, not a paging scheme. If a real
 * consultation ever approaches it, the answer is a paged audit surface in M-22,
 * not a bigger number here.
 */
export const CLINICAL_AUDIT_TRAIL_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* The reconciling sweep                                                       */
/* -------------------------------------------------------------------------- */

/** How often the gate-reconciliation sweep runs. Scheduling is copied from `booking-slot-hold.service.ts` — see `clinical-gate-sweep.service.ts`. */
export const CLINICAL_GATE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Candidates read per QUERY, not per pass. One pass pages across the whole
 * look-back window (`clinical-gate-sweep.service.ts`) — this only bounds how
 * much of it comes back in a single round trip.
 *
 * *** IT USED TO BE PER PASS, AND THAT WAS A BUG. *** The comment here read
 * "bounds one pass's facade calls so a backlog drains steadily instead of in
 * one spike — same reasoning as `SWEEP_BATCH_SIZE`", copied from
 * `booking-slot-hold.service.ts`. That sweep's action moves its candidates out
 * of its own candidate query and takes the oldest first, so its backlog really
 * does drain. This one's candidates never leave the set — reconciling a record
 * leaves it finalised and inside the window — and it takes the NEWEST first,
 * so every pass re-examined the same newest hundred and nothing else in the
 * window was reachable at all. See `clinical.repository.ts#listFinalisedSince`.
 */
export const CLINICAL_GATE_SWEEP_BATCH_SIZE = 100;

/**
 * How many pages one pass may read before leaving the rest for the next tick.
 *
 * The bound the batch size was reaching for, in the place that can actually
 * express it. 20 x 100 = 2,000 records per pass, which is a day's finalisations
 * at a scale this product is nowhere near; past that, a pass that paged the
 * whole window every 60 seconds would be a self-inflicted load spike. Hitting
 * this bound sets `truncated` on the result and logs a warning, so a backlog
 * that genuinely needs a wider horizon is visible instead of silent.
 */
export const CLINICAL_GATE_SWEEP_MAX_BATCHES = 20;

/**
 * How far back the sweep looks for finalised records to reconcile.
 *
 * This is a CRASH-RECOVERY HORIZON, not a general repair job: the state it
 * fixes is created by a process dying between `finalised_at` being set and the
 * two facade calls that follow it, and that window is milliseconds wide. A day
 * of look-back is four orders of magnitude of margin.
 *
 * *** THE HONEST LIMITATION. *** A record finalised longer ago than this whose
 * un-gating never happened is not reachable from here, because the gate lives
 * on `doctors.blocked_by_consultation_id` — M-05's column — and no facade on
 * `DoctorContract` or `InstantContract` lists gated doctors, so this module
 * cannot sweep from the gate's own side. It sweeps from the side it owns. The
 * residual failure is visible rather than silent (the doctor is refused
 * `available_now` with `INSTANT_COMPLETION_GATE_ACTIVE`), and
 * `sweepFinalisedRecords` takes its own `now`/lookback so an operator or a
 * later admin endpoint can widen the window without a redeploy.
 */
export const CLINICAL_GATE_SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * DI token for `ClinicalBookingPort` — the ONE consultation write this module
 * needs and `BookingContract` does not yet expose. Mirrors
 * `document.constants.ts`'s `CONSULTATION_LOOKUP_PROVIDER` and
 * `booking.constants.ts`'s `BOOKING_PAYMENT_PORT`. See
 * `clinical-booking.contract.ts` for the whole seam story and the coordinator's
 * one-line rebinding.
 */
export const CLINICAL_BOOKING_PORT = Symbol('CLINICAL_BOOKING_PORT');

/* -------------------------------------------------------------------------- */
/* The PDF (FR-9.5, FR-14.2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Unicode TTF embedded in every generated prescription PDF.
 *
 * *** PDFKIT'S BUILT-IN FONTS ARE LATIN-1. *** Helvetica and friends are
 * AFM/Type1 fonts with a 256-glyph encoding; hand one of them "डॉ. आरती शर्मा"
 * and it does not error — it emits the wrong glyphs, and a prescription goes
 * out with a mangled patient name on it. That is the failure this constant
 * exists to prevent.
 *
 * Lohit Devanagari (SIL OFL 1.1) covers Devanagari AND Basic Latin, digits and
 * the punctuation this layout uses, so ONE embedded face renders an English
 * label and a Hindi name in the same line with no font switching and no
 * fallback logic to get wrong. See `assets/fonts/README.md` for the licence.
 *
 * Path is resolved relative to this file so it works identically from `src/`
 * under ts-jest and from `dist/` under `nest build` — both are exactly three
 * levels below the project root.
 */
export const CLINICAL_PDF_FONT_RELATIVE_PATH = ['..', '..', '..', 'assets', 'fonts', 'Lohit-Devanagari.ttf'] as const;

/** `patient_files.file_name` for a generated prescription. The consultation's reference code is appended, so a patient's downloads folder is self-describing. */
export const CLINICAL_PDF_FILE_NAME_PREFIX = 'prescription';
