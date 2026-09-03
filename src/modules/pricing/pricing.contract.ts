/**
 * M-12.5's public surface. `backend/README.md` §2: "Each module exposes one
 * public surface, `<domain>.facade.ts`. No deep imports, no cross-module foreign
 * keys, no cross-module transactions." This file is the TYPE half of that
 * surface; `pricing.facade.ts` is the implementation.
 *
 * Every method is async and every value is JSON-safe (strings, numbers,
 * booleans, `Date`, `null`) so that the local call `modules/payment` makes today
 * can become a TCP call later without changing a single call site —
 * `backend/README.md`'s extraction path.
 *
 * DECIMAL STRINGS, NOT NUMBERS, for every money field. `numeric` columns come
 * back from `pg` as strings precisely so no precision is lost, and handing a
 * caller a `number` would invite it to do float arithmetic on a bill. See
 * `shared/money/money.util.ts`.
 *
 * ── WHO CALLS THIS ─────────────────────────────────────────────────────────
 *
 * `modules/payment`, and nothing else. The compile-time dependency runs
 * payment -> pricing and never back: pricing knows nothing about `payments`,
 * `refunds` or Razorpay, and takes every id it needs as an ARGUMENT. That is
 * what keeps the two modules free of a cycle while letting payment be the only
 * thing that talks to a gateway.
 */

import type { PlaceOfSupplyKind, PriceQuoteStatus, TaxMode, TaxTreatment } from '../../schema/enums.schema';
import type { DiscountRefusalReason } from './pricing-discount.contract';

/* -------------------------------------------------------------------------- */
/* The bill                                                                    */
/* -------------------------------------------------------------------------- */

/** One line of the bill. FR-7.2's "every component separately", as a view. */
export interface PricedComponentView {
  code: string;
  label: string;
  position: number;
  hsnSac: string | null;
  grossAmount: string;
  discountAmount: string;
  /** `platform`, `doctor`, or null where this line carries no discount. */
  discountBearer: string | null;
  taxableValue: string;
  taxTreatment: TaxTreatment;
  taxMode: TaxMode;
  taxRatePct: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal: string;
}

/** What actually happened to a discount code, applied or not. Null when none was offered. */
export interface DiscountView {
  applied: boolean;
  code: string;
  /** Null on a refusal — there is no instrument to name. */
  instrumentId: string | null;
  kind: string | null;
  label: string | null;
  /** What was actually taken off the bill. `"0.00"` on a refusal or an attribution-only referral. */
  amount: string;
  /**
   * The part of the promised discount NO LINE COULD BEAR, because the discount
   * exceeded the components whose bearer permits it.
   *
   * *** THE CHECKOUT MUST SHOW THE CAPPED FIGURE, NOT THE PROMISED ONE. *** A
   * 120.00 coupon meeting a 100.00 convenience fee is the ordinary case, not an
   * edge case — see `pricing-discount.contract.ts` on why the base is the whole
   * order's gross.
   */
  cappedAmount: string;
  /** true = a 0.00 discount BY DESIGN (an attribution-only referral), so the UI says "Referral applied". */
  attributionOnly: boolean;
  reason: DiscountRefusalReason | null;
  message: string | null;
}

/** Place of supply, as it will appear on the invoice. */
export interface PlaceOfSupplyView {
  stateCode: string;
  /** Resolved from the compiled-in GST table, so an old code still renders its name. */
  stateName: string | null;
  /** Recorded only. NEVER authoritative — the state code decides the tax. */
  pincode: string | null;
  kind: PlaceOfSupplyKind;
}

/** The supplier's own details, snapshotted onto the quote so moving the registration does not restate old invoices. */
export interface SupplierView {
  stateCode: string;
  gstin: string | null;
  legalName: string;
}

/**
 * A complete price. Everything the checkout screen shows comes from here; the
 * frontend calculates nothing.
 */
export interface PriceQuoteView {
  /** Null for a `preview`, which persists nothing. */
  quoteId: string | null;
  status: PriceQuoteStatus | null;
  currency: string;
  components: PricedComponentView[];

