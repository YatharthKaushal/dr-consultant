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

/**
 * FR-7.2's bill: "the patient bill shows every component separately: doctor
 * consultation fee, convenience fee, subtotal before GST, GST, and final
 * payable."
 *
 * *** EVERY FIELD ADDED BELOW THE ORIGINAL SEVEN IS OPTIONAL, AND THAT IS
 * LOAD-BEARING RATHER THAN TENTATIVE. *** They are POPULATED ON EVERY RESPONSE
 * at runtime. They are declared optional purely so that booking's and M-13's
 * blind mirrors of this interface — written in parallel worktrees that cannot
 * see this file — keep compiling: a structural type with extra optional members
 * is still assignable to one without them.
 *
 * Read them as required-in-practice. A consumer that has been updated may rely
 * on them; one that has not simply ignores them.
 */
export interface PaymentBreakdown {
  consultationFee: string;      // decimal string, rupees
  convenienceFeePct: string;
  convenienceFee: string;
  gstPct: string;
  gstAmount: string;
  /**
   * *** THE AUTHORITATIVE AMOUNT. ***
   *
   * Formerly documented as "the sum; there is deliberately no stored total
   * column". That is now true only of LEGACY rows. A payment priced by the
   * engine carries a `price_quote_id`, and its total is
   * `price_quotes.total_payable` — an immutable stored column, because once a
   * bill can carry a discount or a tax-inclusive component the three legacy
   * columns become a lossy summary and re-summing them computes a DIFFERENT
   * number. See `payment-money.util.ts#capturedTotalPaise`.
   */
  totalPayable: string;
  currency: string;

  /** FR-7.2's "subtotal before GST" — the sum of every component's TAXABLE VALUE, not of their nets. */
  subtotal?: string;
  /** `price_quotes.id`. Present on every engine-priced bill; absent only on a legacy re-derivation. */
  quoteId?: string | null;
  /** The recipient's state, which decides CGST+SGST versus IGST. `pincode` is recorded only and never authoritative. */
  placeOfSupply?: { stateCode: string; stateName: string | null; pincode: string | null; kind: string };
  /**
   * The tax, split by head.
   *
   * CGST and SGST are a SPLIT of one computed figure, never two independent
   * roundings — `2 x round(v x 9%)` is not `round(v x 18%)`, and splitting the
   * rate would make an identical catalogue price cost a different total in a
   * different state. The invoice prints "CGST 9% / SGST 9%" as LABELS while
   * these amounts sum to the tax actually charged.
   */
  taxSplit?: { cgst: string; sgst: string; igst: string };
  /** What a discount code actually did, applied or refused. Null when none was offered. */
  discount?: {
    applied: boolean;
    code: string;
    amount: string;
    /** The part of the promised discount no line could bear. The checkout must show the CAPPED figure. */
    cappedAmount: string;
    reason: string | null;
    message: string | null;
  } | null;
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
  /**
   * Quote a bill — booking shows this before checkout.
   *
   * *** `options` IS OPTIONAL, WHICH IS WHAT KEEPS THIS ADDITIVE. ***
   * `(fee: string, opts?: O) => R` IS assignable to a blind mirror declaring
   * `(fee: string) => R`, so booking and M-13 compile untouched.
   *
   * Persists nothing unless `materialise: true`, which writes a `draft` quote
   * and returns its id in `breakdown.quoteId` — hand that to
   * `createOrderForConsultation` to guarantee the price shown is the price
   * charged.
   */
  quote(
    consultationFeeInr: string,
    options?: {
      placeOfSupplyStateCode?: string;
      placeOfSupplyPincode?: string;
      discountCode?: string | null;
      patientId?: string | null;
      doctorId?: string | null;
      /** Reaches the discount port unchanged — a per-specialty cap needs this to evaluate a code at all. */
      specialtyId?: string | null;
      /** Promotions may price an instant consult differently. Defaults to `'scheduled'` downstream when omitted. */
      mode?: 'scheduled' | 'instant';
      materialise?: boolean;
    },
  ): Promise<PaymentBreakdown>;

