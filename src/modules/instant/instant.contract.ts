import type { DoctorPresence, InstantConsultancyOutcome } from '../../schema/enums.schema';

/** One `instant_consultancy` row — a single offer made to a single doctor. */
export interface InstantRequestView {
  id: string;
  consultationId: string;
  doctorId: string;
  /** Routing order — 1 is the first doctor tried. */
  attemptNumber: number;
  outcome: InstantConsultancyOutcome;
  offeredAt: Date;
  /** The acceptance window's close, or — once accepted — the payment window's. See `instant-expiry.service.ts`. */
  expiresAt: Date;
}

/** An instant request and its whole routing history — what the admin oversight screen and FR-18.6's acceptance metric both read. */
export interface InstantConsultView {
  consultationId: string;
  /** `null` until a doctor accepts. */
  doctorId: string | null;
  /** M-11's `consultation_status`, not a vocabulary of this module's own. */
  status: string;
  /** Every doctor offered, `attemptNumber` ascending. */
  attempts: InstantRequestView[];
  /** The offer currently outstanding, if any. */
  pendingAttempt: InstantRequestView | null;
}

/** A doctor's live routing-relevant state — a straight pass-through of M-05's `DoctorPresenceState`, redeclared here so this module's public surface does not depend on M-05's. */
export interface InstantPresenceView {
  doctorId: string;
  presence: DoctorPresence;
  allowInstantConsult: boolean;
  /** *** THE COMPLETION GATE. *** Non-null means documentation is outstanding and no instant request may be routed here. */
  blockedByConsultationId: string | null;
  /** `presence = 'available_now'` AND permitted AND not gated AND verified/listed — the single fact a caller usually wants. */
  routable: boolean;
}

/**
 * The outcome of taking a doctor out of the routing pool because a call
 * started. `changed: false` with no `refusal` is an idempotent no-op — an
 * instant consult is already `in_consultation` from its accept.
 */
export interface ConsultStartView {
  changed: boolean;
  doctorId: string | null;
  presence: DoctorPresence | null;
  refusal?: 'not_found' | 'no_doctor' | 'illegal_transition';
}

/**
 * The outcome of putting a doctor BACK in the routing pool because a call
 * ended. `changed: false` with no `refusal` is an idempotent no-op.
 */
export interface ConsultEndView {
  changed: boolean;
  doctorId: string | null;
  presence: DoctorPresence | null;
  /**
   * `instant_consult` is not a failure — it says this consultation's way out is
   * `markInstantConsultEnded` (gate, then `completing_notes`), which must not
   * be skipped by putting the doctor straight back in the pool.
   */
  refusal?: 'not_found' | 'no_doctor' | 'instant_consult' | 'illegal_transition';
}

/** The outcome of a completion-gate write. `changed: false` with no `refusal` is an idempotent no-op, not a failure. */
export interface CompletionGateView {
  changed: boolean;
  /** The doctor the gate was on. `null` when nothing was gated by that consultation. */
  doctorId: string | null;
  blockedByConsultationId: string | null;
  refusal?: 'doctor_not_found' | 'already_gated';
}

/**
 * M-13's public surface (`backend/README.md` §2).
 *
 * Deliberately shaped around the consumers that ACTUALLY EXIST or are named
 * as depending on this module, and nothing more — the same restraint
 * `booking.contract.ts` and `doctor.contract.ts` apply. Routing, the
 * acceptance window, timeouts, re-routing and the seven-state machine are all
 * driven from this module's own controllers and sweeps and are NOT on this
 * contract: no other module starts or answers an instant request.
 *
 * ── WHAT M-15 (CLINICAL RECORDS) NEEDS ─────────────────────────────────────
 *
 * `clearCompletionGate` is the one method M-15 must call, and the reason this
 * contract exists at all. `docs/erd.sql` on `clinical_records`: "Setting
 * `finalised_at` requires case_summary, plus either a medicine line
 * (prescribing specialty) or the advice fields (non-prescribing). *The same
 * transaction clears `doctors.blocked_by_consultation_id`.*" M-15 holds the
 * consultation it just finalised; it must not hold a `doctors` UPDATE.
 *
 * *** ON "THE SAME TRANSACTION". *** This method takes no `tx`, and cannot:
 * `backend/README.md` §2 forbids cross-module transactions. What that ERD note
 * asks for is atomicity between finalisation and un-gating, and the honest
 * version of it here is that a crash between the two leaves a doctor gated by
 * a consultation whose record is already final — which is exactly the state
 * `clearCompletionGate` is idempotent for. M-15 may retry it, an admin may
 * trigger it, and a doctor sees "finish your notes" for a record that is
 * finished until one of those happens. That is a strictly better failure than
 * a cross-module transaction, which cannot be built at all here.
 *
 * ── WHAT M-14 (VIDEO) NEEDS ────────────────────────────────────────────────
 *
 * `markInstantConsultEnded` — the consult is over, so gate the doctor and put
 * them in `completing_notes` (FR-10.4/FR-10.5). Exposed here because M-14 owns
 * "the call ended"; also reachable from this module's own doctor endpoint, so
 * the state is reachable end to end before M-14 exists.
 *
 * ── WHAT M-09 (SEARCH) AND M-04 NEED ───────────────────────────────────────
 *
 * `getPresence` — FR-4.2 puts "live availability" on a listing card, and
 * FR-10.2's Available Now badge is the same fact. Read-only.
 */
