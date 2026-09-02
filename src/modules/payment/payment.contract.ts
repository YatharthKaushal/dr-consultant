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
