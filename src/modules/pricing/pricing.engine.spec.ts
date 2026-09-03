/**
 * *** THE ACCEPTANCE NUMBERS, AS ARITHMETIC. ***
 *
 * `pricing.engine.ts` is pure — no Nest, no database, no clock — precisely so
 * that FR-7.2's and FR-7.3's figures can be asserted as arithmetic rather than
 * as an integration. Nothing in this file mocks anything, because there is
 * nothing to mock.
 *
 * *** THE FR-7.3 TEST REPRODUCES FR-7.3'S FIVE NUMBERS. IT DOES NOT "MATCH
 * `calculateBill`". *** Those are different claims about two genuinely different
 * functions: this engine computes `sum(round(net_i x rate))` and `calculateBill`
 * computes `round(subtotal x rate)`. They agree on 500/20%/18% and disagree at
 * other fees — see the round-then-sum test at the bottom, which pins the
 * difference rather than papering over it.
 */

import { calculateBill } from '../payment/payment-money.util';
import { paiseToRupees } from '../../shared/money/money.util';
import { priceQuote, PricingEngineError, validateCatalogue } from './pricing.engine';
import {
  PRICING_DEFAULT_COMPONENTS,
  PRICING_FR73_COMPONENTS,
  type PricingComponentSpec,
} from './pricing.constants';

/** 500.00 in paise — the fee every worked example in the SRS uses. */
const FEE_500 = 50_000n;

describe('pricing engine — the seeded default catalogue (doctor fee exempt)', () => {
  /**
   * *** ACCEPTANCE 1: 500 + 100 + 18 = 618. ***
   *
   * The orthodox reading of Notification 12/2017 entry 74 — a doctor's
   * consultation fee is GST-exempt, the platform's convenience fee is not.
   */
  it('prices 500 + 100 + 18 = 618.00', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });

    expect(paiseToRupees(quote.grossTotalPaise)).toBe('600.00');
    expect(paiseToRupees(quote.taxableTotalPaise)).toBe('600.00');
    expect(paiseToRupees(quote.cgstTotalPaise)).toBe('9.00');
    expect(paiseToRupees(quote.sgstTotalPaise)).toBe('9.00');
    expect(paiseToRupees(quote.igstTotalPaise)).toBe('0.00');
    expect(paiseToRupees(quote.totalPayablePaise)).toBe('618.00');

    const [doctorFee, convenienceFee] = quote.components;

    expect(paiseToRupees(doctorFee.grossPaise)).toBe('500.00');
    expect(doctorFee.taxTreatment).toBe('exempt');
    expect(doctorFee.taxPaise).toBe(0n);
    expect(paiseToRupees(doctorFee.lineTotalPaise)).toBe('500.00');

    expect(paiseToRupees(convenienceFee.grossPaise)).toBe('100.00');
    expect(paiseToRupees(convenienceFee.taxableValuePaise)).toBe('100.00');
    expect(paiseToRupees(convenienceFee.taxPaise)).toBe('18.00');
    expect(paiseToRupees(convenienceFee.lineTotalPaise)).toBe('118.00');
  });

  /** FR-7.4, unchanged by the exemption: the doctor keeps the whole fee. */
  it('pays the doctor 500.00 with a platform deduction of 0.00', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });

    expect(paiseToRupees(quote.doctorPayoutPaise)).toBe('500.00');
    expect(paiseToRupees(quote.platformDeductionPaise)).toBe('0.00');
  });
});