export interface InstantContract {
  /**
   * *** SETS THE COMPLETION GATE (FR-10.5). *** The instant consultation
   * ended: block this doctor from any new instant request, and move them to
   * `completing_notes`.
   *
   * Refuses (without throwing) when the doctor is already gated by a
   * DIFFERENT consultation — overwriting would silently drop the older
   * outstanding documentation, which is the one outcome the gate exists to
   * prevent. A no-op on a consultation that is already gating its doctor.
   */
  markInstantConsultEnded(consultationId: string): Promise<CompletionGateView>;

  /**
   * *** THE CALL STARTED. M-14 CALLS THIS. ***
   *
   * Takes the doctor out of the routing pool for the duration, by moving them
   * to `in_consultation`.
   *
   * It exists because of a real hole. For an INSTANT consult M-13 already sets
   * `in_consultation` at accept — but for a SCHEDULED one nothing did, so a
   * doctor sitting `available_now` could be offered an instant request in the
   * middle of a booked video call. M-14 found it and could not close it from
   * its own side: the legal from-states live in this module's constants, and
   * importing them across the boundary is the deep import `README.md` §2
   * forbids. So the fix belongs here, as a sibling of the method above.
   *
   * *** IT MOVES A DOCTOR OUT OF `available_now` AND OUT OF NOTHING ELSE. ***
   * `available_now` is the only state an instant offer can land on
   * (`request_pending` is reachable from no other), so it is the only state
   * this has to protect — and, crucially, the only one `markConsultEnded` can
   * honestly put back. Unnarrowed it also dragged `offline`, `paused` and
   * `scheduled_only` doctors into `in_consultation`, which is a state `offline`
   * is deliberately not reachable from: the doctors who take the most SCHEDULED
   * calls lost their standing FR-10.3 preference on the first one.
   *
   * MODE-AGNOSTIC and IDEMPOTENT. An instant consult is already
   * `in_consultation`, which answers `changed: false` with no refusal, so M-14
   * calls this for every call without caring which kind it is.
   *
   * NON-THROWING: the caller is a webhook handler that must answer 2xx, and a
   * redelivered join for a call already under way is an ordinary event.
   */
  markConsultInProgress(consultationId: string): Promise<ConsultStartView>;

  /**
   * *** THE CALL ENDED — THE OTHER HALF OF `markConsultInProgress`. M-14 CALLS
   * THIS. *** Puts the doctor BACK in the routing pool, from
   * `in_consultation` to `available_now` and from nowhere else.
   *
   * It exists because the half above had no inverse, and the asymmetry was a
   * one-way door: `in_consultation` is not reset by the boot sweep, is not
   * reset when a doctor's socket drops, and `offline` is not reachable from it
   * at all — so every doctor who finished a SCHEDULED video call was left
   * silently out of instant routing until they noticed and re-set their own
   * presence by hand. M-15 does not rescue them either: it clears a completion
   * gate, and a scheduled consult never set one.
   *
   * *** IT REFUSES AN INSTANT CONSULT (`refusal: 'instant_consult'`), AND THAT
   * IS THE POINT. *** That flow's way out is `markInstantConsultEnded` — set
   * FR-10.5's gate, then `completing_notes` — and going straight back to
   * `available_now` would be exactly the documentation bypass the gate exists
   * to prevent.
   *
   * NON-THROWING, and idempotent: a doctor who is not `in_consultation` is
   * left exactly where they are.
   */
  markConsultEnded(consultationId: string): Promise<ConsultEndView>;

  /**
   * *** CLEARS THE COMPLETION GATE (FR-10.5). M-15 CALLS THIS. *** Addressed
   * by consultation because that is what M-15 holds, and idempotent because
   * M-15 must be able to retry it — see the interface header.
   *
   * Also returns the doctor to `available_now` when they are sitting in
   * `completing_notes`, so finishing the notes puts them straight back in the
   * routing pool with no second action.
   */
  clearCompletionGate(consultationId: string): Promise<CompletionGateView>;

  /** One instant request with its full routing history, or `null` if the consultation is unknown or not `mode: 'instant'`. No ownership check — a trusted module-to-module read; the CALLER authorizes. */
  getInstantConsult(consultationId: string): Promise<InstantConsultView | null>;

  /** A doctor's live presence, or `null` if the doctor id does not exist. */
  getPresence(doctorId: string): Promise<InstantPresenceView | null>;

  /**
   * ADDITIVE (M-21/data rights execution): a patient data-deletion preview
   * needs a row count for `instant_consultancy` without touching any of
   * them — this table is RETAIN in the M-21 compliance survey (a
   * consultation's routing history, part of the clinical record retained
   * under SRS §5.3). Empty array in, `0` out.
   */
  countOffersForConsultations(consultationIds: readonly string[]): Promise<number>;
}