  /**
   * Creates the payments row and the Razorpay order. Caller supplies an existing
   * consultationId.
   *
   * `consultationFeeInr` IS KEPT REQUIRED so M-13's blind mirror compiles
   * unchanged. Everything added is optional.
   *
   * *** OMITTING `quoteId` IS SUPPORTED, NOT DEGRADED. *** The quote is
   * materialised and pinned inline from the fee plus the org's own registered
   * state — which is also the legally conservative place of supply, since it
   * yields CGST+SGST and never a wrongly-claimed IGST. No call site can produce
   * an unpriced payment.
   */
  createOrderForConsultation(input: {
    consultationId: string;
    consultationFeeInr: string;
    quoteId?: string;
    placeOfSupplyStateCode?: string;
    placeOfSupplyPincode?: string;
    /**
     * *** THREADED INTO `materialiseAndPin`, NOT JUST `quote`. ***
     * A code priced at `quote()`'s preview time must be RESERVED here, at the
     * same call that pins the price — otherwise every real booking prices and
     * pins with these null, and a discount typed at preview never actually
     * applies at charge time. See `pricing.service.ts#tryReserveForPinned`.
     */
    discountCode?: string | null;
    /** Also the per-user/per-doctor cap key `tryReserveForPinned` reserves against — omitting it reserves against `''`, shared by every patient. */
    patientId?: string | null;
    doctorId?: string | null;
    specialtyId?: string | null;
    mode?: 'scheduled' | 'instant';
  }): Promise<CreatedOrder>;
  /** Current status, for booking to gate on. */
  getByConsultationId(consultationId: string): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null>;
  /**
   * The handles a patient needs to OPEN checkout on a payment that already
   * exists — `null` when there is nothing to pay.
   *
   * Additive, and it exists because FR-10.2 orders the instant flow
   * request -> accept -> pay: the order is minted on the DOCTOR's accept, so
   * the patient never sees `createOrderForConsultation`'s return value and
   * would otherwise have no way to reach the gateway at all.
   *
   * Neither handle is secret — `gatewayKeyId` is Razorpay's publishable key.
   * Ownership is NOT checked here, exactly as it is not in
   * `getByConsultationId`; the caller authorises.
   */
  getCheckoutHandles(consultationId: string): Promise<CreatedOrder | null>;
  /** Ask the gateway what actually happened — for the reconciled hold sweep. Never trusts local state. */
  reconcileWithGateway(paymentId: string): Promise<{ status: string; changed: boolean }>;
  /**
   * Booking calls this on an in-policy cancellation. `initiatedByAdminId: null`
   * = automatic.
   *
   * *** `refundPct` IS PART OF THIS CONTRACT, NOT AN EXTRA BOOKING SMUGGLES IN. ***
   *
   * It was missing here while `booking-payment.contract.ts` — the blind mirror
   * this file exists to be checked against — declared it, and while
   * `RefundService.createRefund` read it. Booking's calls kept working only
   * because `PaymentFacade` forwards its argument object BY REFERENCE, so a
   * property this type does not mention survived the trip anyway. The field that
   * redefines the refund base was travelling through a hole in the very contract
   * whose stated job is to make a signature drift "surface as a `tsc` error
   * rather than as a runtime surprise" — and any refactor of the facade into an
   * explicit destructure would have silently reverted the base change to the
   * consultation fee, on live cancellations, with nothing red.
   *
   * A caller typed against THIS interface also could not ask for the new base at
   * all: an object literal carrying `refundPct` was an excess-property error.
   */
  createRefund(input: {
    paymentId: string;
    amount: string;
    reason: string;
    initiatedByAdminId: string | null;
    isAutomatic: boolean;
    /**
     * *** OPTIONAL, AND IT REDEFINES THE REFUND BASE. ***
     *
     * When present AND the payment was priced by the pricing engine, `amount` is
     * ignored and the refund is computed as this percentage of the CAPTURED
     * TOTAL rather than of the consultation fee — a 100% tier returns the whole
     * 618.00 instead of the 500.00 fee.
     *
     * *** THIS IS A COMMERCIAL CHANGE, NOT A BUG FIX, AND IT NEEDS THE CLIENT'S
     * SIGN-OFF. *** See `refund.service.ts` and `pricing-refund.service.ts`.
     *
     * `amount` is still authoritative for a LEGACY payment (no quote), which has
     * no per-component breakdown to apportion against.
     */
    refundPct?: number;
  }): Promise<{ refundId: string; status: string }>;
}
