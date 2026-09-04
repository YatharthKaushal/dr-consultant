import type { ConsultationMode, ConsultationStatus, Party } from '../../schema/enums.schema';

/**
 * A doctor's busy period. STRUCTURALLY IDENTICAL to
 * `availability.contract.ts`'s `BusyInterval` — redeclared here rather than
 * imported so this module's public surface does not depend on M-07's, which
 * is the same restraint `search-ai.contract.ts` applies. TypeScript is
 * structural, so `BookingFacade` satisfies `BusyIntervalProvider` with no
 * adapter and no cast at the `BUSY_INTERVAL_PROVIDER` binding.
 */
export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

/** One doctor's busy intervals — mirrors `availability.contract.ts`'s `DoctorBusyIntervals`. */
export interface DoctorBusyIntervals {
  doctorId: string;
  intervals: BusyInterval[];
}

/**
 * The subset of a consultation `modules/document` reads. STRUCTURALLY
 * IDENTICAL to `document/consultation-lookup.provider.ts`'s
 * `ConsultationSummary`, redeclared here for the same reason as
 * `BusyInterval` above.
 */
export interface ConsultationSummary {
  id: string;
  patientId: string;
  /** Null only while an instant request is still searching for a doctor. */
  doctorId: string | null;
  status: ConsultationStatus;
}

/** A booking as any caller outside this module sees it. No `holdExpiresAt` — the hold is this module's internal mechanism, not a fact other modules act on. */
export interface BookingView {
  id: string;
  referenceCode: string;
  patientId: string;
  doctorId: string | null;
  specialtyId: string;
  concernId: string | null;
  mode: ConsultationMode;
  status: ConsultationStatus;
  scheduledStartAt: Date | null;
  durationMinutes: number;
  intakeAnswers: unknown;
  rescheduledFromConsultationId: string | null;
  cancelledAt: Date | null;
  cancelledByParty: Party | null;
  cancellationReason: string | null;
  createdAt: Date;
}

/**
 * Booking's public surface. Deliberately shaped around the consumers that
 * ACTUALLY EXIST or are already stubbed waiting for it, and nothing more —
 * the same restraint `catalogue.contract.ts`/`availability.contract.ts`/
 * `document.contract.ts` apply.
 *
 * ── The two placeholders this closes ───────────────────────────────────────
 *
 * 1. `availability`'s `BUSY_INTERVAL_PROVIDER`, currently bound to the
 *    placeholder `ConsultationBusyIntervalProvider`. `getBusyIntervals` +
 *    `getBusyIntervalsForMany` below cover `BusyIntervalProvider` in full.
 *    The batch form is OPTIONAL in M-07's interface but implemented here on
 *    purpose — its own doc comment says "Implement it — the fallback is a
 *    correctness guarantee, not a performance one."
 *
 * 2. `document`'s `CONSULTATION_LOOKUP_PROVIDER`, currently bound to the
 *    placeholder `ConsultationLookupProvider`. `findById` +
 *    `listConsultationIdsBetween` + `listConsultationIdsForPatient` below
 *    cover `ConsultationLookupPort` in full.
 *
 * *** THIS MODULE DOES NOT REBIND EITHER TOKEN. *** Both stay pointed at
 * their in-module placeholders here. The COORDINATOR rebinds them post-merge
 * — deliberately, to avoid a circular-import surprise (`AvailabilityModule`
 * already imports `DoctorModule`, and `BookingModule` imports
 * `AvailabilityModule`; binding `BUSY_INTERVAL_PROVIDER` to `BookingFacade`
 * from inside `availability.module.ts` closes that loop) landing in three
 * parallel worktrees at once. Nothing breaks in the meantime: the
 * placeholders read the same table this module writes, so they are correct,
 * just not routed through the facade.
 *
 * ── What M-13 (Instant Consult) will need ──────────────────────────────────
 *
 * `createInstantBooking` and `assignDoctor` exist for M-13 and are the ONLY
 * instant-consult surface here. This module creates the consultation row for
 * `mode: 'instant'` and can attach a doctor to it once M-13 has chosen one.
 * It owns NONE of the routing: no `instant_consultancy` rows, no acceptance
 * window, no timeout, no re-routing, no seven doctor states — `docs/MODULES.
 * md` assigns every one of those to M-13.
 */
export interface BookingContract {
  /* ── For `availability`'s BUSY_INTERVAL_PROVIDER ───────────────────────── */

