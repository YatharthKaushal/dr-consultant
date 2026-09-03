import { MoneyFormatError } from './money.util';
import { allocateLargestRemainder, halveHalfUp, inclusiveTaxableValue } from './money-allocate.util';

/**
 * The two properties everything here exists to guarantee:
 *
 *   1. A split is EXACT. `taxable + tax === gross`, `cgst + sgst === tax`, and
 *      `sum(shares) === target`. No paise is lost or invented.
 *   2. It is DETERMINISTIC. The same inputs always produce the same split, so a
 *      retried refund cannot produce a second, different credit note.
 */
describe('money allocation and inclusive tax back-out', () => {
  describe('inclusiveTaxableValue', () => {
    /** 118.00 inclusive of 18% is exactly 100.00 + 18.00 — the clean case with no rounding at all. */
    it('backs a clean inclusive amount out exactly', () => {
      const gross = 11800n;
      const taxable = inclusiveTaxableValue(gross, 1800n);

      expect(taxable).toBe(10000n);
      expect(gross - taxable).toBe(1800n);
    });

    /**
     * THE CASE THAT FORCES TAX TO BE A RESIDUAL. 100.00 inclusive of 18% backs
     * out to 84.75, so the tax is 15.25. Computing the tax independently as
     * `round(8475 x 18%)` would give 1526 and the line would total 10001 — one
     * paise more than was actually charged.
     */
    it('leaves a residual tax that balances, where a second rounding would not', () => {
      const gross = 10000n;
      const taxable = inclusiveTaxableValue(gross, 1800n);
      const tax = gross - taxable;

      expect(taxable).toBe(8475n);
      expect(tax).toBe(1525n);
      expect(taxable + tax).toBe(gross);

      // What a naive second rounding would have produced, and why it is refused.
      const independentlyRounded = (taxable * 1800n + 5000n) / 10000n;
      expect(independentlyRounded).toBe(1526n);
      expect(taxable + independentlyRounded).not.toBe(gross);
    });

    /** A share produced by refund apportionment, which is where the awkward amounts turn up. */
    it('backs out an awkward apportioned share and still balances', () => {
      const gross = 3933n;
      const taxable = inclusiveTaxableValue(gross, 1800n);

      expect(taxable).toBe(3333n);
      expect(gross - taxable).toBe(600n);
      expect(taxable + (gross - taxable)).toBe(gross);
    });

    /** An exempt component must come back bit-for-bit unchanged, not merely equal. */
    it('returns the amount untouched at a zero rate', () => {
      expect(inclusiveTaxableValue(50000n, 0n)).toBe(50000n);
      expect(inclusiveTaxableValue(0n, 1800n)).toBe(0n);
    });

    it('refuses negative operands rather than producing a negative bill', () => {
      expect(() => inclusiveTaxableValue(-1n, 1800n)).toThrow(MoneyFormatError);
      expect(() => inclusiveTaxableValue(100n, -1n)).toThrow(MoneyFormatError);
    });

    /**
     * The invariant that matters more than any single number: across every rate
     * and amount, backing out and adding the residual must reproduce the input
     * exactly, and the taxable value must never exceed it.
     */
    it('always balances, for every rate and amount in a wide sweep', () => {
      // Collect failures and assert ONCE. A per-iteration `expect` dominates the
      // runtime here (~11s versus ~0.2s) for no extra coverage, and a slow unit
      // test is a test people stop running.
      const failures: string[] = [];

      for (let rate = 0n; rate <= 2800n; rate += 25n) {
        for (let gross = 0n; gross <= 5000n; gross += 7n) {
          const taxable = inclusiveTaxableValue(gross, rate);
          if (taxable + (gross - taxable) !== gross || taxable > gross) {
            failures.push(`rate=${rate} gross=${gross} taxable=${taxable}`);
          }
        }
      }

      expect(failures).toEqual([]);
    });
  });

  describe('halveHalfUp — the CGST/SGST split', () => {
    /** An odd tax cannot be halved evenly; the odd paise goes to CGST and SGST takes the residual. */
    it('puts the odd paise on the computed half, and the two still sum to the tax', () => {
      const tax = 599n;
      const cgst = halveHalfUp(tax);
      const sgst = tax - cgst;

      expect(cgst).toBe(300n);
      expect(sgst).toBe(299n);
      expect(cgst + sgst).toBe(tax);
    });

    it('splits an even tax evenly', () => {
      expect(halveHalfUp(1800n)).toBe(900n);
      expect(1800n - halveHalfUp(1800n)).toBe(900n);
    });

    it('splits the residual-tax case from the inclusive example', () => {
      expect(halveHalfUp(1525n)).toBe(763n);
      expect(1525n - halveHalfUp(1525n)).toBe(762n);
    });

    it('halves zero to zero', () => {
      expect(halveHalfUp(0n)).toBe(0n);
    });

    it('refuses a negative amount', () => {
      expect(() => halveHalfUp(-2n)).toThrow(MoneyFormatError);
    });

    it('always sums back to the original, odd or even', () => {
      const failures: string[] = [];

      for (let tax = 0n; tax <= 2000n; tax += 1n) {
        const cgst = halveHalfUp(tax);
        if (cgst + (tax - cgst) !== tax) {
          failures.push(`tax=${tax} cgst=${cgst}`);
        }
      }

      expect(failures).toEqual([]);
    });
  });

  describe('allocateLargestRemainder', () => {
    /**
     * The worked case from the refund design: apportioning 205.98 across a
     * 500.00 exempt fee and a 118.00 tax-inclusive convenience line. Flooring
     * both shares loses one paise, which goes to the larger remainder.
     */
    it('hands the leftover paise to the largest remainder', () => {
      const shares = allocateLargestRemainder(20598n, [50000n, 11800n]);

      expect(shares).toEqual([16665n, 3933n]);
      expect(shares[0] + shares[1]).toBe(20598n);
    });

    it('splits exactly when every share divides evenly', () => {
      const shares = allocateLargestRemainder(30900n, [50000n, 11800n]);

      expect(shares).toEqual([25000n, 5900n]);
      expect(shares[0] + shares[1]).toBe(30900n);
    });

    /** THE POINT OF THE WHOLE FUNCTION. Whatever the weights, nothing is lost or invented. */
    it('always sums to exactly the target', () => {
      const weightSets = [
        [1n, 1n, 1n],
        [50000n, 11800n],
        [7n, 11n, 13n, 17n],
        [1n, 999999n],
        [0n, 5n, 5n],
      ];
      // One assertion at the end — see the note on the back-out sweep above.
      const failures: string[] = [];

      for (const weights of weightSets) {
        for (let target = 0n; target <= 300n; target += 1n) {
          const shares = allocateLargestRemainder(target, weights);
          const summed = shares.reduce((sum, share) => sum + share, 0n);
          if (summed !== target || shares.some((share) => share < 0n)) {
            failures.push(`weights=[${weights.join(',')}] target=${target} -> [${shares.join(',')}]`);
          }
        }
      }

      expect(failures).toEqual([]);
    });

    /**
     * A retried refund must apportion identically, or one event produces two
     * different credit notes. Equal remainders therefore break on ascending
     * index rather than on sort order.
     */
    it('is deterministic, and breaks ties on the earlier line', () => {
      const first = allocateLargestRemainder(10n, [1n, 1n, 1n]);
      const second = allocateLargestRemainder(10n, [1n, 1n, 1n]);

      expect(first).toEqual(second);
      // 10 across three equal lines: 3 each, one paise left, to the first.
      expect(first).toEqual([4n, 3n, 3n]);
    });

    it('gives a zero-weight line nothing', () => {
      expect(allocateLargestRemainder(100n, [0n, 1n])).toEqual([0n, 100n]);
    });

    it('allocates nothing across zero weights when there is nothing to allocate', () => {
      expect(allocateLargestRemainder(0n, [0n, 0n])).toEqual([0n, 0n]);
    });

    /** Silently dropping the money would be far worse than refusing. */
    it('refuses to allocate a non-zero amount across zero weights', () => {
      expect(() => allocateLargestRemainder(100n, [0n, 0n])).toThrow(MoneyFormatError);
    });

    it('refuses a negative target or a negative weight', () => {
      expect(() => allocateLargestRemainder(-1n, [1n])).toThrow(MoneyFormatError);
      expect(() => allocateLargestRemainder(10n, [1n, -1n])).toThrow(MoneyFormatError);
    });

    it('handles an empty weight list', () => {
      expect(allocateLargestRemainder(0n, [])).toEqual([]);
      expect(() => allocateLargestRemainder(5n, [])).toThrow(MoneyFormatError);
    });
  });

  /**
   * The two helpers compose into one bill line, which is how pricing will use
   * them: apportion, back the tax out of each share, then split the heads.
   */
  describe('composed — apportion, back out, split heads', () => {
    it('keeps every level balanced on a 33.33% refund of a 618.00 bill', () => {
      const target = 20598n; // 33.33% of 61800, half-up
      const shares = allocateLargestRemainder(target, [50000n, 11800n]);

      // The doctor's fee is exempt: the whole share is taxable value, no tax.
      const feeTaxable = inclusiveTaxableValue(shares[0], 0n);
      const feeTax = shares[0] - feeTaxable;

      // The convenience fee carries 18%, embedded in the captured amount.
      const convTaxable = inclusiveTaxableValue(shares[1], 1800n);
      const convTax = shares[1] - convTaxable;
      const cgst = halveHalfUp(convTax);
      const sgst = convTax - cgst;

      expect(feeTax).toBe(0n);
      expect(convTaxable).toBe(3333n);
      expect(convTax).toBe(600n);
      expect(cgst).toBe(300n);
      expect(sgst).toBe(300n);

      // Every level balances: heads to tax, taxable+tax to share, shares to target.
      expect(cgst + sgst).toBe(convTax);
      expect(convTaxable + convTax).toBe(shares[1]);
      expect(feeTaxable + feeTax).toBe(shares[0]);
      expect(shares[0] + shares[1]).toBe(target);
    });
  });
});
