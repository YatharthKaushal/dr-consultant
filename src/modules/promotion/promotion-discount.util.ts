/**
 * *** THE DISCOUNT ARITHMETIC. INTEGER PAISE, ONE ROUNDING, IN THIS ORDER. ***
 *
 * Every figure here goes through `shared/money/money.util.ts` — integer paise as
 * `bigint`, percentages as integer basis points, half-up rounding, never a
 * float. That file's header is the authority and this one does not restate it;
 * what this file adds is the ORDER, which is a domain rule rather than a
 * primitive:
 *
 *     1. ROUND ONCE.  A percentage instrument produces a rounded paise figure
 *                     via `applyPctToPaise`, and that rounded value is what
 *                     feeds every later step. A flat instrument needs no
 *                     rounding at all — it is already a `numeric(10,2)`.
 *     2. THEN CAP.    `max_discount_amount` is applied to the ROUNDED figure.
 *                     Capping first and rounding after would let "₹200 off,
 *                     max ₹150" pay out ₹150.004 -> ₹150.00 by a different
 *                     route on different inputs, and a bill must be
 *                     reproducible from its stored components.
 *     3. THEN CLAMP.  The result can never exceed the base it was quoted
 *                     against. `discount_redemptions_amount_check` enforces
 *                     `discount_amount <= discountable_base` in the database,
 *                     so getting this wrong is not a wrong bill — it is a
 *                     failed INSERT inside the reservation transaction. The
 *                     clamp is what keeps a legitimate "₹500 off a ₹200 order"
 *                     a ₹200 discount rather than a 500 error.
 *
 * A discount can ZERO an order but never INVERT one. There is no negative
 * branch anywhere in this file, and `money.util.ts` rejects negative operands
 * outright — which is what makes "the platform pays the patient" unrepresentable
 * rather than merely unlikely.
 *
 * Pure by construction: no config, no row, no clock. Testable as arithmetic.
 */

import {
  applyPctToPaise,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
} from '../../shared/money/money.util';

/** The instrument's value rules, as they are stored — `numeric` columns arrive from `pg` as strings, and they stay strings until this file converts them. */
export interface DiscountValueRules {
  valueKind: 'flat' | 'percent';
  /** `numeric(10,2)` rupee string. Non-null exactly when `valueKind` is `flat` (`discount_instruments_value_check`). */
  flatAmount: string | null;
  /** `numeric(5,2)` percentage string. Non-null exactly when `valueKind` is `percent`. */
  percentRate: string | null;
  /** `numeric(10,2)` rupee string. REQUIRED for `percent` by CHECK — an uncapped percentage is an unbounded liability against an admin-settable fee. */
  maxDiscountAmount: string | null;
}

export interface DiscountComputation {
  /** What comes off the bill, `numeric(10,2)`-shaped. */
  discountAmount: string;
  /** What is left of the base afterwards. `'0.00'` when the discount covers it entirely. */
  residualDiscountable: string;
  /** True when the discount consumed the whole discountable base — pricing needs to know, because a fully discounted component changes what it renders. */
  fullyDiscounted: boolean;
  /** True when the code takes NOTHING off. Chiefly an affiliate code whose only job is attribution. */
  attributionOnly: boolean;
  /** Integer paise, for the caller that needs to keep computing (the commission base) without re-parsing. */
  discountPaise: bigint;
  basePaise: bigint;
}

/**
 * Applies one instrument's rules to one base.
 *
 * `basePaise` is `DiscountOrderContext.discountableAmount` already converted —
 * PRICING NAMES THE BASE, so this module never decides which components are
 * discountable and never reads a fee configuration.
 *
 * Throws `MoneyFormatError` (from `money.util.ts`) on a malformed stored value.
 * That is a genuine fault — a `numeric` column that does not parse means the row
 * is corrupt — and it is deliberately NOT folded into a refusal: a refusal tells
 * a patient to try something else, and there is nothing else to try.
 */
export function computeDiscount(rules: DiscountValueRules, basePaise: bigint): DiscountComputation {
  // 1. ROUND ONCE. A flat amount is already exact; a percentage rounds half-up
  //    here and nowhere else.
  let discountPaise =
    rules.valueKind === 'flat'
      ? rupeesToPaise(rules.flatAmount ?? '0')
      : applyPctToPaise(basePaise, pctToBasisPoints(rules.percentRate ?? '0'));

  // 2. THEN CAP, against the already-rounded figure.
  if (rules.maxDiscountAmount !== null) {
    const capPaise = rupeesToPaise(rules.maxDiscountAmount);
    if (discountPaise > capPaise) discountPaise = capPaise;
  }

  // 3. THEN CLAMP to the base. `discount_redemptions_amount_check` enforces this
  //    in the database too; doing it here is what turns a ₹500 coupon on a ₹200
  //    order into a ₹200 discount instead of a failed INSERT.
  if (discountPaise > basePaise) discountPaise = basePaise;

  const residualPaise = basePaise - discountPaise;

  return {
    discountAmount: paiseToRupees(discountPaise),
    residualDiscountable: paiseToRupees(residualPaise),
    fullyDiscounted: residualPaise === 0n,
    attributionOnly: discountPaise === 0n,
    discountPaise,
    basePaise,
  };
}

/**
 * A partner's commission, over an already-resolved base.
 *
 * The same three steps in the same order, plus one extra guard the discount side
 * does not need: `affiliate_partners_nondefault_base_needs_cap` makes
 * `commission_max` mandatory for any base other than `net_platform_margin`,
 * because either of the other two can exceed what the booking actually earned.
 *
 * *** GST IS NEVER A BASE. *** The caller resolves `basePaise`, and
 * `affiliate.service.ts#resolveCommissionBase` is where that is enforced —
 * stated here too because this is the function somebody will reach for when
 * adding a fourth base.
 */
export function computeCommission(
  rules: { valueKind: 'flat' | 'percent'; flatAmount: string | null; percentRate: string | null; maxAmount: string | null },
  basePaise: bigint,
): { commissionPaise: bigint; commissionAmount: string } {
  let commissionPaise =
    rules.valueKind === 'flat'
      ? rupeesToPaise(rules.flatAmount ?? '0')
      : applyPctToPaise(basePaise, pctToBasisPoints(rules.percentRate ?? '0'));

  if (rules.maxAmount !== null) {
    const capPaise = rupeesToPaise(rules.maxAmount);
    if (commissionPaise > capPaise) commissionPaise = capPaise;
  }

  // A flat commission larger than the base would pay out more than the booking
  // earned. Clamped, not refused: the arrangement is the client's to strike, and
  // silently paying a negative margin is worse than paying a smaller one.
  if (commissionPaise > basePaise) commissionPaise = basePaise;

  return { commissionPaise, commissionAmount: paiseToRupees(commissionPaise) };
}

/** `a - b`, floored at zero. Used wherever a margin is derived by subtraction and a negative result would be a nonsense rather than a debt. */
export function subtractFloorZero(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}
