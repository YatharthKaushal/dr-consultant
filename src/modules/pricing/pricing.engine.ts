/**
 * *** THE PRICING ENGINE. PURE. READ BEFORE CHANGING ANY ARITHMETIC. ***
 *
 * Nothing in this file reads config, a row, the clock, or Nest. It takes a
 * component catalogue and a fee and returns a fully priced bill in integer
 * paise. That is what makes FR-7.2's and FR-7.3's acceptance numbers testable
 * as ARITHMETIC rather than as an integration — the same rule
 * `shared/money/money.util.ts` states as its rule 4.
 *
 * ── ORDER OF OPERATIONS, PER COMPONENT, ALL IN INTEGER PAISE AS `bigint` ────
 *
 *   1. gross      pass-through (given), or `applyPctToPaise(sum of the named
 *                 codes' GROSS, pct)` — rounded ONCE.
 *   2. discount   placed by `placeDiscount` below; `net = gross - discount`,
 *                 floored at 0.
 *   3. taxable value and tax:
 *                 exempt               -> taxable = net,  tax = 0
 *                 taxable + exclusive  -> taxable = net,  tax = round(net x rate)
 *                 taxable + inclusive  -> taxable = inclusiveTaxableValue(net, rate)
 *                                         *** tax = net - taxable ***
 *   4. heads      intra-state -> cgst = halveHalfUp(tax), sgst = tax - cgst
 *                 inter-state -> igst = tax
 *   5. lineTotal  = taxable + cgst + sgst + igst
 *   6. subtotal   = sum(taxable)  <- FR-7.2's "subtotal before GST"
 *
 * ── THREE RULES THAT ARE NOT STYLISTIC ─────────────────────────────────────
 *
 * *** 1. TAX IS A RESIDUAL, NEVER A SECOND ROUNDING. ***
 *
 * `taxable + tax === net` must hold EXACTLY, or the invoice line does not
 * balance and `price_quote_components_line_balances` rejects the row. At a gross
 * of 10000 paise and 18% inclusive the backed-out taxable value is 8475, so the
 * residual tax is 1525 — whereas `round(8475 x 18%)` is 1526 and the line would
 * come to 10001. One paise, on every affected invoice, unexplainable to an
 * auditor. So the inclusive branch SUBTRACTS; it never rounds twice.
 *
 * *** 2. CGST IS COMPUTED, SGST IS THE RESIDUAL. ***
 *
 * Never split the RATE and apply 9% twice. `2 x round(v x 9%)` is not
 * `round(v x 18%)` in general, so an identical catalogue price would cost a
 * DIFFERENT TOTAL in a different state — which is indefensible on an invoice and
 * would show up as a penny difference between two patients who bought the same
 * thing. The tax is computed once at the full rate and then SPLIT, so the two
 * heads always sum to the tax actually charged.
 *
 * The invoice still prints "CGST 9% / SGST 9%". Those are LABELS — half of the
 * charged rate, shown because the law requires the heads to be shown separately
 * — while the AMOUNTS are a split of one figure. `halveHalfUp` gives an odd
 * paise to CGST, deterministically.
 *
 * *** 3. `inclusiveTaxableValue` COMES FROM `shared/money/money-allocate.util.ts`. ***
 *
 * Read its header before touching the inclusive branch. It uses the doubled form
 * `floor((2n + d) / 2d)` rather than `applyPctToPaise`'s `(n + d/2) / d`, because
 * the divisor here is `10000 + rate` — ODD for any odd basis-point rate — and the
 * naive form is only accidentally correct there, on a parity argument no reader
 * should have to reconstruct.
 *
 * ── *** THIS IS NOT THE SAME FUNCTION AS `calculateBill`. *** ───────────────
 *
 * This engine computes `sum(round(net_i x rate))`. `calculateBill` computes
 * `round(subtotal x rate)`. ROUND-THEN-SUM IS NOT SUM-THEN-ROUND: a 103-paise
 * fee with a 21-paise convenience fee gives 22 paise of GST one way and 23 the
 * other.
 *
 * Two consequences, both load-bearing:
 *   (a) The acceptance test says this engine REPRODUCES FR-7.3'S FIVE NUMBERS.
 *       It must never be stated as "matches `calculateBill`", because that is a
 *       claim about two functions that are genuinely different.
 *   (b) A legacy `payments` row — one with no `price_quote_id` — must NEVER be
 *       re-priced here. Those rows were priced by `calculateBill`, and the
 *       webhook's capture check and `reconcileWithGateway`'s amount check must
 *       keep reproducing their historical totals exactly. Re-pricing one with
 *       this engine would make those checks start REJECTING real captures.
 *       `calculateBill` is `@deprecated` and deliberately not deleted for
 *       exactly this reason.
 */