describe('pricing engine — FR-7.3’s catalogue (both components taxable at 18%)', () => {
  /**
   * *** ACCEPTANCE 2: FR-7.3's FIVE NUMBERS. ***
   *
   * `docs/SRS.md` FR-7.3: "Worked example at a fee of 500 rupees: convenience
   * fee is 20 percent, which is 100 rupees; subtotal is 600 rupees; GST at 18
   * percent exclusive is 108 rupees; final patient payable is 708 rupees."
   *
   * Reproduced as CONFIGURATION — the same engine, a different catalogue. That
   * is the whole argument for making tax treatment per-component and stored:
   * the client's CA can rule either way and the change is data, not code.
   */
  it('reproduces FR-7.3: fee 500 -> convenience 100 -> subtotal 600 -> GST 108 -> 708', () => {
    const quote = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });

    const [doctorFee, convenienceFee] = quote.components;

    // 1. the consultation fee
    expect(paiseToRupees(doctorFee.grossPaise)).toBe('500.00');
    // 2. the convenience fee, 20 percent of it
    expect(paiseToRupees(convenienceFee.grossPaise)).toBe('100.00');
    // 3. the subtotal before GST — the sum of TAXABLE VALUES
    expect(paiseToRupees(quote.taxableTotalPaise)).toBe('600.00');
    // 4. GST at 18 percent, exclusive
    expect(paiseToRupees(quote.cgstTotalPaise + quote.sgstTotalPaise + quote.igstTotalPaise)).toBe('108.00');
    // 5. the final patient payable
    expect(paiseToRupees(quote.totalPayablePaise)).toBe('708.00');
  });

  /** FR-7.4's payout view is the same numbers read differently. */
  it('still pays the doctor 500.00 with a deduction of 0.00', () => {
    const quote = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });

    expect(paiseToRupees(quote.doctorPayoutPaise)).toBe('500.00');
    expect(paiseToRupees(quote.platformDeductionPaise)).toBe('0.00');
  });
});

/* ========================================================================== */

describe('pricing engine — the place-of-supply split', () => {
  it('splits an intra-state supply into CGST + SGST and records both', () => {
    const quote = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });

    expect(paiseToRupees(quote.cgstTotalPaise)).toBe('54.00');
    expect(paiseToRupees(quote.sgstTotalPaise)).toBe('54.00');
    expect(quote.igstTotalPaise).toBe(0n);
  });

  it('charges an inter-state supply a single IGST', () => {
    const quote = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'inter_state',
    });

    expect(quote.cgstTotalPaise).toBe(0n);
    expect(quote.sgstTotalPaise).toBe(0n);
    expect(paiseToRupees(quote.igstTotalPaise)).toBe('108.00');
  });

  /**
   * *** THE REASON CGST IS COMPUTED AND SGST IS THE RESIDUAL. ***
   *
   * An identical catalogue price must cost the SAME TOTAL in every state. It
   * only does if the tax is computed once at the full rate and then split —
   * splitting the RATE and applying 9% twice would make the two totals differ by
   * a paise at some fees, which is indefensible on an invoice.
   */
  it('charges the same total in-state and out-of-state, at every fee in a wide sweep', () => {
    for (let paise = 1n; paise <= 800n; paise += 1n) {
      const intra = priceQuote({
        components: PRICING_FR73_COMPONENTS,
        consultationFeePaise: paise,
        placeOfSupplyKind: 'intra_state',
      });
      const inter = priceQuote({
        components: PRICING_FR73_COMPONENTS,
        consultationFeePaise: paise,
        placeOfSupplyKind: 'inter_state',
      });

      expect(intra.totalPayablePaise).toBe(inter.totalPayablePaise);
      // And the split is exact: the two heads sum to the tax actually charged.
      expect(intra.cgstTotalPaise + intra.sgstTotalPaise).toBe(inter.igstTotalPaise);
    }
  });

  /** An odd paise of tax lands on CGST, deterministically — `halveHalfUp`. */
  it('gives an odd paise of tax to CGST', () => {
    // A 1.00 gross taxed at 18% is 18 paise; a 0.05 gross is 1 paise, which is odd.
    const components: PricingComponentSpec[] = [
      {
        code: 'odd',
        label: 'Odd',
        position: 1,
        hsnSac: null,
        basis: 'pass_through',
        source: 'consultation_fee',
        taxTreatment: 'taxable',
        taxMode: 'exclusive',
        taxRatePct: '18.00',
        payee: 'platform',
      },
    ];

    const quote = priceQuote({ components, consultationFeePaise: 5n, placeOfSupplyKind: 'intra_state' });

    expect(quote.components[0].taxPaise).toBe(1n);
    expect(quote.cgstTotalPaise).toBe(1n);
    expect(quote.sgstTotalPaise).toBe(0n);
    expect(quote.totalPayablePaise).toBe(6n);
  });
});

