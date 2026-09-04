/**
 * *** THE TAX REVERSAL BEHIND A CREDIT NOTE. ***
 *
 * `apportion` is pure — same discipline as `pricing.engine.ts` — so the s.34
 * arithmetic is testable without a database. `PricingRefundService` is exercised
 * with a hand-rolled `jest.fn()` repository, never `Test.createTestingModule`.
 */

import type { PriceQuoteComponentRow } from '../../schema/price-quote-components.schema';
import type { PriceQuoteRow } from '../../schema/price-quotes.schema';
import type { PriceQuoteRepository } from './price-quote.repository';
import { apportion, PricingRefundService } from './pricing-refund.service';
import type { RefundComponentRepository } from './refund-component.repository';

const noopRefundComponents = { countForConsultations: jest.fn().mockResolvedValue(0) } as unknown as RefundComponentRepository;

/* -------------------------------------------------------------------------- */
/* Fixtures — the seeded catalogue's own 618.00 bill                           */
/* -------------------------------------------------------------------------- */

function component(overrides: Partial<PriceQuoteComponentRow> = {}): PriceQuoteComponentRow {
  return {
    id: 'x',
    priceQuoteId: 'q1',
    position: 1,
    code: 'doctor_fee',
    label: 'Doctor consultation fee',
    hsnSac: null,
    grossAmount: '500.00',
    discountAmount: '0.00',
    taxableValue: '500.00',
    taxTreatment: 'exempt',
    taxMode: 'exclusive',
    taxRatePct: '0.00',
    cgstAmount: '0.00',
    sgstAmount: '0.00',
    igstAmount: '0.00',
    lineTotal: '500.00',
    discountBearer: null,
    basis: 'pass_through',
    basisPct: null,
    basisCodes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as PriceQuoteComponentRow;
}

/** The seeded default: doctor fee EXEMPT (500.00) + convenience fee TAXABLE at 18% (118.00) = 618.00. */
const SEEDED_618: PriceQuoteComponentRow[] = [
  component(),
  component({
    position: 2,
    code: 'convenience_fee',
    label: 'Convenience fee',
    grossAmount: '100.00',
    taxableValue: '100.00',
    taxTreatment: 'taxable',
    taxRatePct: '18.00',
    cgstAmount: '9.00',
    sgstAmount: '9.00',
    lineTotal: '118.00',
    basis: 'percent_of',
    basisPct: '20.00',
    basisCodes: ['doctor_fee'],
  }),
];

/* ========================================================================== */

describe('refund apportionment — a full refund of a 618.00 bill', () => {
  /**
   * *** THE ACCEPTANCE CASE: A FULL REFUND OF A 618.00 BILL RETURNS 618.00. ***
   *
   * And it reverses exactly the tax that was charged: 18.00, split 9.00 / 9.00,
   * against 600.00 of taxable value.
   */
  it('returns the whole 618.00 and reverses exactly the tax that was charged', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 61_800n,
      alreadyRefundedByCode: {},
    });

    expect(result.amount).toBe('618.00');
    expect(result.taxableValue).toBe('600.00');
    expect(result.cgstAmount).toBe('9.00');
    expect(result.sgstAmount).toBe('9.00');
    expect(result.igstAmount).toBe('0.00');
    expect(result.exhaustive).toBe(true);

    // Every line balances — `refund_components_balances`.
    for (const line of result.components) {
      const sum =
        Number(line.taxableValue) + Number(line.cgstAmount) + Number(line.sgstAmount) + Number(line.igstAmount);
      expect(sum.toFixed(2)).toBe(line.amount);
    }
  });

  /** The EXEMPT line reverses no tax at all — the whole share is taxable value. */
  it('reverses no tax against the exempt doctor fee', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 61_800n,
      alreadyRefundedByCode: {},
    });

    const doctorFee = result.components.find((line) => line.code === 'doctor_fee');
    expect(doctorFee).toEqual({
      code: 'doctor_fee',
      amount: '500.00',
      taxableValue: '500.00',
      taxRatePct: '0.00',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '0.00',
    });
  });

  /**
   * *** A REQUEST LARGER THAN THE REMAINDER IS CLAMPED TO THE REMAINDER, NOT
   * REFUSED HERE. *** The invariant that a refund may not exceed the capture is
   * enforced in `RefundService` under the payment's row lock; this function's
   * job is to apportion whatever it is given, exactly.
   */
  it('clamps to the exact remainder when asked for more than is left', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 99_999n,
      alreadyRefundedByCode: {},
    });
    expect(result.amount).toBe('618.00');
    expect(result.exhaustive).toBe(true);
  });
});

/* ========================================================================== */

