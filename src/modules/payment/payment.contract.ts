/**
 * M-12's public surface. `backend/README.md` §2: "Each module exposes one
 * public surface, `<domain>.facade.ts`. No deep imports, no cross-module
 * foreign keys, no cross-module transactions." This file is the TYPE half of
 * that surface; `payment.facade.ts` is the implementation.
 *
 * *** THIS SHAPE IS FIXED. M-11 (booking) IS BEING BUILT AGAINST IT IN A
 * PARALLEL WORKTREE, BLIND. *** Do not rename a field, do not tighten a type,
 * do not add a required argument. Anything additive that M-11 does not know
 * about is fine; anything else breaks a module that cannot see this file yet.
 *
 * Every method is async and every value is JSON-safe (strings, numbers,
 * booleans, `Date`, `null`) so that the local call M-11 makes today can become
 * a TCP call later without changing a single call site — `backend/README.md`'s
 * extraction path.
 *
 * DECIMAL STRINGS, NOT NUMBERS, for every money field. `numeric` columns come
 * back from `pg` as strings precisely so no precision is lost, and handing a
 * caller a `number` would invite it to do float arithmetic on a bill. See
 * `payment-money.util.ts`.
 */

/** FR-7.2's bill: "the patient bill shows every component separately: doctor consultation fee, convenience fee, subtotal before GST, GST, and final payable." */
export interface PaymentBreakdown {
  consultationFee: string;      // decimal string, rupees
  convenienceFeePct: string;
  convenienceFee: string;
  gstPct: string;
  gstAmount: string;
  totalPayable: string;         // the sum; there is deliberately no stored total column
  currency: string;
}

export interface CreatedOrder {
  paymentId: string;            // our payments.id
  gatewayOrderId: string;
  gatewayKeyId: string;         // the publishable key the client needs for checkout
  breakdown: PaymentBreakdown;
}

/* -------------------------------------------------------------------------- */
/* The paid -> scheduled signal                                               */
/* -------------------------------------------------------------------------- */

/**
 * *** EMITTED WHEN A PAYMENT IS CAPTURED. Booking listens and takes the
 * consultation live. ***
 *
 * WHY AN EVENT AND NOT A CALL. The compile-time dependency runs
 * booking -> payment (`booking.module.ts` imports `PaymentFacade` and binds it
 * at `BOOKING_PAYMENT_PORT`). Payment calling `BookingFacade.confirmPayment`
 * directly would close that into a module cycle. An event inverts the runtime
 * direction while leaving the compile-time direction alone: payment knows
 * nothing about booking, and booking imports this name from payment's public
 * surface — the same direction it already depends in.
 *
 * DELIVERY IS BEST-EFFORT, AND THAT IS SAFE. `@nestjs/event-emitter` is
 * in-process and synchronous; a listener that throws is caught and logged by
 * the framework (`suppressErrors` defaults to true), and a process that dies
 * between the capture and the listener loses the notification entirely.
 * Neither loses the booking, because this event is a LATENCY OPTIMISATION over
 * a durable backstop that already works: M-11's two-tier sweep asks the gateway
 * about every expired hold with an order, and confirms the ones that came back
 * paid. Without this event a paid booking still goes live — just up to
 * `booking.slot_hold_minutes` later, with the patient watching a
 * `pending_payment` screen. With it, promptly. Nothing here is the only thing
 * standing between a captured payment and a live consultation.
 *
 * Correspondingly: DO NOT move a money decision into a listener for this. The
 * event says what already happened and is already committed.
 */
export const PAYMENT_CAPTURED_EVENT = 'payment.captured';

/** Payload of {@link PAYMENT_CAPTURED_EVENT}. JSON-safe, like every value on this surface. */
export interface PaymentCapturedEvent {
  /** Our `payments.id`. */
  paymentId: string;
  /** The consultation to take live — `consultations.id`. */
  consultationId: string;
  /** Razorpay's payment id, for correlating logs against the gateway dashboard. */
  gatewayPaymentId: string;
}

export interface PaymentContract {
  /** Quote a bill WITHOUT persisting anything — booking shows this before checkout. */
  quote(consultationFeeInr: string): Promise<PaymentBreakdown>;
  /** Creates the payments row and the Razorpay order. Caller supplies an existing consultationId. */
  createOrderForConsultation(input: { consultationId: string; consultationFeeInr: string }): Promise<CreatedOrder>;
  /** Current status, for booking to gate on. */
  getByConsultationId(consultationId: string): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null>;
  /** Ask the gateway what actually happened — for the reconciled hold sweep. Never trusts local state. */
  reconcileWithGateway(paymentId: string): Promise<{ status: string; changed: boolean }>;
  /** Booking calls this on an in-policy cancellation. `initiatedByAdminId: null` = automatic. */
  createRefund(input: { paymentId: string; amount: string; reason: string; initiatedByAdminId: string | null; isAutomatic: boolean }): Promise<{ refundId: string; status: string }>;
}