/* ========================================================================== */

describe('pricing engine — inclusive tax is backed out, and the tax is a RESIDUAL', () => {
  const inclusive: PricingComponentSpec[] = [
    {
      code: 'all_in_fee',
      label: 'All-inclusive fee',
      position: 1,
      hsnSac: null,
      basis: 'pass_through',
      source: 'consultation_fee',
      taxTreatment: 'taxable',
      taxMode: 'inclusive',
      taxRatePct: '18.00',
      payee: 'platform',
    },
  ];

  /**
   * The exact case `money-allocate.util.ts` and
   * `price-quote-components.schema.ts` both name: at a gross of 10000 paise and
   * 18%, the backed-out taxable value is 8475 and the RESIDUAL tax is 1525.
   * `round(8475 x 18%)` would be 1526 and the line would total 10001.
   */
  it('backs 100.00 inclusive at 18% out to 84.75 + 15.25, not 84.75 + 15.26', () => {
    const quote = priceQuote({
      components: inclusive,
      consultationFeePaise: 10_000n,
      placeOfSupplyKind: 'inter_state',
    });

    const [line] = quote.components;
    expect(line.taxableValuePaise).toBe(8_475n);
    expect(line.taxPaise).toBe(1_525n);
    expect(line.lineTotalPaise).toBe(10_000n);
    expect(paiseToRupees(quote.totalPayablePaise)).toBe('100.00');
  });

  /** `taxable + tax === net` must hold EXACTLY, or the line does not balance. */
  it('balances every line at every gross from 1 to 1200 paise', () => {
    for (let paise = 1n; paise <= 1_200n; paise += 1n) {
      const quote = priceQuote({
        components: inclusive,
        consultationFeePaise: paise,
        placeOfSupplyKind: 'intra_state',
      });
      const [line] = quote.components;

      expect(line.taxableValuePaise + line.taxPaise).toBe(line.netPaise);
      expect(line.lineTotalPaise).toBe(line.taxableValuePaise + line.cgstPaise + line.sgstPaise + line.igstPaise);
      // An inclusive line's total is the amount that was quoted, unchanged.
      expect(line.lineTotalPaise).toBe(paise);
    }
  });
});

/* ========================================================================== */

describe('pricing engine — discount incidence', () => {
  it('takes a discount off the convenience fee, never the doctor’s fee', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
      discountPaise: 5_000n, // 50.00
    });

    const [doctorFee, convenienceFee] = quote.components;

    expect(doctorFee.discountPaise).toBe(0n);
    expect(doctorFee.discountBearer).toBeNull();
    expect(paiseToRupees(convenienceFee.discountPaise)).toBe('50.00');
    expect(convenienceFee.discountBearer).toBe('platform');

    // 500 exempt + (100 - 50) taxed at 18% = 500 + 50 + 9 = 559.
    expect(paiseToRupees(quote.taxableTotalPaise)).toBe('550.00');
    expect(paiseToRupees(quote.totalPayablePaise)).toBe('559.00');
    // *** FR-7.4 survives the promotion. ***
    expect(paiseToRupees(quote.doctorPayoutPaise)).toBe('500.00');
    expect(paiseToRupees(quote.platformDeductionPaise)).toBe('0.00');
  });

  /**
   * The overflow case, which is COMMON rather than exotic: the port is handed
   * the whole order's gross (600.00) as the base, so a 20% coupon is 120.00
   * against a 100.00 convenience fee.
   */
  it('caps a discount at what the platform lines can bear and reports the remainder', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
      discountPaise: 12_000n, // 120.00 — 20% of the 600.00 base
    });

    expect(paiseToRupees(quote.discountTotalPaise)).toBe('100.00');
    // *** NOT SILENT. *** The checkout must show the capped figure.
    expect(paiseToRupees(quote.discountUnplacedPaise)).toBe('20.00');
    expect(paiseToRupees(quote.doctorPayoutPaise)).toBe('500.00');
    // The convenience fee is zeroed; the doctor's fee is untouched.
    expect(paiseToRupees(quote.totalPayablePaise)).toBe('500.00');
  });

  it('spills onto a doctor-borne line ONLY when the rule and the catalogue both allow it', () => {
    const doctorBears: PricingComponentSpec[] = [
      { ...PRICING_DEFAULT_COMPONENTS[0], discountBearer: 'doctor' },
      { ...PRICING_DEFAULT_COMPONENTS[1] },
    ];

    const capped = priceQuote({
      components: doctorBears,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
      discountPaise: 12_000n,
      discountOverflowRule: 'cap_at_platform_capacity',
    });
    expect(paiseToRupees(capped.doctorPayoutPaise)).toBe('500.00');
    expect(paiseToRupees(capped.discountUnplacedPaise)).toBe('20.00');

    const spilled = priceQuote({
      components: doctorBears,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
      discountPaise: 12_000n,
      discountOverflowRule: 'spill_to_doctor',
    });
    expect(spilled.discountUnplacedPaise).toBe(0n);
    // *** FR-7.4's "platform deduction 0" stops being true — which is exactly
    // why this needs commercial sign-off and is not one dropdown away. ***
    expect(paiseToRupees(spilled.doctorPayoutPaise)).toBe('480.00');
    expect(paiseToRupees(spilled.platformDeductionPaise)).toBe('20.00');
  });

  it('never lets a discount invert a line', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
      discountPaise: 999_999n,
    });

    for (const component of quote.components) {
      expect(component.discountPaise).toBeLessThanOrEqual(component.grossPaise);
      expect(component.netPaise).toBeGreaterThanOrEqual(0n);
      expect(component.lineTotalPaise).toBeGreaterThanOrEqual(0n);
    }
  });

  it('names the whole order’s gross as the discountable base', () => {
    const quote = priceQuote({
      components: PRICING_DEFAULT_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'intra_state',
    });
    expect(paiseToRupees(quote.discountableBasePaise)).toBe('600.00');
  });
});