describe('refund apportionment — partial refunds', () => {
  /**
   * A partial refund is split by LARGEST REMAINDER, weighted by each line's
   * remaining capacity, so the shares sum to the refund EXACTLY.
   */
  it('splits a partial refund across lines so the shares sum exactly', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 30_000n,
      alreadyRefundedByCode: {},
    });

    expect(result.amount).toBe('300.00');
    const total = result.components.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
    expect(total).toBe(30_000);
  });

  /**
   * *** "REFUND THE REST" LANDS EXACTLY ON ZERO. ***
   *
   * The second refund uses each line's EXACT remainder rather than a percentage.
   * A largest-remainder split of a rounded percentage would leave a stray paise
   * on some line and the payment would sit at `partially_refunded` for one paise
   * forever.
   */
  it('lands exactly on zero when the rest is refunded after a partial', () => {
    const first = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 30_000n,
      alreadyRefundedByCode: {},
    });

    const already = Object.fromEntries(first.components.map((line) => [line.code, line.amount]));

    const second = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      // Ask for more than is left; the exact-remainder branch takes over.
      requestedPaise: 61_800n,
      alreadyRefundedByCode: already,
    });

    expect(second.exhaustive).toBe(true);
    // The two together return the whole capture, to the paise.
    const firstPaise = Math.round(Number(first.amount) * 100);
    const secondPaise = Math.round(Number(second.amount) * 100);
    expect(firstPaise + secondPaise).toBe(61_800);

    // And the two tax reversals together are exactly the tax originally charged.
    const cgst = Number(first.cgstAmount) + Number(second.cgstAmount);
    const sgst = Number(first.sgstAmount) + Number(second.sgstAmount);
    expect(cgst.toFixed(2)).toBe('9.00');
    expect(sgst.toFixed(2)).toBe('9.00');
  });

  /**
   * *** REGRESSION: THE HEADS DRIFTED WHEN A LINE WAS REFUNDED IN UNEVEN STEPS. ***
   *
   * The reversal used to be backed out of each SLICE independently, so N partial
   * refunds of one line reversed `sum(backOut(slice_i))` where the invoice had
   * charged `backOut(sum(slice_i))`. Round-then-sum is not sum-then-round, and
   * the CGST/SGST error is SYSTEMATIC rather than random: `halveHalfUp` hands the
   * odd paise to CGST on every slice.
   *
   * The 300.00-then-the-rest case above splits evenly and happens to come out
   * right, which is exactly why it never caught this. 100.00 then the rest does
   * not: the convenience line goes 19.09 + 98.91, and the old code reversed
   * CGST 1.46 + 7.55 = 9.01 against SGST 1.45 + 7.54 = 8.99 — on an invoice that
   * charged 9.00 and 9.00.
   *
   * The refunded RUPEES were always right; it is the credit note's head split
   * that disagreed with the invoice it credits, which is a GSTR-1 reconciliation
   * problem rather than a rounding curiosity.
   */
  it('reverses exactly the heads that were charged when the steps are uneven', () => {
    const first = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 10_000n,
      alreadyRefundedByCode: {},
    });

    const convenienceFirst = first.components.find((line) => line.code === 'convenience_fee');
    expect(convenienceFirst?.amount).toBe('19.09');
    expect(convenienceFirst?.cgstAmount).toBe('1.46');
    expect(convenienceFirst?.sgstAmount).toBe('1.45');

    const second = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 51_800n,
      alreadyRefundedByCode: Object.fromEntries(first.components.map((line) => [line.code, line.amount])),
    });

    // The closing slice of the line reverses the SNAPSHOT less what already went
    // back, so the series lands on the invoice rather than near it.
    const convenienceSecond = second.components.find((line) => line.code === 'convenience_fee');
    expect(convenienceSecond?.amount).toBe('98.91');
    expect(convenienceSecond?.cgstAmount).toBe('7.54');
    expect(convenienceSecond?.sgstAmount).toBe('7.55');

    expect(Number(first.amount) + Number(second.amount)).toBeCloseTo(618, 5);
    // *** THE ASSERTION THAT WAS RED BEFORE THE FIX: 9.01 / 8.99. ***
    expect((Number(first.cgstAmount) + Number(second.cgstAmount)).toFixed(2)).toBe('9.00');
    expect((Number(first.sgstAmount) + Number(second.sgstAmount)).toFixed(2)).toBe('9.00');
    expect((Number(first.taxableValue) + Number(second.taxableValue)).toFixed(2)).toBe('600.00');
  });

  /**
   * The same statement as a property, over every way of cutting the taxable line
   * in two. Half of the 11 799 split points drifted before the fix.
   */
  it('closes on the invoice for EVERY two-step split of the taxable line', () => {
    const drifted: string[] = [];

    for (let firstPaise = 1; firstPaise < 11_800; firstPaise += 1) {
      const first = apportion({
        components: [SEEDED_618[1]],
        placeOfSupplyKind: 'intra_state',
        requestedPaise: BigInt(firstPaise),
        alreadyRefundedByCode: {},
      });
      const second = apportion({
        components: [SEEDED_618[1]],
        placeOfSupplyKind: 'intra_state',
        requestedPaise: BigInt(11_800 - firstPaise),
        alreadyRefundedByCode: { convenience_fee: first.amount },
      });

      const cgst = (Number(first.cgstAmount) + Number(second.cgstAmount)).toFixed(2);
      const sgst = (Number(first.sgstAmount) + Number(second.sgstAmount)).toFixed(2);
      const taxable = (Number(first.taxableValue) + Number(second.taxableValue)).toFixed(2);
      if (cgst !== '9.00' || sgst !== '9.00' || taxable !== '100.00') {
        drifted.push(`${firstPaise}: cgst=${cgst} sgst=${sgst} taxable=${taxable}`);
      }
    }

    expect(drifted).toEqual([]);
  });

  it('never takes more from a line than that line still has', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 61_800n,
      alreadyRefundedByCode: { doctor_fee: '500.00' },
    });

    // The doctor fee is exhausted, so the whole remainder comes from the
    // convenience line.
    expect(result.amount).toBe('118.00');
    expect(result.components).toHaveLength(1);
    expect(result.components[0].code).toBe('convenience_fee');
  });
});

