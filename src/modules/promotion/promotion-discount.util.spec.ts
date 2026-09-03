import { MoneyFormatError, rupeesToPaise } from '../../shared/money/money.util';
import { computeCommission, computeDiscount, subtractFloorZero } from './promotion-discount.util';

/**
 * *** THE ARITHMETIC. ROUND ONCE -> CAP -> CLAMP, IN THAT ORDER, IN PAISE. ***
 *
 * Every assertion here is an exact string. That is the point: a bill that is off
 * by one paise is a bill the client's CA has to explain, and a test that
 * asserted `toBeCloseTo` would pass for exactly the class of error
 * `shared/money/money.util.ts` exists to prevent.
 */
describe('promotion-discount.util', () => {
  const flat = (amount: string) => ({
    valueKind: 'flat' as const,
    flatAmount: amount,
    percentRate: null,
    maxDiscountAmount: null,
  });
  const percent = (rate: string, cap: string | null) => ({
    valueKind: 'percent' as const,
    flatAmount: null,
    percentRate: rate,
    maxDiscountAmount: cap,
  });

  describe('computeDiscount — flat', () => {
    it('takes the flat amount off and reports the residual', () => {
      const result = computeDiscount(flat('100.00'), rupeesToPaise('500.00'));
      expect(result.discountAmount).toBe('100.00');
      expect(result.residualDiscountable).toBe('400.00');
      expect(result.fullyDiscounted).toBe(false);
      expect(result.attributionOnly).toBe(false);
    });

    it('*** CLAMPS TO THE BASE: a 500 coupon on a 200 order is a 200 discount, not an error ***', () => {
      // `discount_redemptions_amount_check` enforces `discount_amount <=
      // discountable_base` in the database, so without this clamp a perfectly
      // ordinary "₹500 off" on a small order would be a FAILED INSERT inside the
      // reservation transaction rather than a discount.
      const result = computeDiscount(flat('500.00'), rupeesToPaise('200.00'));
      expect(result.discountAmount).toBe('200.00');
      expect(result.residualDiscountable).toBe('0.00');
      expect(result.fullyDiscounted).toBe(true);
    });

    it('*** CAN ZERO AN ORDER BUT NEVER INVERT ONE ***', () => {
      const result = computeDiscount(flat('999.99'), rupeesToPaise('0.00'));
      expect(result.discountAmount).toBe('0.00');
      expect(result.residualDiscountable).toBe('0.00');
      // "The platform pays the patient" is unrepresentable, not merely unlikely.
      expect(result.discountPaise >= 0n).toBe(true);
    });

    it('reports a zero-value code as attribution-only', () => {
      // Chiefly the affiliate case: a code whose only job is to record who sent
      // the patient. Pricing needs to know, because a zero discount that is
      // nonetheless "applied" changes what the checkout screen says.
      const result = computeDiscount(flat('0.00'), rupeesToPaise('500.00'));
      expect(result.attributionOnly).toBe(true);
      expect(result.discountAmount).toBe('0.00');
      expect(result.residualDiscountable).toBe('500.00');
    });
  });

  describe('computeDiscount — percentage', () => {
    it('applies the rate in integer basis points, exactly', () => {
      // 20% of 500.00 = 100.00. Done as 50000n * 2000n / 10000n, never
      // 500 * 0.2 in IEEE-754.
      expect(computeDiscount(percent('20', '1000.00'), rupeesToPaise('500.00')).discountAmount).toBe('100.00');
      expect(computeDiscount(percent('18.50', '1000.00'), rupeesToPaise('500.00')).discountAmount).toBe('92.50');
    });

    it('rounds HALF-UP, once, and the rounded figure is what feeds every later step', () => {
      // 33.33% of 100.00 = 33.33 exactly at the paise level (3333.0), and
      // 33.335% is not representable in numeric(5,2) so the nearest cases are
      // asserted instead.
      expect(computeDiscount(percent('12.5', '1000.00'), rupeesToPaise('10.01')).discountAmount).toBe('1.25');
      // 12.5% of 10.05 = 1.25625 -> 125.625 paise -> half-up -> 126 paise.
      expect(computeDiscount(percent('12.5', '1000.00'), rupeesToPaise('10.05')).discountAmount).toBe('1.26');
      // 12.5% of 10.04 = 125.5 paise exactly -> half-up -> 126 paise.
      expect(computeDiscount(percent('12.5', '1000.00'), rupeesToPaise('10.04')).discountAmount).toBe('1.26');
      // 12.5% of 10.03 = 125.375 paise -> half-up -> 125 paise.
      expect(computeDiscount(percent('12.5', '1000.00'), rupeesToPaise('10.03')).discountAmount).toBe('1.25');
    });

    it('*** CAPS THE ALREADY-ROUNDED FIGURE, NOT THE OTHER WAY ROUND ***', () => {
      // 50% of 1000.00 is 500.00, capped at 150.00. Capping before rounding
      // would produce the same answer here but not on every input, and a bill
      // must be reproducible from its stored components by exactly one route.
      const result = computeDiscount(percent('50', '150.00'), rupeesToPaise('1000.00'));
      expect(result.discountAmount).toBe('150.00');
      expect(result.residualDiscountable).toBe('850.00');
    });

    it('caps THEN clamps, so a cap larger than the base still cannot exceed it', () => {
      const result = computeDiscount(percent('90', '900.00'), rupeesToPaise('100.00'));
      expect(result.discountAmount).toBe('90.00');

      const clamped = computeDiscount(percent('100', '900.00'), rupeesToPaise('100.00'));
      expect(clamped.discountAmount).toBe('100.00');
      expect(clamped.fullyDiscounted).toBe(true);
    });

    it('never produces a float — every figure round-trips through numeric(10,2)', () => {
      for (const base of ['0.01', '0.99', '1.00', '33.33', '99999999.99']) {
        const result = computeDiscount(percent('18.50', '99999999.99'), rupeesToPaise(base));
        expect(result.discountAmount).toMatch(/^\d+\.\d{2}$/);
        expect(result.residualDiscountable).toMatch(/^\d+\.\d{2}$/);
        // The two halves must reconstitute the base exactly.
        expect(rupeesToPaise(result.discountAmount) + rupeesToPaise(result.residualDiscountable)).toBe(
          rupeesToPaise(base),
        );
      }
    });
  });

  describe('computeDiscount — genuine faults', () => {
    it('THROWS on a malformed stored value rather than folding it into a refusal', () => {
      // A `numeric` column that does not parse means the row is corrupt. A
      // refusal tells a patient to try something else, and there is nothing else
      // to try — so this is deliberately not swallowed.
      expect(() => computeDiscount(flat('not-money'), rupeesToPaise('500.00'))).toThrow(MoneyFormatError);
      expect(() => computeDiscount(percent('abc', '10.00'), rupeesToPaise('500.00'))).toThrow(MoneyFormatError);
    });
  });

  describe('computeCommission', () => {
    it('applies a percentage to the resolved base', () => {
      const result = computeCommission(
        { valueKind: 'percent', flatAmount: null, percentRate: '10', maxAmount: null },
        rupeesToPaise('100.00'),
      );
      expect(result.commissionAmount).toBe('10.00');
    });

    it('honours the per-booking ceiling', () => {
      const result = computeCommission(
        { valueKind: 'percent', flatAmount: null, percentRate: '50', maxAmount: '20.00' },
        rupeesToPaise('100.00'),
      );
      expect(result.commissionAmount).toBe('20.00');
    });

    it('*** CLAMPS A FLAT COMMISSION TO THE BASE, so an affiliate booking cannot be loss-making ***', () => {
      // Clamped rather than refused: the arrangement is the client's to strike,
      // and silently paying a NEGATIVE margin is worse than paying a smaller
      // commission.
      const result = computeCommission(
        { valueKind: 'flat', flatAmount: '500.00', percentRate: null, maxAmount: null },
        rupeesToPaise('80.00'),
      );
      expect(result.commissionAmount).toBe('80.00');
    });

    it('pays nothing on a zero base', () => {
      const result = computeCommission(
        { valueKind: 'percent', flatAmount: null, percentRate: '25', maxAmount: null },
        0n,
      );
      expect(result.commissionAmount).toBe('0.00');
      expect(result.commissionPaise).toBe(0n);
    });
  });

  describe('subtractFloorZero', () => {
    it('floors at zero, because a negative margin is a nonsense rather than a debt', () => {
      expect(subtractFloorZero(100n, 40n)).toBe(60n);
      expect(subtractFloorZero(40n, 100n)).toBe(0n);
      expect(subtractFloorZero(0n, 0n)).toBe(0n);
    });
  });
});
