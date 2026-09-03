/**
 * M-12.5's constants: the `app_config` keys it OWNS, their compiled-in
 * fallbacks, the seeded component catalogue, its error-code vocabulary and its
 * `audit_log.entity_type` values.
 *
 * Structure copied from `payment.constants.ts` and `search.constants.ts` — keys
 * + defaults + seed source in one place, so the admin write path, the read
 * fallbacks and the seed can never drift apart.
 */

import type { PlaceOfSupplyKind, TaxMode, TaxTreatment } from '../../schema/enums.schema';

/** `audit_log.entity_type` values this module writes. */
export const PRICING_AUDIT_ENTITY_TYPES = {
  /** One `pricing.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'pricing_config',
  /** A `price_quotes` row. */
  QUOTE: 'price_quote',
  /** An allocated invoice or credit-note serial. `entity_id` is the number. */
  DOCUMENT_SERIAL: 'pricing_document_serial',
} as const;

/** Error codes this module returns in `{ code, message }` bodies. */
export const PRICING_ERROR_CODES = {
  PRICING_QUOTE_NOT_FOUND: 'PRICING_QUOTE_NOT_FOUND',
  /**
   * *** THE PIN GUARD. *** The quote was not `draft`, or its `expires_at` had
   * passed, at the instant the conditional UPDATE ran. Both collapse to one
   * code on purpose: from the caller's side they are the same event — "this
   * price is no longer available, re-quote" — and distinguishing them would
   * require a second read that could itself go stale.
   */
  PRICING_QUOTE_EXPIRED: 'PRICING_QUOTE_EXPIRED',
  /** A quote was consumed twice, or abandoned after being consumed. */
  PRICING_QUOTE_NOT_PINNED: 'PRICING_QUOTE_NOT_PINNED',
  /** A place-of-supply state code the GST portal does not issue, or one that is no longer selectable. */
  PRICING_STATE_CODE_INVALID: 'PRICING_STATE_CODE_INVALID',
  /** The component catalogue is structurally unusable and no compiled-in fallback could stand in. */
  PRICING_CATALOGUE_INVALID: 'PRICING_CATALOGUE_INVALID',
  /**
   * *** THE FULLY-DISCOUNTED ORDER. *** Razorpay will not create an order for
   * zero. A consultation whose whole bill is discounted away needs a no-payment
   * path, which this release does not have — so it is refused loudly here rather
   * than failing opaquely at the gateway.
   */
  PRICING_ZERO_VALUE_ORDER: 'PRICING_ZERO_VALUE_ORDER',
  /** A `PUT /admin/pricing/config` body whose value fails this module's own shape check. */
  CONFIG_INVALID: 'PRICING_CONFIG_INVALID',
  /** A `PUT /admin/pricing/config` naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'PRICING_CONFIG_KEY_NOT_OWNED',
} as const;
export type PricingErrorCode = (typeof PRICING_ERROR_CODES)[keyof typeof PRICING_ERROR_CODES];

/**
 * The `app_config` keys M-12.5 OWNS.
 *
 * Exactly three, and the split is deliberate:
 *
 *   `pricing.components`         WHAT is charged — the ordered catalogue, each
 *                                line with its own tax treatment. This is the
 *                                key that lets the client's CA rule on FR-7.3
 *                                versus Notification 12/2017 entry 74 without a
 *                                migration.
 *   `pricing.tax_profile`        WHO is charging — the org's registered state,
 *                                GSTIN and legal name, plus the default place of
 *                                supply. Decides CGST+SGST versus IGST.
 *   `pricing.quote_ttl_minutes`  HOW LONG a quoted price stands.
 *
 * `payment-config.service.ts` enforces the mirror-image allow-list for
 * `payments.*`; this one enforces it for `pricing.*`. One shared `app_config`
 * table must never become one shared permission.
 */
export const PRICING_CONFIG_KEYS = {
  COMPONENTS: 'pricing.components',
  TAX_PROFILE: 'pricing.tax_profile',
  QUOTE_TTL_MINUTES: 'pricing.quote_ttl_minutes',
} as const;
export type PricingConfigKey = (typeof PRICING_CONFIG_KEYS)[keyof typeof PRICING_CONFIG_KEYS];

export const PRICING_CONFIG_KEY_LIST: readonly PricingConfigKey[] = Object.values(PRICING_CONFIG_KEYS);

/* -------------------------------------------------------------------------- */
/* The component catalogue                                                     */
/* -------------------------------------------------------------------------- */

/** How a component's gross amount is derived. Mirrors `price_quote_components.basis`. */
export type ComponentBasis = 'pass_through' | 'percent_of';

/**
 * Where a `pass_through` amount comes from.
 *
 *   `consultation_fee`  the fee the caller supplied — the doctor's own price.
 *   `fixed`             a flat amount from the catalogue itself.
 */
export type ComponentSource = 'consultation_fee' | 'fixed';

/**
 * WHOSE money this line is, which is the whole of FR-7.4.
 *
 * `doctor` lines sum to the payout; `platform` lines are the platform's revenue.
 * Kept separate from `discountBearer` because they answer different questions:
 * this one is "who is owed this", the other is "whose money funds a discount on
 * it". A line can be the doctor's and still be undiscountable, which is exactly
 * the seeded default.
 */
export type ComponentPayee = 'doctor' | 'platform';

/**
 * WHOSE money a discount on this line comes out of, or `null` for "this line is
 * never discounted".
 *
 * *** THE SEEDED CATALOGUE LEAVES THE DOCTOR'S FEE UNDISCOUNTABLE, AND THAT IS A
 * MONEY RULE, NOT A DEFAULT. *** FR-7.4 promises the doctor the full fee with
 * zero platform deduction. Funding a promotion from the doctor's pocket would
 * break that silently — the payout would simply be smaller and nothing would
 * say why. Setting a `doctor` bearer here is the ONLY way to make that happen,
 * it is recorded per component in `price_quote_components.discount_bearer`, and
 * it needs the client's commercial sign-off.
 */
export type ComponentDiscountBearer = 'platform' | 'doctor';

/** One line of the catalogue. Every field here is snapshotted onto the quote at pricing time and never looked up again. */
export interface PricingComponentSpec {
  /** Stable machine key, `varchar(40)`. Also how a refund apportions back onto lines. */
  code: string;
  /** What the patient reads on the bill, `varchar(80)`. */
  label: string;
  /** Display and apportionment order, and the deterministic tie-break in a refund split. */
  position: number;
  /** Service accounting code for the invoice. Null until the client's CA supplies one. */
  hsnSac: string | null;
  basis: ComponentBasis;
  /** `pass_through` only. */
  source?: ComponentSource;
  /** `pass_through` + `fixed` only. A `numeric(10,2)`-shaped rupee string. */
  fixedAmount?: string;
  /** `percent_of` only. A `numeric(5,2)`-shaped percentage string. */
  basisPct?: string;
  /**
   * `percent_of` only. The component codes whose GROSS this rate is applied to.
   * Every code must belong to a component at a LOWER position, so one pass in
   * position order resolves every reference — validated, not assumed.
   */
  basisCodes?: string[];
  taxTreatment: TaxTreatment;
  taxMode: TaxMode;
  /** A `numeric(5,2)`-shaped percentage string. Must be `"0.00"` when `taxTreatment` is `exempt`. */
  taxRatePct: string;
  payee: ComponentPayee;
  discountBearer?: ComponentDiscountBearer | null;
}

/**
 * *** THE SEEDED CATALOGUE. FR-7.2's bill, with the orthodox GST reading. ***
 *
 * Doctor fee EXEMPT, convenience fee TAXABLE at 18%: 500 + 100 + 18 = 618.
 *
 * That is the orthodox reading of Notification 12/2017 entry 74, which exempts
 * healthcare services by an authorised medical practitioner while leaving a
 * platform's own service fee taxable — the same reading
 * `price-quote-components.schema.ts` records.
 *
 * *** IT IS NOT WHAT FR-7.3 SAYS. *** FR-7.3's worked example taxes BOTH
 * components and totals 708. Configure both as `taxable` at 18% and this engine
 * reproduces 708 exactly, with the doctor's payout still 500 and the platform
 * deduction still 0. Which of the two is correct is a question for the client's
 * CA (SRS §8), and the entire point of making the treatment per-component and
 * stored is that answering it is a configuration change, not a migration.
 *
 * Neither figure is tax advice.
 */
export const PRICING_DEFAULT_COMPONENTS: readonly PricingComponentSpec[] = [
  {
    code: 'doctor_fee',
    label: 'Doctor consultation fee',
    position: 1,
    hsnSac: null,
    basis: 'pass_through',
    source: 'consultation_fee',
    taxTreatment: 'exempt',
    // An exempt line cannot be inclusive — there is no embedded tax to back out,
    // and the database refuses the combination
    // (`price_quote_components_exempt_is_not_inclusive`).
    taxMode: 'exclusive',
    taxRatePct: '0.00',
    payee: 'doctor',
    // *** FR-7.4. *** Never discounted, so a promotion can never reduce the payout.
    discountBearer: null,
  },
  {
    code: 'convenience_fee',
    label: 'Convenience fee',
    position: 2,
    hsnSac: null,
    basis: 'percent_of',
    basisPct: '20.00',
    basisCodes: ['doctor_fee'],
    taxTreatment: 'taxable',
    taxMode: 'exclusive',
    taxRatePct: '18.00',
    payee: 'platform',
    discountBearer: 'platform',
  },
];

/**
 * FR-7.3's catalogue: BOTH components taxable at 18%, which is the reading the
 * SRS's own worked example encodes (500 -> 100 -> 600 -> 108 -> 708).
 *
 * Exported so the acceptance test can state FR-7.3 as CONFIGURATION rather than
 * as a second code path, and so an admin can be shown the exact catalogue that
 * produces the SRS's numbers if the CA rules that way.
 */
export const PRICING_FR73_COMPONENTS: readonly PricingComponentSpec[] = [
  { ...PRICING_DEFAULT_COMPONENTS[0], taxTreatment: 'taxable', taxRatePct: '18.00' },
  { ...PRICING_DEFAULT_COMPONENTS[1] },
];

/* -------------------------------------------------------------------------- */
/* The tax profile                                                             */
/* -------------------------------------------------------------------------- */

/** WHO is charging, and from where. Decides CGST+SGST versus IGST on every bill. */
export interface PricingTaxProfile {
  /** The org's own GST registration state. `char(2)`, snapshotted onto every quote. */
  registeredStateCode: string;
  /** 15 characters, or null until the client supplies it. Printed on the invoice. */
  gstin: string | null;
  /** The registered legal name, as it must appear on a tax invoice. */
  legalName: string;
  /**
   * *** THE LEGALLY CONSERVATIVE DEFAULT. ***
   *
   * Used when a caller supplies no place of supply — which is a SUPPORTED path,
   * not a degraded one. It defaults to the org's OWN registered state, so the
   * bill comes out CGST+SGST.
   *
   * That direction is deliberate. Charging CGST+SGST where IGST was due is a
   * misallocation between heads that is corrected by amending a return.
   * Charging IGST where CGST+SGST was due means claiming an inter-state supply
   * that did not happen, which is the worse error to have to explain. When the
   * recipient's state is unknown, the conservative answer is "same state".
   */
  defaultPlaceOfSupplyStateCode: string;
}

/**
 * Compiled-in fallback profile.
 *
 * *** PLACEHOLDERS. THE CLIENT MUST SET THESE BEFORE ISSUING A REAL INVOICE. ***
 * An invoice carrying a null GSTIN and the legal name below is not a valid tax
 * invoice. They are compiled in so the mechanism is demonstrable end to end on
 * day one, exactly as `PAYMENT_CONFIG_FALLBACKS` is, and they are editable from
 * the admin panel with no release.
 *
 * `27` is Maharashtra. It is a stand-in for "the client's registered state", not
 * a claim about where the client is registered.
 */
export const PRICING_DEFAULT_TAX_PROFILE: PricingTaxProfile = {
  registeredStateCode: '27',
  gstin: null,
  legalName: 'Doctor Consultation Platform',
  defaultPlaceOfSupplyStateCode: '27',
};

/* -------------------------------------------------------------------------- */
/* Quote lifetime                                                              */
/* -------------------------------------------------------------------------- */

/**
 * *** 15 MINUTES, DELIBERATELY SHORTER THAN `booking.slot_hold_minutes` (20). ***
 *
 * The two clocks are not independent. A patient holds a slot for 20 minutes
 * while they pay; the price they were shown must go stale FIRST, so an expired
 * price surfaces as "re-confirm your price" while the slot is still theirs —
 * rather than as "your slot is gone" with a re-quote hidden behind it.
 *
 * If this were the longer of the two, the ordering would invert: the hold would
 * lapse, the sweep would release the slot, and the patient would be sent back to
 * search holding a quote that was still technically valid. Shorter is what makes
 * the failure recoverable.
 */
export const PRICING_DEFAULT_QUOTE_TTL_MINUTES = 15;

/** Bounds on the TTL, enforced in the service as well as the DTO. A one-minute quote is unusable; a one-day quote is a stale price. */
export const PRICING_QUOTE_TTL_BOUNDS = { min: 2, max: 120 } as const;

/* -------------------------------------------------------------------------- */
/* Discount incidence                                                          */
/* -------------------------------------------------------------------------- */

/**
 * *** WHAT HAPPENS WHEN A DISCOUNT IS LARGER THAN THE LINES THAT MAY BEAR IT. ***
 *
 * The promotions module returns ONE amount. Placing it is this module's job, and
 * it is a money rule:
 *
 *   1. The discount comes off `platform`-bearing lines first, in position order,
 *      capped at each line's gross.
 *   2. Then, ONLY under `spill_to_doctor`, off `doctor`-bearing lines.
 *   3. Anything still unplaced REDUCES THE DISCOUNT. It is reported as
 *      `discountUnplacedPaise` so the checkout can say "coupon applied, capped
 *      at 100.00" instead of silently charging more than the coupon promised.
 *
 * The realistic case is common, not exotic: `discountableAmount` handed to the
 * port is the WHOLE order's gross (see `pricing-discount.contract.ts` on why),
 * so a 20% coupon on a 600.00 order is 120.00 against a 100.00 convenience fee.
 * 20.00 overflows on the very first coupon anyone writes.
 *
 * ── WHY THIS IS A COMPILED-IN CONSTANT AND NOT A FOURTH `app_config` KEY ────
 *
 * Because flipping it is a COMMERCIAL decision, not an operational one. Under
 * `spill_to_doctor` a promotion the platform advertised is funded out of the
 * doctor's fee, and FR-7.4's "platform deduction 0 rupees" stops being true.
 * That needs the client's sign-off and a conversation with doctors — it is not
 * something to leave one dropdown away from an admin tuning a fee percentage.
 * It also has no effect at all unless the catalogue actually declares a
 * `doctor` bearer, which is itself a deliberate act.
 */
export type DiscountOverflowRule = 'cap_at_platform_capacity' | 'spill_to_doctor';

/** *** DEFAULT: CAP. *** The doctor's fee is never touched by a promotion the platform ran. */
export const PRICING_DISCOUNT_OVERFLOW_RULE: DiscountOverflowRule = 'cap_at_platform_capacity';

/* -------------------------------------------------------------------------- */
/* Document serials                                                            */
/* -------------------------------------------------------------------------- */

/** `pricing_document_sequences.series` values. `INV` for s.31 tax invoices, `CRN` for s.34 credit notes. */
export const PRICING_DOCUMENT_SERIES = { INVOICE: 'INV', CREDIT_NOTE: 'CRN' } as const;
export type PricingDocumentSeries = (typeof PRICING_DOCUMENT_SERIES)[keyof typeof PRICING_DOCUMENT_SERIES];

/** How many digits a serial's numeric part is padded to. `INV/2026-27/000041` sorts lexically as well as numerically. */
export const PRICING_DOCUMENT_SERIAL_PAD = 6;

/* -------------------------------------------------------------------------- */
/* The stale-draft sweep                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How often the sweep runs.
 *
 * *** NOTHING NEEDS THIS TIMER FOR CORRECTNESS. *** Expiry is enforced INSIDE
 * `pin`'s own conditional UPDATE (`... AND expires_at > now()`), so a quote that
 * has gone stale cannot be pinned whether or not a sweep has run. The sweep
 * exists for ONE reason: to release the discount reservations that stale drafts
 * are still holding, so a coupon with a per-user limit does not stay burnt by a
 * checkout nobody completed.
 */
export const PRICING_SWEEP_INTERVAL_MS = 60_000;

/** Candidates examined per pass. Bounds one pass's work so a backlog drains steadily instead of in one spike. */
export const PRICING_SWEEP_BATCH_SIZE = 100;

/** ISO 4217 currency for every quote this release prices. Mirrors `PAYMENT_DEFAULT_CURRENCY`. */
export const PRICING_DEFAULT_CURRENCY = 'INR';

/** What the seed inserts into `app_config` on first run. */
export const PRICING_APP_CONFIG_DEFAULTS: Record<PricingConfigKey, unknown> = {
  [PRICING_CONFIG_KEYS.COMPONENTS]: PRICING_DEFAULT_COMPONENTS,
  [PRICING_CONFIG_KEYS.TAX_PROFILE]: PRICING_DEFAULT_TAX_PROFILE,
  [PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES]: PRICING_DEFAULT_QUOTE_TTL_MINUTES,
};

/** Intra-state when the recipient's state IS the supplier's; inter-state otherwise. The whole of the CGST+SGST-versus-IGST decision. */
export function placeOfSupplyKindFor(supplierStateCode: string, placeOfSupplyStateCode: string): PlaceOfSupplyKind {
  return supplierStateCode === placeOfSupplyStateCode ? 'intra_state' : 'inter_state';
}