/* ========================================================================== */

describe('refund apportionment — the place-of-supply split', () => {
  const interState: PriceQuoteComponentRow[] = [
    component({ taxTreatment: 'exempt' }),
    component({
      position: 2,
      code: 'convenience_fee',
      grossAmount: '100.00',
      taxableValue: '100.00',
      taxTreatment: 'taxable',
      taxRatePct: '18.00',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '18.00',
      lineTotal: '118.00',
    }),
  ];

  it('reverses an inter-state supply as IGST, never as CGST + SGST', () => {
    const result = apportion({
      components: interState,
      placeOfSupplyKind: 'inter_state',
      requestedPaise: 61_800n,
      alreadyRefundedByCode: {},
    });

    expect(result.igstAmount).toBe('18.00');
    expect(result.cgstAmount).toBe('0.00');
    expect(result.sgstAmount).toBe('0.00');
  });

  /**
   * A PARTIAL refund backs the tax out proportionally, and the two heads still
   * sum to the tax being reversed — CGST computed, SGST residual, exactly as the
   * original invoice was split.
   */
  it('splits a partial reversal into heads that sum to the tax reversed', () => {
    const result = apportion({
      components: SEEDED_618,
      placeOfSupplyKind: 'intra_state',
      requestedPaise: 5_900n, // half the convenience line, after the exempt line takes its share
      alreadyRefundedByCode: { doctor_fee: '500.00' },
    });

    const line = result.components[0];
    const taxable = Math.round(Number(line.taxableValue) * 100);
    const cgst = Math.round(Number(line.cgstAmount) * 100);
    const sgst = Math.round(Number(line.sgstAmount) * 100);
    expect(taxable + cgst + sgst).toBe(5_900);
    // 59.00 inclusive of 18% backs out to 50.00 + 9.00.
    expect(line.taxableValue).toBe('50.00');
    expect(cgst + sgst).toBe(900);
  });
});

/* ========================================================================== */

describe('PricingRefundService.refundAmountForPct — THE REFUND BASE CHANGED', () => {
  function serviceWith(quote: Partial<PriceQuoteRow>): PricingRefundService {
    const quotes = {
      findById: jest.fn().mockResolvedValue({
        id: 'q1',
        totalPayable: '618.00',
        placeOfSupplyKind: 'intra_state',
        ...quote,
      }),
      findComponents: jest.fn().mockResolvedValue(SEEDED_618),
    } as unknown as jest.Mocked<PriceQuoteRepository>;
    return new PricingRefundService(quotes, noopRefundComponents);
  }

  /**
   * *** THE COMMERCIAL CHANGE, PINNED AS A TEST. ***
   *
   * `booking-policy.engine.ts`'s `refundPct` has always meant "percent of the
   * CONSULTATION FEE" — a 100% tier returned 500.00 of a 618.00 bill. It now
   * means percent of the CAPTURED TOTAL.
   *
   * This is NOT a bug fix. It changes what the published cancellation policy
   * pays out and it needs the client's sign-off.
   */
  it('returns the WHOLE 618.00 for a 100% tier, not the 500.00 fee', async () => {
    expect(await serviceWith({}).refundAmountForPct({ quoteId: 'q1', pct: 100 })).toBe('618.00');
  });

  it('takes a 50% tier from the captured total', async () => {
    expect(await serviceWith({}).refundAmountForPct({ quoteId: 'q1', pct: 50 })).toBe('309.00');
  });

  /** Rounded once, half-up, in integer paise — which favours the patient on a tie. */
  it('rounds half-up, once', async () => {
    // 25% of 618.00 is 154.50 exactly; 33% is 203.94.
    expect(await serviceWith({}).refundAmountForPct({ quoteId: 'q1', pct: 25 })).toBe('154.50');
    expect(await serviceWith({}).refundAmountForPct({ quoteId: 'q1', pct: 33 })).toBe('203.94');
  });

  /**
   * Degrades rather than throwing, the way `refundAmountFor` does: a caller
   * treats a zero refund as "nothing to refund" and carries on cancelling.
   */
  it('degrades a nonsensical percentage to 0.00 rather than throwing', async () => {
    const service = serviceWith({});
    expect(await service.refundAmountForPct({ quoteId: 'q1', pct: -5 })).toBe('0.00');
    expect(await service.refundAmountForPct({ quoteId: 'q1', pct: Number.NaN })).toBe('0.00');
    expect(await service.refundAmountForPct({ quoteId: 'q1', pct: 500 })).toBe('0.00');
  });
});
