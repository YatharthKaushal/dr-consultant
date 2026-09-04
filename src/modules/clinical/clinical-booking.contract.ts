import type { ConsultationMode, ConsultationStatus } from '../../schema/enums.schema';

/**
 * *** THE M-15 -> M-11/M-14 SEAM. READ BEFORE TOUCHING, AND READ THE
 * ASSUMPTION AT THE BOTTOM BEFORE MERGING. ***
 *
 * Finalising a clinical record has to move the consultation to `completed`
 * (`docs/MODULES.md` M-15: "enforce that it is completed before the case
 * closes"; FR-11.5). This module does not own `consultations` — M-11 does —
 * so the move must go through a facade.
 *
 * *** `BookingFacade.transitionInstantConsultation` CANNOT DO IT. *** Its `to`
 * parameter is type-narrowed to `'awaiting_doctor' | 'pending_payment' |
 * 'expired'`, and its implementation refuses any row that is not
 * `mode: 'instant'` — so it is wrong on both axes: it cannot express
 * `completed`, and a scheduled consultation (the majority) would be refused
 * outright. `tsc` catches the first; only reading the method catches the
 * second.
 *
 * M-14 (video) is being built in a PARALLEL WORKTREE and is adding a general
 * sibling to `BookingContract` for the moves ITS flow needs (`in_progress` and
 * `awaiting_documentation`). `completed` is the move THIS module needs and
 * nobody else's flow asks for, so it is stated here.
 *
 * The interface below is declared LOCALLY and bound to `CLINICAL_BOOKING_PORT`
 * (`clinical.constants.ts`) — the same pattern `document-storage.contract.ts`
 * uses for `DocumentStoragePort`, `booking-payment.contract.ts` for
 * `BookingPaymentPort`, and `promotion-booking.contract.ts` for its own
 * consultation-status read. Because TypeScript is structural, a `BookingFacade`
 * that grows a matching `completeConsultation` satisfies this with NO adapter
 * and NO cast, and the coordinator's whole job is one line in
 * `clinical.module.ts`:
 *
 *     { provide: CLINICAL_BOOKING_PORT, useExisting: BookingFacade }
 *
 * ── THE ASSUMPTION, STATED SO IT CAN BE RECONCILED ─────────────────────────
 *
 * This worktree ASSUMES M-11/M-14 will expose exactly this on
 * `BookingContract`:
 *
 *     completeConsultation(input: {
 *       consultationId: string;
 *       from: readonly ConsultationStatus[];
 *       reason?: string;
 *     }): Promise<{
 *       changed: boolean;
 *       status: ConsultationStatus | null;
 *       refusal?: 'not_found' | 'illegal_transition';
 *     }>;
 *
 * The shape is deliberately `transitionInstantConsultation`'s, minus the
 * instant-only hold and mode restrictions: the CALLER supplies the legal
 * FROM-states and the OWNER takes the row lock and enforces them — the same
 * rule/write split M-05 makes for `doctors.presence`. It is NON-THROWING for a
 * refused move, because the reconciling sweep calls it in a batch loop where
 * one refused candidate must not abandon the rest.
 *
 * If the merged `BookingFacade` names it differently, or folds `completed` into
 * M-14's general method, the change is confined to the binding plus a
 * three-line adapter — nothing in `clinical.service.ts` or the sweep moves.
 *
 * Until then `CLINICAL_BOOKING_PORT` is bound to
 * `ConsultationCompletionProvider`, which delegates the READ to the real
 * `BookingFacade` and performs the WRITE itself. See that file for why that
 * placeholder is a deliberate, temporary, single-statement exception and not
 * this module reaching into another's table as a habit.
 */

/**
 * The subset of a consultation this module reads. A STRICT SUBSET of
 * `booking.contract.ts`'s `BookingView`, field-for-field, so `BookingFacade
 * .getBooking` satisfies it structurally with no adapter — redeclared here
 * rather than imported so this module's port does not depend on M-11's public
 * types, exactly as `booking.contract.ts` itself redeclares M-07's
 * `BusyInterval`.
 */
export interface ClinicalConsultationView {
  id: string;
  referenceCode: string;
  patientId: string;
  /** `null` only while an instant request is still searching for a doctor. */
  doctorId: string | null;
  /** *** THE BOOKING-TIME SPECIALTY SNAPSHOT. THE PRESCRIBING GATE READS THIS. *** */
  specialtyId: string;
  mode: ConsultationMode;
  status: ConsultationStatus;
  scheduledStartAt: Date | null;
  durationMinutes: number;
}

/** See `ClinicalBookingPort#completeConsultation`. */
export interface CompleteConsultationResult {
  /** `false` for both an idempotent no-op (already `completed`) and a refusal — `refusal` tells them apart. */
  changed: boolean;
  /** The status the row is in AFTER the call, or `null` when it does not exist. */
  status: ConsultationStatus | null;
  refusal?: 'not_found' | 'illegal_transition';
}

/** See this file's header. */
export interface ClinicalBookingPort {
  /** One consultation by id, or `null`. Never throws. No ownership check — this module authorizes. */
  getBooking(consultationId: string): Promise<ClinicalConsultationView | null>;

  /**
   * *** THE MOVE TO `completed` (FR-11.5). *** The caller supplies the legal
   * FROM-states; the owner takes the row lock and enforces them. NEVER THROWS
   * for a refused move — it returns a `refusal` code.
   */
  completeConsultation(input: {
    consultationId: string;
    from: readonly ConsultationStatus[];
    reason?: string;
  }): Promise<CompleteConsultationResult>;
}