  grossTotal: string;
  discountTotal: string;
  /** FR-7.2's "subtotal before GST" — the sum of TAXABLE VALUES, not of nets. */
  taxableTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  /** *** THE AUTHORITATIVE AMOUNT. *** What the gateway order is created for. */
  totalPayable: string;

  placeOfSupply: PlaceOfSupplyView;
  supplier: SupplierView;
  discount: DiscountView | null;

  /**
   * FR-7.4: what the doctor receives, and the platform's deduction from it.
   *
   * *** NULL WHEN THE VIEW WAS REBUILT FROM STORED ROWS, AND THAT IS DELIBERATE. ***
   * `price_quote_components` stores the discount BEARER but not the PAYEE — the
   * payee is a commercial attribute, not a tax field, and the table has no
   * column for it. Reconstructing it from today's catalogue would break
   * `price-quote-components.schema.ts`'s snapshot rule ("an admin editing the
   * component catalogue tomorrow must not restate an invoice issued today"), and
   * guessing it from a component code would be worse.
   *
   * So a freshly priced quote reports both (the engine knows the payee), and a
   * re-read quote reports null. THE AUTHORITATIVE PAYOUT VIEW IS NOT THIS ONE:
   * it is `payment.mapper.ts#toDoctorPayoutView`, driven by
   * `payments.consultation_fee`, which FR-7.4 says the payout simply IS.
   */
  doctorPayout: string | null;
  platformDeduction: string | null;

  /** Null for a preview. After this the quote cannot be pinned. */
  expiresAt: Date | null;
  /**
   * `totalPayable` is 0.00.
   *
   * *** RAZORPAY WILL NOT CREATE A ZERO-VALUE ORDER. *** A caller must not send
   * this to a gateway; `createOrderForConsultation` refuses it with
   * `PRICING_ZERO_VALUE_ORDER` rather than letting the gateway answer with
   * something opaque.
   */
  fullyDiscounted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** Everything pricing needs to compute a bill. Every field but the fee is optional. */
export interface QuoteRequest {
  consultationFeeInr: string;
  /**
   * The RECIPIENT's GST state code. Optional here and defaulted from the tax
   * profile when absent — which is a SUPPORTED path, not a degraded one, and is
   * also the legally conservative one: it yields CGST+SGST and never a wrongly
   * claimed IGST.
   */
  placeOfSupplyStateCode?: string | null;
  /** Recorded only. `suggestStateCodeForPincode` may pre-select a state from it; nothing else reads it. */
  placeOfSupplyPincode?: string | null;
  discountCode?: string | null;
  patientId?: string | null;
  doctorId?: string | null;
  specialtyId?: string | null;
  /** Reaches the discount port unchanged; promotions may price an instant consult differently. */
  mode?: 'scheduled' | 'instant';
  /** Present only where the caller already has a consultation — lets the discount be RESERVED rather than merely evaluated. */
  consultationId?: string | null;
}

/** What a refund apportionment produced. Sums to `amount` exactly, by construction. */
export interface RefundApportionmentComponent {
  code: string;
  amount: string;
  taxableValue: string;
  /** The rate that applied on the ORIGINAL invoice, not today's. */
  taxRatePct: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
}

export interface RefundApportionment {
  /** The total apportioned. Equal to the requested amount, or to the exact remainder when the request met or exceeded it. */
  amount: string;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  components: RefundApportionmentComponent[];
  /** True when the request met or exceeded the remainder, so the per-component EXACT remainders were used. */
  exhaustive: boolean;
}

/* -------------------------------------------------------------------------- */

export interface PricingContract {
  /** Prices a bill WITHOUT persisting anything. Nothing is reserved, nothing expires. */
  preview(request: QuoteRequest): Promise<PriceQuoteView>;

  /**
   * Prices a bill and writes it as a `draft`, reserving any discount when a
   * consultation is already known.
   *
   * The returned `quoteId` is what a caller pins against. Until it is pinned the
   * price is not committed to anything.
   */
  createQuote(request: QuoteRequest): Promise<PriceQuoteView>;

