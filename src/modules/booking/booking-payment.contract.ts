/**
 * *** THE M-11 -> M-12 (PAYMENT) SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/payment` is being built in a PARALLEL WORKTREE and does not exist
 * in this one, so a direct `import from '../payment/payment.contract'` would
 * not compile. This file declares the interface LOCALLY and binds it to the
 * `BOOKING_PAYMENT_PORT` DI token (`booking.constants.ts`) — precisely the
 * pattern `search/search-ai.contract.ts` uses for `SearchAiPort`/
 * `SEARCH_AI_PORT`, and `document/document-storage.contract.ts` uses for
 * `DocumentStoragePort`/`DOCUMENT_STORAGE_PORT`.
 *
 * The types below are a VERBATIM mirror of `modules/payment`'s own FIXED
 * signature — the other worktree is exporting this exact shape. Because
 * TypeScript is structural, `PaymentFacade` will satisfy `BookingPaymentPort`
 * with no adapter, no cast and no change on either side.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `BOOKING_PAYMENT_PORT` FROM
 * `UnavailableBookingPaymentProvider` TO `PaymentFacade` IN
 * `booking.module.ts`. *** That is the whole handover: one line in the
 * `providers` array. Until then the null object throws
 * `PAYMENT_PORT_UNAVAILABLE`, and every call site in this module wraps that
 * (and any other throw) as `PAYMENT_SETUP_FAILED`.
 *
 * Do NOT "fix" this into a cross-module import of `modules/payment`:
 * `backend/README.md` §2 says a module's only public surface is its facade,
 * resolved through DI, and the token is exactly that. If the payment module's
 * signature ever changes, change it HERE too — a structural mismatch will
 * surface as a `tsc` error at the binding in `booking.module.ts`, which is
 * the point.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, per `docs/MODULES.md` §7 rule 5
 * ("fee and GST in M-12") and M-12's own `Data owned` list: it does not
 * compute the convenience fee or GST, does not read fee configuration, does
 * not talk to Razorpay, and does not write `payments`/`refunds` rows. Every
 * one of those is behind this port. Booking's only money-shaped decision is
 * WHICH REFUND PERCENTAGE THE CANCELLATION POLICY ENTITLES — and even that is
 * handed to M-12 as an amount to actually move.
 */

/** The bill, as M-12 computes it. Every field is a decimal string, never a float — these are `numeric(10,2)` columns and money must not round through binary floating point. */
export interface PaymentBreakdown {
  consultationFee: string;
  convenienceFeePct: string;
  convenienceFee: string;
  gstPct: string;
  gstAmount: string;
  totalPayable: string;
  /** ISO 4217, e.g. `"INR"` — `payments.currency`. */
  currency: string;
}

/** What M-12 hands back once a gateway order exists for a consultation. `gatewayKeyId` is the publishable key the client needs to open checkout; it is not a secret. */
export interface CreatedOrder {
  paymentId: string;
  gatewayOrderId: string;
  gatewayKeyId: string;
  breakdown: PaymentBreakdown;
}

export interface BookingPaymentPort {
  /** Price a consultation fee WITHOUT creating anything — backs the pre-booking quote a patient sees before committing to a slot. */
  quote(consultationFeeInr: string): Promise<PaymentBreakdown>;

  /**
   * Creates the `payments` row and the gateway order for a consultation that
   * already exists. Called INSIDE this module's booking transaction, so a
   * throw here rolls the consultation insert back and no orphan hold survives
   * — see `booking.service.ts#createBooking`.
   */
  createOrderForConsultation(input: { consultationId: string; consultationFeeInr: string }): Promise<CreatedOrder>;

  /** The payment attached to a consultation, or `null` if none exists yet. `status` is M-12's `payment_status` vocabulary (`created`/`pending`/`paid`/`failed`/`refunded`/`partially_refunded`). */
  getByConsultationId(consultationId: string): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null>;

  /**
   * *** THE METHOD THAT MAKES THE SWEEP SAFE. *** Asks the GATEWAY what
   * actually happened to a payment, rather than inferring it from a clock.
   * Tier 2 of `booking-slot-hold.service.ts` calls this before it will
   * release any hold that reached checkout — a hold with a live order is
   * never released on a blind timer, because the patient may be mid-3-D-
   * Secure at the moment the timer fires.
   */
  reconcileWithGateway(paymentId: string): Promise<{ status: string; changed: boolean }>;

  /**
   * Raises a refund against a captured payment. `isAutomatic: true` with
   * `initiatedByAdminId: null` is the in-policy cancellation refund
   * (`refunds.schema.ts`: "NULL for an automatic in-policy refund — that is
   * what distinguishes it from an admin-raised one"). `amount` is a decimal
   * string in rupees.
   */
  createRefund(input: {
    paymentId: string;
    amount: string;
    reason: string;
    initiatedByAdminId: string | null;
    isAutomatic: boolean;
  }): Promise<{ refundId: string; status: string }>;
}