/* ========================================================================== */

describe('pricing engine — every priced quote balances', () => {
  /**
   * The two database CHECK constraints, asserted in arithmetic over a wide sweep
   * so a failure names the fee rather than the constraint:
   * `price_quotes_total_balances` and `price_quote_components_line_balances`.
   */
  it('satisfies the line and quote balancing checks across a fee sweep', () => {
    for (let paise = 0n; paise <= 1_400n; paise += 7n) {
      for (const kind of ['intra_state', 'inter_state'] as const) {
        const quote = priceQuote({
          components: PRICING_FR73_COMPONENTS,
          consultationFeePaise: paise,
          placeOfSupplyKind: kind,
          discountPaise: paise / 5n,
        });

        for (const component of quote.components) {
          expect(component.lineTotalPaise).toBe(
            component.taxableValuePaise + component.cgstPaise + component.sgstPaise + component.igstPaise,
          );

          // *** THE TWO MODES BALANCE DIFFERENTLY, AND CONFLATING THEM IS THE
          // EASY MISTAKE. *** `taxable + tax === net` is the INCLUSIVE
          // invariant — there the net already contains its tax and the taxable
          // value is backed out of it. On an EXCLUSIVE line the net IS the
          // taxable value and the tax is charged on top, so the line total, not
          // the net, is what the two sum to.
          if (component.taxMode === 'inclusive') {
            expect(component.taxableValuePaise + component.taxPaise).toBe(component.netPaise);
          } else {
            expect(component.taxableValuePaise).toBe(component.netPaise);
            expect(component.netPaise + component.taxPaise).toBe(component.lineTotalPaise);
          }
        }

        expect(quote.totalPayablePaise).toBe(
          quote.taxableTotalPaise + quote.cgstTotalPaise + quote.sgstTotalPaise + quote.igstTotalPaise,
        );
        // A supply is intra-state OR inter-state, never both
        // (`price_quotes_single_tax_regime`).
        expect(quote.igstTotalPaise === 0n || (quote.cgstTotalPaise === 0n && quote.sgstTotalPaise === 0n)).toBe(true);
      }
    }
  });
});

/* ========================================================================== */