  /**
   * *** FREEZES THE PRICE. *** One conditional UPDATE:
   * `status='pinned' WHERE id=$1 AND status='draft' AND expires_at > now()`.
   *
   * Razorpay fixes an order's amount at creation, so the price MUST be frozen
   * before the order exists. Zero rows matched -> `PRICING_QUOTE_EXPIRED`, and
   * the caller re-quotes.
   */
  pin(input: { quoteId: string; consultationId: string; patientId?: string | null }): Promise<PriceQuoteView>;

  /**
   * Prices, persists and pins in one call, for a caller that has a consultation
   * but no quote.
   *
   * *** THIS IS A SUPPORTED PATH, NOT A FALLBACK. *** It is how
   * `createOrderForConsultation` guarantees that no call site can produce an
   * unpriced payment, and it defaults the place of supply to the org's own
   * registered state — the legally conservative choice.
   */
  materialiseAndPin(
    request: QuoteRequest & { consultationId: string },
  ): Promise<PriceQuoteView>;

  /** The quote a payment was priced from, or null. */
  getQuote(quoteId: string): Promise<PriceQuoteView | null>;

  /**
   * *** THE AUTHORITATIVE CAPTURED TOTALS, BATCHED. ***
   *
   * The one query behind the collapsed `capturedTotalPaise` helper in
   * `modules/payment`. Returns a map of quote id -> `total_payable`; a quote id
   * that is absent from the map does not exist, which a caller must treat as an
   * error rather than as "fall back to re-computing".
   */
  getQuoteTotals(quoteIds: readonly string[]): Promise<Record<string, string>>;

  /** Marks a quote consumed and confirms the discount reservation. Idempotent: a replayed capture is a no-op. */
  markConsumed(input: {
    quoteId: string;
    consultationId: string | null;
    paymentId: string;
  }): Promise<{ changed: boolean }>;

  /** Takes a quote out of play and RELEASES the discount reservation. Idempotent. */
  abandon(input: {
    quoteId: string;
    consultationId: string | null;
    reason: string;
    status?: 'expired' | 'superseded';
  }): Promise<{ changed: boolean }>;

  /**
   * Takes the next s.31 invoice serial.
   *
   * *** CALLED AT CAPTURE, NEVER AT INTENT. *** A checkout that is merely
   * started must not burn a number, because a gap in a statutory series is its
   * own compliance question.
   */
  allocateInvoiceNumber(at?: Date): Promise<{ number: string; issuedAt: Date }>;

  /**
   * Takes the next s.34 credit-note serial.
   *
   * *** CALLED WHEN A REFUND REACHES `processed`, NEVER AT INTENT. *** A refund
   * the gateway rejects must not burn a number.
   */
  allocateCreditNoteNumber(at?: Date): Promise<{ number: string; issuedAt: Date }>;

  /**
   * Splits a refund across the original quote's components and backs the tax out
   * of each share at that line's SNAPSHOTTED rate.
   *
   * `alreadyRefundedByCode` is what has already gone back per component, so the
   * weights are each line's remaining capacity. When `requestedAmount` meets or
   * exceeds the remainder, the EXACT per-component remainders are used instead
   * of a percentage, so "refund the rest" lands precisely on zero.
   */
  apportionRefund(input: {
    quoteId: string;
    requestedAmount: string;
    alreadyRefundedByCode?: Record<string, string>;
  }): Promise<RefundApportionment>;

  /**
   * What a refund of `pct` percent of the CAPTURED TOTAL comes to.
   *
   * *** THE BASE IS THE CAPTURED TOTAL, NOT THE CONSULTATION FEE. *** See
   * `pricing-refund.service.ts` — this is a commercial change and it needs
   * sign-off.
   */
  refundAmountForPct(input: { quoteId: string; pct: number }): Promise<string>;

  /** Whether a pricing catalogue has been configured at all. `PaymentConfigService.update` gates on this. */
  hasCatalogue(): Promise<boolean>;
}