import {
  applyPctToPaise,
  MoneyFormatError,
  pctToBasisPoints,
  rupeesToPaise,
} from '../../shared/money/money.util';
import { halveHalfUp, inclusiveTaxableValue } from '../../shared/money/money-allocate.util';
import type { PlaceOfSupplyKind, TaxMode, TaxTreatment } from '../../schema/enums.schema';
import {
  PRICING_DISCOUNT_OVERFLOW_RULE,
  type ComponentBasis,
  type ComponentDiscountBearer,
  type ComponentPayee,
  type DiscountOverflowRule,
  type PricingComponentSpec,
} from './pricing.constants';

/** Thrown for a structurally unusable catalogue. Services turn it into an HTTP body; this layer stays free of Nest. */
export class PricingEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingEngineError';
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

export interface PricingEngineInput {
  /** The ordered catalogue. Validated here, not trusted. */
  components: readonly PricingComponentSpec[];
  /** The doctor's own price, feeding every `pass_through` component sourced from `consultation_fee`. */
  consultationFeePaise: bigint;
  /** Decides whether tax splits into CGST+SGST or lands as a single IGST. */
  placeOfSupplyKind: PlaceOfSupplyKind;
  /**
   * The discount the promotions port returned, to be PLACED across components by
   * this engine. Zero (or omitted) means no discount.
   */
  discountPaise?: bigint;
  /** Defaults to the compiled-in rule. Overridable so a test can exercise both branches. */
  discountOverflowRule?: DiscountOverflowRule;
}

/** One priced line, in integer paise. The rupee-string view is built by the mapper. */
export interface PricedComponent {
  code: string;
  label: string;
  position: number;
  hsnSac: string | null;
  basis: ComponentBasis;
  /** `numeric(5,2)`-shaped, or null for a pass-through line. Snapshotted so the derivation is reproducible. */
  basisPct: string | null;
  basisCodes: string[] | null;
  payee: ComponentPayee;

  grossPaise: bigint;
  discountPaise: bigint;
  /** Whose money the discount on THIS line was. Null when this line carries no discount. */
  discountBearer: ComponentDiscountBearer | null;
  /** `gross - discount`, floored at 0. Not stored — it is `taxable + tax` by construction. */
  netPaise: bigint;

  taxTreatment: TaxTreatment;
  taxMode: TaxMode;
  taxRateBasisPoints: bigint;
  taxableValuePaise: bigint;
  /** `net - taxable`. Split across the heads below; never stored on its own. */
  taxPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  lineTotalPaise: bigint;
}

export interface PricedQuote {
  components: PricedComponent[];
  placeOfSupplyKind: PlaceOfSupplyKind;

  /** Sum of every component's gross, before any discount. */
  grossTotalPaise: bigint;
  /** What was actually PLACED. May be less than the port's figure — see `discountUnplacedPaise`. */
  discountTotalPaise: bigint;
  /**
   * The part of the port's discount no line could bear.
   *
   * *** NOT AN ERROR, AND NOT SILENT. *** Under the default `cap` rule this is
   * how a 120.00 coupon meets a 100.00 convenience fee. The checkout must show
   * the capped figure rather than the promised one.
   */
  discountUnplacedPaise: bigint;
  /** FR-7.2's "subtotal before GST" — the sum of TAXABLE VALUES, not of nets. */
  taxableTotalPaise: bigint;
  cgstTotalPaise: bigint;
  sgstTotalPaise: bigint;
  igstTotalPaise: bigint;
  /** *** THE AUTHORITATIVE AMOUNT. *** What the gateway order is created for. */
  totalPayablePaise: bigint;

