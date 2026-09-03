/**
 * *** THE PRICING -> PROMOTIONS SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/promotion` is being built in a PARALLEL WORKTREE and does not exist
 * in this one, so a direct `import from '../promotion/promotion.contract'`
 * would not compile. This file declares the interface LOCALLY and binds it to
 * the `DISCOUNT_PORT` DI token — precisely the pattern
 * `booking/booking-payment.contract.ts` uses for `BookingPaymentPort` /
 * `BOOKING_PAYMENT_PORT`, `search/search-ai.contract.ts` for `SEARCH_AI_PORT`,
 * and `document/document-storage.contract.ts` for `DOCUMENT_STORAGE_PORT`.
 *
 * The types below are a VERBATIM mirror of the shape the promotions worktree is
 * exporting. Because TypeScript is structural, its facade will satisfy
 * `DiscountPort` with no adapter, no cast and no change on either side.
 *
 * *** THE SHAPE IS FROZEN. *** Do not rename a field, do not tighten a type, do
 * not add a required argument. If the promotions module's signature ever
 * changes, change it HERE too — a structural mismatch will surface as a `tsc`
 * error at the binding in `pricing.module.ts`, which is the point.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `DISCOUNT_PORT` FROM
 * `UnavailableDiscountProvider` TO THE PROMOTIONS FACADE IN `pricing.module.ts`.
 * *** That is the whole handover: one line in the `providers` array.
 *
 * Do NOT "fix" this into a cross-module import of `modules/promotion`:
 * `backend/README.md` §2 says a module's only public surface is its facade,
 * resolved through DI, and the token is exactly that.
 */

/** DI token. `pricing.module.ts` binds it to the null object until promotions merges. */
export const DISCOUNT_PORT = Symbol('DISCOUNT_PORT');

/**
 * Everything promotions needs to decide whether a code applies, and to what.
 *
 * Money fields are DECIMAL STRINGS, never numbers — `numeric(10,2)` columns come
 * back from `pg` as strings precisely so no precision is lost, and handing a
 * float across a module boundary invites the caller to do float arithmetic on a
 * bill.
 */
export interface DiscountOrderContext {
  patientId: string;
  doctorId: string | null;
  specialtyId: string | null;
  /** Every component, PRE-discount and PRE-tax. */
  components: ReadonlyArray<{ code: string; label: string; grossAmount: string }>;
  /**
   * THE BASE: what the minimum-order rule is tested against and the percentage
   * taken of.
   *
   * *** PRICING NAMES THIS AS THE WHOLE ORDER'S GROSS — the sum of every
   * component before discount and before tax. *** For the seeded catalogue at a
   * 500.00 fee that is 600.00, not the 100.00 convenience fee.
   *
   * The alternative — naming only the platform's own fee — was considered and
   * rejected on two grounds. A minimum-order rule ("valid above 500.00") is a
   * statement about the ORDER, and testing it against a 100.00 convenience fee
   * would make every sensible minimum unsatisfiable. And a patient reading "20%
   * off" expects 20% of what they are paying; 20% of a fee they cannot see is
   * not a discount anyone would recognise.
   *
   * The consequence is deliberate and handled: a percentage of the whole order
   * routinely EXCEEDS the lines that may bear it (20% of 600.00 is 120.00
   * against a 100.00 convenience fee). Placing that amount — and capping it — is
   * pricing's job, not promotions': see `pricing.engine.ts#placeDiscount` and
   * `PRICING_DISCOUNT_OVERFLOW_RULE`. The port returns ONE amount; incidence is
   * decided here, recorded per component in
   * `price_quote_components.discount_bearer`, and never allowed to reach the
   * doctor's fee by accident.
   *
   * Tax is excluded from the base on purpose: a discount is applied BEFORE tax,
   * so taking a percentage of a tax-inclusive figure would discount the tax too.
   */
  discountableAmount: string;
  currency: string;
  mode: 'scheduled' | 'instant';
}

/** Why a code did not apply. One code per refusal so the UI can say something specific rather than "invalid code". */
export type DiscountRefusalReason =
  | 'CODE_NOT_USABLE'
  | 'MIN_ORDER_NOT_MET'
  | 'TOTAL_LIMIT_REACHED'
  | 'USER_LIMIT_REACHED'
  | 'DISTINCT_USER_LIMIT_REACHED'
  | 'SELF_REFERRAL'
  | 'SELF_AFFILIATE'
  | 'NOT_A_FIRST_CONSULTATION'
  | 'ALREADY_REFERRED'
  | 'CURRENCY_MISMATCH'
  | 'ALREADY_APPLIED'
  | 'TOO_MANY_ATTEMPTS'
  | 'UNAVAILABLE';

export interface DiscountRefusal {
  applicable: false;
  reason: DiscountRefusalReason;
  message: string;
  requiredMinOrder?: string;
}

export interface DiscountQuote {
  applicable: true;
  instrumentId: string;
  kind: 'coupon' | 'voucher' | 'referral' | 'referral_reward' | 'affiliate';
  code: string;
  label: string;
  discountAmount: string;
  residualDiscountable: string;
  /** true = a 0.00 discount BY DESIGN (attribution-only referral), so the UI says "Referral applied". */
  attributionOnly: boolean;
  /** true = residual is 0.00. Razorpay will not create a zero-value order — YOU must handle this. */
  fullyDiscounted: boolean;
}

export type DiscountEvaluation = DiscountQuote | DiscountRefusal;

export interface DiscountReservation {
  reservationId: string;
  instrumentId: string;
  code: string;
  discountAmount: string;
  expiresAt: Date;
}

export type DiscountReservationResult =
  | ({ reserved: true } & DiscountReservation)
  | ({ reserved: false } & DiscountRefusal);

export interface DiscountPort {
  preview(code: string, context: DiscountOrderContext): Promise<DiscountEvaluation>;
  reserve(input: {
    code: string;
    context: DiscountOrderContext;
    consultationId: string;
    holdExpiresAt: Date;
  }): Promise<DiscountReservationResult>;
  confirm(input: {
    consultationId: string;
    paymentId: string;
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<{ reservationId: string; status: 'consumed' } | null>;
  release(input: { consultationId: string; reason: string }): Promise<{ reservationId: string; status: 'released' } | null>;
  getForConsultation(consultationId: string): Promise<DiscountReservation | null>;
}