  /** Every busy interval for `doctorId` overlapping `[fromUtc, toUtc)`. Only slot-occupying statuses count; `cancelled`/`no_show`/`expired` are free. */
  getBusyIntervals(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BusyInterval[]>;

  /** The batch form — one entry per requested doctor id, including doctors with nothing booked. */
  getBusyIntervalsForMany(doctorIds: readonly string[], fromUtc: Date, toUtc: Date): Promise<DoctorBusyIntervals[]>;

  /* ── For `document`'s CONSULTATION_LOOKUP_PROVIDER ─────────────────────── */

  /** One consultation by id, or `null`. Never throws. No ownership check — a trusted module-to-module read; the CALLER authorizes. */
  findById(consultationId: string): Promise<ConsultationSummary | null>;

  /** Every consultation id shared by this doctor and patient, ANY status. Empty array, never a throw. */
  listConsultationIdsBetween(doctorId: string, patientId: string): Promise<string[]>;

  /** Every consultation id for one patient, any status/doctor. Empty array, never a throw. */
  listConsultationIdsForPatient(patientId: string): Promise<string[]>;

  /* ── General reads other modules will need ─────────────────────────────── */

  /** The full booking view by id, or `null`. For M-12/M-14/M-15/M-19, which each hang their own record off a consultation id. */
  getBooking(consultationId: string): Promise<BookingView | null>;

  /* ── For M-12 (Payments) ───────────────────────────────────────────────── */

  /**
   * *** THE PAID -> SCHEDULED TRANSITION. M-12 CALLS THIS WHEN A PAYMENT IS
   * CAPTURED. ***
   *
   * Booking's single most important state change had NO public entry point:
   * `BookingSlotHoldService.confirmPayment` existed and was documented as
   * handling "the ordinary case" of a capture webhook, but it was not on this
   * contract, so nothing outside this module could reach it (`backend/
   * README.md` §2 — a module's only public surface is its facade). The only
   * path from a captured payment to a `scheduled` booking was therefore the
   * expiry sweep, which by construction looks only at holds that have ALREADY
   * LAPSED — so a patient who paid successfully stayed `pending_payment` until
   * their hold ran out (default 20 minutes) and the next sweep tick picked it
   * up. The slot was never lost, but the booking was not confirmed, and
   * `reschedule` (which requires `scheduled`) was refused for that whole
   * window.
   *
   * Idempotent by design, because a gateway webhook can arrive more than once
   * and can arrive late:
   *   `pending_payment` -> `scheduled`, hold cleared.
   *   `scheduled`       -> returned unchanged (a replayed webhook is not an error).
   *   hold already gone -> the residual late-capture path: re-acquire the slot
   *                        atomically if it is still free, otherwise file for
   *                        admin resolution with the money HELD, never refunded.
   *
   * WIRING NOTE FOR THE COORDINATOR: M-12 does not call this yet. Booking must
   * not reach into payment to arrange it (the dependency runs booking ->
   * payment, via `BOOKING_PAYMENT_PORT`), so closing the loop is one call from
   * M-12's capture path — which is that module's change to make, not this one's.
   */
  confirmPayment(consultationId: string): Promise<BookingView>;

  /* ── For M-13 (Instant Consult) ────────────────────────────────────────── */

  /**
   * Creates a `mode: 'instant'` consultation with NO doctor assigned and no
   * slot — the row M-13 then routes. Returns it in `pending_payment` with a
   * live hold, exactly like a scheduled booking, so the payment path is
   * mode-agnostic. Note FR-10.2 orders the instant flow request -> accept ->
   * pay, so M-13 may choose to assign a doctor before the payment settles;
   * both orders work against this row.
   */
  createInstantBooking(input: {
    patientId: string;
    specialtyId: string;
    concernId?: string | null;
    intakeAnswers?: unknown;
  }): Promise<BookingView>;

  /**
   * Attaches the doctor M-13's routing selected. Refuses unless the
   * consultation is instant-mode and currently unassigned, and enforces that
   * the doctor practises the booked specialty (the
   * `consultations_doctor_specialty_fk` composite FK). Does NOT touch
   * `instant_consultancy` — that table is M-13's.
   */
  assignDoctor(consultationId: string, doctorId: string): Promise<BookingView>;

  /**
   * *** ADDITIVE (M-13). THE INSTANT LIFECYCLE'S STATUS MOVES. ***
   *
   * FR-10.2 orders the instant flow request -> accept -> PAY, which puts
   * three status moves inside M-13's flow that nothing on this contract
   * covered:
   *
   *   `pending_payment` -> `awaiting_doctor`   the request starts routing
   *   `awaiting_doctor` -> `pending_payment`   a doctor accepted; now pay
   *   `awaiting_doctor` -> `expired`           every doctor was tried
   *
   * The caller supplies the legal FROM-states and this module takes the row
   * lock and enforces them — the same rule/write split M-05 makes for
   * `doctors.presence`, and the reason M-13 never writes `consultations`
   * itself. Restricted to `mode: 'instant'` rows, so it cannot become a
   * general status setter that routes around cancel/reschedule/no-show.
   *
   * NON-THROWING for a refused move: both of M-13's sweeps call it in a batch
   * loop, where one refused candidate must not abandon the rest.
   */
  transitionInstantConsultation(input: {
    consultationId: string;
    to: 'awaiting_doctor' | 'pending_payment' | 'expired';
    from: readonly ConsultationStatus[];
    /** Omit to leave the hold alone. `null` clears it; a date sets it. */
    holdExpiresAt?: Date | null;
    reason?: string;
  }): Promise<{ changed: boolean; booking: BookingView | null; refusal?: 'not_found' | 'not_instant' | 'illegal_transition' }>;

  /* ── For M-14 (Video Consultation) ─────────────────────────────────────── */

  /**
   * *** ADDITIVE (M-14). THE CONSULT LIFECYCLE'S TWO MIDDLE STATUS MOVES. ***
   *
   *   `scheduled`   -> `in_progress`             the call started
   *   `in_progress` -> `awaiting_documentation`  the call ended
   *
   * `consultation_status` has carried both values since the first migration and
   * nothing set either one before M-14 — see `BookingService
   * #transitionConsultationStatus` for the full account of who writes what.
   *
   * *** A SIBLING OF `transitionInstantConsultation`, NOT A WIDENING OF IT. ***
   * That method cannot be reused: its `to` is type-narrowed to three values
   * neither of these is among, and it refuses any row whose `mode` is not
   * `'instant'`. This one works for BOTH modes, because a scheduled
   * consultation is the ORDINARY case of a video call.
   *
   * Same rule/write split as its sibling and as `DoctorContract
   * #transitionPresence`: the caller supplies the legal FROM-states, this
   * module takes the `SELECT ... FOR UPDATE` and enforces them. What keeps it
   * from becoming a general status setter is the `to` narrowing — no caller can
   * reach `cancelled`, `no_show`, `scheduled` or `completed` through here and
   * route around the policy that owns each.
   *
   * NON-THROWING for a refused move: the caller is a webhook handler that must
   * answer 2xx, and a redelivered join event for a consultation that has since
   * ended is an ordinary event rather than an error.
   */
  transitionConsultationStatus(input: {
    consultationId: string;
    to: 'in_progress' | 'awaiting_documentation';
    from: readonly ConsultationStatus[];
    reason?: string;
  }): Promise<{ changed: boolean; booking: BookingView | null; refusal?: 'not_found' | 'illegal_transition' }>;

  /**
   * *** ADDITIVE (M-15). THE MOVE TO `completed`, AND ONLY THAT MOVE. ***
   *
   * A third sibling rather than a widening of the method above, deliberately.
   * That one's `to` excludes `completed` so no caller can route around the
   * policy that owns it — and the policy that owns it is FR-11.5's completion
   * gate in M-15: a case is complete only once the clinical record is
   * finalised. Widening the sibling would hand that power to M-14's webhook.
   *
   * There is no `to` parameter: there is nothing to choose. The caller supplies
   * the legal FROM-states and this module takes the row lock and enforces them.
   *
   * Returns a STATUS rather than a `BookingView`, unlike its siblings — the
   * caller needs only to know whether the move landed. NON-THROWING for a
   * refused move; M-15 calls this after its own transaction has already
   * committed a finalised record.
   */
  completeConsultation(input: {
    consultationId: string;
    from: readonly ConsultationStatus[];
    reason?: string;
  }): Promise<{ changed: boolean; status: ConsultationStatus | null; refusal?: 'not_found' | 'illegal_transition' }>;

  /**
   * ADDITIVE (M-13): instant consultations sitting in `pending_payment` past
   * their hold — the candidate query behind M-13's post-acceptance payment
   * sweep, the failure mode with no equivalent in the scheduled flow (a
   * doctor accepted, and the patient never paid).
   *
   * Deliberately NOT served by this module's own two-tier sweep, which by
   * design refuses to release a hold that reached the gateway. That is right
   * for a slot and wrong for a live doctor. See
   * `booking.repository.ts#listExpiredInstantHolds`.
   */
  listExpiredInstantHolds(now: Date, limit: number): Promise<Array<{
    consultationId: string;
    patientId: string;
    doctorId: string | null;
    holdExpiresAt: Date | null;
  }>>;

  /**
   * ADDITIVE (M-13): instant consultations that have been sitting in
   * `awaiting_doctor` since before `staleBefore`.
   *
   * `awaiting_doctor` is the one live instant status with no
   * `hold_expires_at`, so neither this module's hold sweep nor M-13's payment
   * sweep can see it, and M-13's acceptance sweep only sees offers that are
   * still `pending`. A request whose re-route failed after a decline, a
   * timeout or a rolled-back accept was therefore reachable by nothing at all.
   * This is the candidate query for the sweep that closes that.
   *
   * See `booking.repository.ts#listStaleAwaitingDoctorRequests`.
   */
  listStaleAwaitingDoctorRequests(staleBefore: Date, limit: number): Promise<Array<{
    consultationId: string;
    patientId: string;
    updatedAt: Date;
  }>>;

  /**
   * ADDITIVE (M-20/governance and quality): every consultation status's
   * current row count, for FR-18.6's "completed cases" quality-dashboard
   * figure. Deliberately a `GROUP BY`, not a per-status `count(*)` the
   * caller runs once per status it cares about — one round trip either way.
   *
   * A status with zero rows is simply absent from the map; treat a missing
   * key as `0`. This is a READ of `consultations.status`, nothing more — it
   * carries no money and answers no question `BookingAdminController`'s own
   * `admin/bookings` routes don't already answer one status at a time; it
   * exists only because the dashboard wants every status's count in one call.
   */
  countByStatus(): Promise<Partial<Record<ConsultationStatus, number>>>;
}