  /** FR-7.4: the sum of `doctor`-payee lines' gross, less any discount those lines actually bore. */
  doctorPayoutPaise: bigint;
  /** FR-7.4's "platform deduction". Zero unless the catalogue declares a `doctor` discount bearer. */
  platformDeductionPaise: bigint;
  /**
   * THE BASE the promotions port was given: the whole order's gross, pre-discount
   * and pre-tax. See `pricing-discount.contract.ts` for why it is named this way.
   */
  discountableBasePaise: bigint;
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Prices one bill. Deterministic, total, and a pure function of its argument.
 *
 * Two passes, and the split matters: `percent_of` applies to the GROSS of the
 * components it names, which is a PRE-DISCOUNT figure. So every gross is
 * computed first, then the discount is placed against the finished gross list,
 * then each line is taxed. Interleaving them would make a component's rate apply
 * to a discounted base, which is not what "20% of the consultation fee" means.
 */
export function priceQuote(input: PricingEngineInput): PricedQuote {
  const catalogue = validateCatalogue(input.components);

  if (input.consultationFeePaise < 0n) {
    throw new PricingEngineError('The consultation fee must be non-negative.');
  }

  /* ---- PASS 1: gross, in position order ------------------------------- */

  const grossByCode = new Map<string, bigint>();
  const grosses: bigint[] = [];

  for (const spec of catalogue) {
    const gross = grossFor(spec, input.consultationFeePaise, grossByCode);
    grossByCode.set(spec.code, gross);
    grosses.push(gross);
  }

  const grossTotalPaise = grosses.reduce<bigint>((sum, value) => sum + value, 0n);

  /* ---- Discount placement --------------------------------------------- */

  const requested = input.discountPaise ?? 0n;
  if (requested < 0n) {
    throw new PricingEngineError('A discount must be non-negative.');
  }

  const placement = placeDiscount({
    catalogue,
    grosses,
    discountPaise: requested,
    rule: input.discountOverflowRule ?? PRICING_DISCOUNT_OVERFLOW_RULE,
  });

  /* ---- PASS 2: discount, tax, heads, line total ------------------------ */

  const components: PricedComponent[] = catalogue.map((spec, index) => {
    const grossPaise = grosses[index];
    const discountPaise = placement.perComponent[index];
    const netPaise = grossPaise > discountPaise ? grossPaise - discountPaise : 0n;

    const taxRateBasisPoints = spec.taxTreatment === 'exempt' ? 0n : pctToBasisPoints(spec.taxRatePct);

    // *** STEP 3. The only place tax is decided. ***
    let taxableValuePaise: bigint;
    let taxPaise: bigint;

    if (spec.taxTreatment === 'exempt') {
      // No rate, no tax, and the whole net is the taxable value — an exempt
      // supply still has a value that must be reported, it simply carries no tax.
      taxableValuePaise = netPaise;
      taxPaise = 0n;
    } else if (spec.taxMode === 'inclusive') {
      // The quoted amount ALREADY contains its tax. Back the value out, then
      // take the tax as the RESIDUAL — never as a second rounding. See rule 1.
      taxableValuePaise = inclusiveTaxableValue(netPaise, taxRateBasisPoints);
      taxPaise = netPaise - taxableValuePaise;
    } else {
      // Exclusive: the net IS the taxable value and the tax is charged on top.
      taxableValuePaise = netPaise;
      taxPaise = applyPctToPaise(netPaise, taxRateBasisPoints);
    }

    // *** STEP 4. Heads. CGST computed, SGST residual — see rule 2. ***
    let cgstPaise = 0n;
    let sgstPaise = 0n;
    let igstPaise = 0n;

    if (input.placeOfSupplyKind === 'intra_state') {
      cgstPaise = halveHalfUp(taxPaise);
      sgstPaise = taxPaise - cgstPaise;
    } else {
      igstPaise = taxPaise;
    }

    return {
      code: spec.code,
      label: spec.label,
      position: spec.position,
      hsnSac: spec.hsnSac,
      basis: spec.basis,
      basisPct: spec.basis === 'percent_of' ? (spec.basisPct ?? null) : null,
      basisCodes: spec.basis === 'percent_of' ? [...(spec.basisCodes ?? [])] : null,
      payee: spec.payee,

      grossPaise,
      discountPaise,
      // Recorded ONLY where a discount actually landed. A bearer on a line with
      // no discount would assert an incidence decision that was never made.
      discountBearer: discountPaise > 0n ? (spec.discountBearer ?? null) : null,
      netPaise,

      taxTreatment: spec.taxTreatment,
      taxMode: spec.taxMode,
      taxRateBasisPoints,
      taxableValuePaise,
      taxPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      // *** STEP 5. This is what the CHECK constraint verifies on the way in. ***
      lineTotalPaise: taxableValuePaise + cgstPaise + sgstPaise + igstPaise,
    };
  });

  const sum = (pick: (component: PricedComponent) => bigint): bigint =>
    components.reduce<bigint>((total, component) => total + pick(component), 0n);

  // FR-7.4. The payout is the doctor's own lines at GROSS, less only what those
  // lines actually bore of a discount — which is zero under the seeded
  // catalogue, and can only be non-zero if somebody deliberately set a `doctor`
  // discount bearer.
  const doctorPayoutPaise = components
    .filter((component) => component.payee === 'doctor')
    .reduce<bigint>((total, component) => total + component.grossPaise - component.discountPaise, 0n);
  const doctorGrossPaise = components
    .filter((component) => component.payee === 'doctor')
    .reduce<bigint>((total, component) => total + component.grossPaise, 0n);

  return {
    components,
    placeOfSupplyKind: input.placeOfSupplyKind,

    grossTotalPaise,
    discountTotalPaise: placement.placedPaise,
    discountUnplacedPaise: placement.unplacedPaise,
    // *** STEP 6. The sum of TAXABLE VALUES, not of nets. ***
    taxableTotalPaise: sum((component) => component.taxableValuePaise),
    cgstTotalPaise: sum((component) => component.cgstPaise),
    sgstTotalPaise: sum((component) => component.sgstPaise),
    igstTotalPaise: sum((component) => component.igstPaise),
    totalPayablePaise: sum((component) => component.lineTotalPaise),

    doctorPayoutPaise,
    platformDeductionPaise: doctorGrossPaise - doctorPayoutPaise,
    discountableBasePaise: grossTotalPaise,
  };
}

/* -------------------------------------------------------------------------- */
/* Gross derivation                                                            */
/* -------------------------------------------------------------------------- */

function grossFor(
  spec: PricingComponentSpec,
  consultationFeePaise: bigint,
  grossByCode: ReadonlyMap<string, bigint>,
): bigint {
  if (spec.basis === 'pass_through') {
    if (spec.source === 'fixed') {
      return rupeesToPaise(spec.fixedAmount ?? '0.00');
    }
    return consultationFeePaise;
  }

  // `percent_of`: a rate applied to the GROSS of the named codes. This is what
  // FR-7.3 means by "convenience fee is 20 percent, which is 100 rupees" — 20%
  // of the 500 fee, pre-discount and pre-tax.
  const base = (spec.basisCodes ?? []).reduce<bigint>((total, code) => {
    const gross = grossByCode.get(code);
    if (gross === undefined) {
      // Unreachable after `validateCatalogue`, and checked anyway: a forward
      // reference here would silently price the component off a base of zero.
      throw new PricingEngineError(
        `Component ${spec.code} derives from ${code}, which has no gross at this point.`,
      );
    }
    return total + gross;
  }, 0n);

  // *** ROUNDED ONCE. *** The rounded figure is what feeds every later step and
  // what is stored — `money.util.ts` rule 3.
  return applyPctToPaise(base, pctToBasisPoints(spec.basisPct ?? '0.00'));
}

/* -------------------------------------------------------------------------- */
/* Discount incidence                                                          */
/* -------------------------------------------------------------------------- */

interface DiscountPlacement {
  /** One entry per component, aligned with the catalogue's order. */
  perComponent: bigint[];
  placedPaise: bigint;
  unplacedPaise: bigint;
}

/**
 * *** WHERE A DISCOUNT LANDS. THIS IS A MONEY RULE, NOT A FORMATTING CHOICE. ***
 *
 * The port returns one amount and says nothing about incidence. Placing it:
 *
 *   1. `platform`-bearing lines, in POSITION order, each capped at its gross.
 *   2. then `doctor`-bearing lines, ONLY under `spill_to_doctor`.
 *   3. anything left is UNPLACED and reduces the discount.
 *
 * The doctor's fee is untouched under the seeded catalogue because it declares
 * no bearer at all. That is FR-7.4 — "consultation fee 500, platform deduction
 * 0, doctor earning 500" — made structural rather than incidental: funding a
 * platform promotion out of the doctor's pocket would make that line quietly
 * false, and `price_quote_components.discount_bearer`'s own schema comment
 * exists to stop exactly that.
 *
 * Position order rather than largest-first so the result is reproducible from
 * the catalogue alone, with no tie-break to argue about.
 */
function placeDiscount(input: {
  catalogue: readonly PricingComponentSpec[];
  grosses: readonly bigint[];
  discountPaise: bigint;
  rule: DiscountOverflowRule;
}): DiscountPlacement {
  const perComponent = input.catalogue.map(() => 0n);
  let remaining = input.discountPaise;

  if (remaining === 0n) {
    return { perComponent, placedPaise: 0n, unplacedPaise: 0n };
  }

  const takeFrom = (bearer: ComponentDiscountBearer): void => {
    input.catalogue.forEach((spec, index) => {
      if (remaining <= 0n) return;
      if ((spec.discountBearer ?? null) !== bearer) return;

      const capacity = input.grosses[index] - perComponent[index];
      if (capacity <= 0n) return;

      const take = remaining < capacity ? remaining : capacity;
      perComponent[index] += take;
      remaining -= take;
    });
  };

  takeFrom('platform');

  if (remaining > 0n && input.rule === 'spill_to_doctor') {
    // *** REACHABLE ONLY BY DELIBERATE CONFIGURATION. *** It needs BOTH the
    // compiled-in rule flipped AND a catalogue that declares a `doctor` bearer,
    // and it makes FR-7.4's "platform deduction 0" untrue.
    takeFrom('doctor');
  }

  const placedPaise = perComponent.reduce<bigint>((total, value) => total + value, 0n);
  return { perComponent, placedPaise, unplacedPaise: input.discountPaise - placedPaise };
}

/* -------------------------------------------------------------------------- */
/* Catalogue validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a catalogue that would price wrongly, rather than pricing wrongly.
 *
 * `app_config.value` is untyped jsonb, so nothing between an admin's keyboard
 * and this function checks any of it. Everything below would otherwise reach a
 * patient's card: a duplicate code makes the refund apportionment ambiguous, a
 * forward reference prices a component off zero, and an exempt-inclusive line
 * asserts an embedded tax that does not exist and would silently shrink the
 * line. The last two are also database CHECK constraints — caught here first, so
 * the error names the component rather than the constraint.
 *
 * Returns the catalogue SORTED BY POSITION, which is the order every later step
 * assumes.
 */
export function validateCatalogue(components: readonly PricingComponentSpec[]): PricingComponentSpec[] {
  if (!Array.isArray(components) || components.length === 0) {
    throw new PricingEngineError('A pricing catalogue must contain at least one component.');
  }

  const sorted = [...components].sort((a, b) => a.position - b.position);
  const seenCodes = new Set<string>();
  const seenPositions = new Set<number>();

  for (const spec of sorted) {
    if (typeof spec.code !== 'string' || spec.code.length === 0 || spec.code.length > 40) {
      throw new PricingEngineError(`Component code ${JSON.stringify(spec.code)} must be 1-40 characters.`);
    }
    if (seenCodes.has(spec.code)) {
      // `price_quote_components` has a UNIQUE(quote, code) index, and the refund
      // apportionment keys on the code. A duplicate is not a display problem.
      throw new PricingEngineError(`Component code ${spec.code} appears more than once.`);
    }
    seenCodes.add(spec.code);

    if (!Number.isInteger(spec.position) || spec.position < 0 || spec.position > 32_767) {
      throw new PricingEngineError(`Component ${spec.code} has a position outside the smallint range.`);
    }
    if (seenPositions.has(spec.position)) {
      throw new PricingEngineError(`Component ${spec.code} shares position ${spec.position} with another component.`);
    }
    seenPositions.add(spec.position);

    if (typeof spec.label !== 'string' || spec.label.length === 0 || spec.label.length > 80) {
      throw new PricingEngineError(`Component ${spec.code} needs a label of 1-80 characters.`);
    }
    if (spec.hsnSac !== null && (typeof spec.hsnSac !== 'string' || spec.hsnSac.length > 10)) {
      throw new PricingEngineError(`Component ${spec.code} has an HSN/SAC longer than 10 characters.`);
    }
    if (spec.payee !== 'doctor' && spec.payee !== 'platform') {
      throw new PricingEngineError(`Component ${spec.code} must declare a payee of 'doctor' or 'platform'.`);
    }
    if (spec.discountBearer != null && spec.discountBearer !== 'platform' && spec.discountBearer !== 'doctor') {
      throw new PricingEngineError(`Component ${spec.code} has an unrecognised discount bearer.`);
    }
    if (spec.taxTreatment !== 'exempt' && spec.taxTreatment !== 'taxable') {
      throw new PricingEngineError(`Component ${spec.code} has an unrecognised tax treatment.`);
    }
    if (spec.taxMode !== 'exclusive' && spec.taxMode !== 'inclusive') {
      throw new PricingEngineError(`Component ${spec.code} has an unrecognised tax mode.`);
    }
    if (spec.taxTreatment === 'exempt' && spec.taxMode === 'inclusive') {
      // Mirrors `price_quote_components_exempt_is_not_inclusive`.
      throw new PricingEngineError(
        `Component ${spec.code} is exempt and inclusive, which asserts an embedded tax that does not exist.`,
      );
    }

    assertRate(spec.code, spec.taxRatePct, 'tax rate');
    if (spec.taxTreatment === 'exempt' && pctToBasisPoints(spec.taxRatePct) !== 0n) {
      // Mirrors `price_quote_components_exempt_has_no_tax`.
      throw new PricingEngineError(`Component ${spec.code} is exempt but carries a non-zero tax rate.`);
    }

    if (spec.basis === 'pass_through') {
      if (spec.source === 'fixed') {
        assertRupees(spec.code, spec.fixedAmount ?? '', 'fixed amount');
      } else if (spec.source !== undefined && spec.source !== 'consultation_fee') {
        throw new PricingEngineError(`Component ${spec.code} has an unrecognised pass-through source.`);
      }
      continue;
    }

    if (spec.basis !== 'percent_of') {
      throw new PricingEngineError(`Component ${spec.code} has an unrecognised basis ${JSON.stringify(spec.basis)}.`);
    }

    assertRate(spec.code, spec.basisPct ?? '', 'basis percentage');

    const codes = spec.basisCodes ?? [];
    if (codes.length === 0) {
      throw new PricingEngineError(`Component ${spec.code} is a percentage of nothing — it names no basis codes.`);
    }
    for (const referenced of codes) {
      if (!seenCodes.has(referenced) || referenced === spec.code) {
        // `seenCodes` holds only codes at a LOWER position, so this rejects both
        // an unknown code and a forward reference in one test.
        throw new PricingEngineError(
          `Component ${spec.code} derives from ${referenced}, which is not an earlier component.`,
        );
      }
    }
  }

  return sorted;
}

function assertRate(code: string, value: string, label: string): void {
  try {
    pctToBasisPoints(value);
  } catch (error) {
    if (error instanceof MoneyFormatError) {
      throw new PricingEngineError(`Component ${code} has a malformed ${label} ${JSON.stringify(value)}.`);
    }
    throw error;
  }
}

function assertRupees(code: string, value: string, label: string): void {
  try {
    rupeesToPaise(value);
  } catch (error) {
    if (error instanceof MoneyFormatError) {
      throw new PricingEngineError(`Component ${code} has a malformed ${label} ${JSON.stringify(value)}.`);
    }
    throw error;
  }
}