describe('pricing engine — it is NOT the same function as calculateBill', () => {
  /**
   * *** THE TRAP, ENCODED. ***
   *
   * The engine computes `sum(round(net_i x rate))`; `calculateBill` computes
   * `round(subtotal x rate)`. `payment-money.util.ts`'s deprecation note names
   * the exact divergence: "a 103-paise fee with a 21-paise convenience fee gives
   * 22 paise of GST here and 23 there."
   *
   * This test exists so that nobody later "fixes" the engine to agree, and so
   * that the reason legacy rows must stay on `calculateBill` is written down as
   * an executable fact rather than as a comment.
   */
  it('differs from calculateBill at a 103-paise fee — round-then-sum is not sum-then-round', () => {
    const engine = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: 103n,
      placeOfSupplyKind: 'inter_state',
    });
    const legacy = calculateBill('1.03', '20.00', '18.00');

    // Same components...
    expect(engine.components[0].grossPaise).toBe(legacy.consultationFeePaise);
    expect(engine.components[1].grossPaise).toBe(legacy.convenienceFeePaise);
    expect(engine.taxableTotalPaise).toBe(legacy.subtotalPaise);

    // ...different GST, and therefore a different total.
    expect(engine.igstTotalPaise).toBe(23n);
    expect(legacy.gstPaise).toBe(22n);
    expect(engine.totalPayablePaise).not.toBe(legacy.totalPayablePaise);
  });

  /** They DO agree on the SRS's own worked example, which is why the divergence is easy to miss. */
  it('agrees with calculateBill on FR-7.3’s 500-rupee example', () => {
    const engine = priceQuote({
      components: PRICING_FR73_COMPONENTS,
      consultationFeePaise: FEE_500,
      placeOfSupplyKind: 'inter_state',
    });
    const legacy = calculateBill('500.00', '20.00', '18.00');

    expect(engine.totalPayablePaise).toBe(legacy.totalPayablePaise);
  });
});

/* ========================================================================== */

describe('pricing engine — catalogue validation', () => {
  const base = PRICING_DEFAULT_COMPONENTS[0];

  it('sorts by position, so the catalogue may be written in any order', () => {
    const sorted = validateCatalogue([PRICING_DEFAULT_COMPONENTS[1], PRICING_DEFAULT_COMPONENTS[0]]);
    expect(sorted.map((spec) => spec.code)).toEqual(['doctor_fee', 'convenience_fee']);
  });

  it('refuses an empty catalogue', () => {
    expect(() => validateCatalogue([])).toThrow(PricingEngineError);
  });

  it('refuses a duplicate code — the refund apportionment keys on it', () => {
    expect(() => validateCatalogue([base, { ...base, position: 2 }])).toThrow(/appears more than once/);
  });

  it('refuses a forward reference, which would price a component off zero', () => {
    expect(() =>
      validateCatalogue([
        { ...PRICING_DEFAULT_COMPONENTS[1], position: 1, basisCodes: ['doctor_fee'] },
        { ...base, position: 2 },
      ]),
    ).toThrow(/not an earlier component/);
  });

  it('refuses an exempt-and-inclusive component', () => {
    expect(() => validateCatalogue([{ ...base, taxMode: 'inclusive' }])).toThrow(/embedded tax that does not exist/);
  });

  it('refuses an exempt component carrying a rate', () => {
    expect(() => validateCatalogue([{ ...base, taxRatePct: '18.00' }])).toThrow(/non-zero tax rate/);
  });

  it('refuses a percentage of nothing', () => {
    expect(() =>
      validateCatalogue([{ ...PRICING_DEFAULT_COMPONENTS[1], position: 1, basisCodes: [] }]),
    ).toThrow(/percentage of nothing/);
  });

  it('refuses a malformed rate rather than coercing it', () => {
    expect(() => validateCatalogue([{ ...base, taxTreatment: 'taxable', taxRatePct: 'eighteen' }])).toThrow(
      /malformed tax rate/,
    );
  });

  it('refuses a negative fee', () => {
    expect(() =>
      priceQuote({
        components: PRICING_DEFAULT_COMPONENTS,
        consultationFeePaise: -1n,
        placeOfSupplyKind: 'intra_state',
      }),
    ).toThrow(PricingEngineError);
  });
});
