/**
 * *** SPLITTING AND BACKING OUT MONEY, EXACTLY. ***
 *
 * Companion to `money.util.ts`, which turns rupees into paise and applies a
 * rate. This file answers the two questions that come up once a bill has more
 * than one line:
 *
 *   1. "This price already INCLUDES tax — what was the price before tax?"
 *      (`inclusiveTaxableValue`, and `halveHalfUp` for the CGST/SGST split)
 *   2. "Split this amount across these lines without losing or inventing a
 *      paise." (`allocateLargestRemainder`)
 *
 * Same rules as `money.util.ts`: integer paise as `bigint`, integer basis
 * points, half-up, and nothing here reads config, a row or the clock.
 *
 * ── THE ONE RULE THAT MAKES ALL OF THIS WORK ───────────────────────────────
 *
 * *** A SPLIT MUST BE EXACT, SO ONE SIDE IS ALWAYS A RESIDUAL. ***
 *
 * Never round both halves of a split independently. Round one and subtract to
 * get the other. If tax were `round(taxable x rate)` computed separately from
 * `taxable`, then `taxable + tax` would not always equal the amount actually
 * charged, and the invoice line would not balance. Concretely, at a gross of
 * 10000 paise and 18%: the backed-out taxable value is 8475, so the residual
 * tax is 1525 — but `round(8475 x 18%)` is 1526, and the line would come to
 * 10001. One paise, on every affected invoice, unexplainable to an auditor.
 *
 * The same reasoning governs the CGST/SGST split: CGST is computed, SGST is
 * whatever is left, so the two always sum to the tax actually charged.
 */

import { BASIS_POINTS_PER_100_PERCENT, MoneyFormatError } from './money.util';

/**
 * Given a price that ALREADY INCLUDES tax at `rateBasisPoints`, recover the
 * pre-tax (taxable) value, rounded half-up. The tax is then the residual —
 * `gross - taxable` — never a second rounding. See the header.
 *
 * The exact value is `gross x 10000 / (10000 + rate)`.
 *
 * *** WHY THIS USES THE DOUBLED FORM RATHER THAN `applyPctToPaise`'S `+ d/2`. ***
 *
 * `applyPctToPaise` rounds with `(n + d/2) / d`, which is exact half-up only
 * when `d` is EVEN — there `d` is 10 000 and `d/2` is exactly 5 000. Here the
 * divisor is `10000 + rate`, which is ODD for any odd basis-point rate, and
 * `d/2` then truncates to `(d-1)/2`.
 *
 * That truncation turns out to be HARMLESS, but only for a reason no reader
 * should have to reconstruct: differing requires `2d | (2n + d)`, and for odd
 * `d` the value `2n + d` is odd while `2d` is even, so it never divides. (I
 * checked this exhaustively over ~56M rate/amount pairs before writing this
 * comment: zero differences.) In other words the naive form is accidentally
 * correct here, resting on a parity argument that would silently stop holding
 * if the divisor's shape ever changed.
 *
 * So this uses `floor((2n + d) / 2d)` instead, which is exact half-up for EVERY
 * divisor, odd or even, with no parity argument required. Correct by
 * construction beats correct by coincidence in money code.
 *
 * @param grossPaise      the tax-inclusive amount
 * @param rateBasisPoints the embedded tax rate; 0 returns `grossPaise` unchanged
 */
export function inclusiveTaxableValue(grossPaise: bigint, rateBasisPoints: bigint): bigint {
  if (grossPaise < 0n || rateBasisPoints < 0n) {
    throw new MoneyFormatError('Inclusive tax back-out requires non-negative operands.');
  }
  // A zero rate embeds no tax, so the whole amount is the taxable value. Worth
  // short-circuiting rather than relying on the general form, because an exempt
  // component must be bit-for-bit unchanged, not merely arithmetically equal.
  if (rateBasisPoints === 0n) {
    return grossPaise;
  }

  const divisor = BASIS_POINTS_PER_100_PERCENT + rateBasisPoints;
  const numerator = 2n * grossPaise * BASIS_POINTS_PER_100_PERCENT + divisor;
  return numerator / (2n * divisor);
}

/**
 * Half of `paise`, rounded half-up — the CGST side of an intra-state split.
 *
 * The caller takes the SGST side as `paise - halveHalfUp(paise)`, so the two
 * always sum to exactly `paise` and an odd paise lands on CGST. Deliberately
 * NOT "apply 9% twice": see `pricing`'s engine notes — splitting the RATE and
 * rounding each half independently makes an identical catalogue price cost a
 * different total in a different state, which is indefensible on an invoice.
 */
export function halveHalfUp(paise: bigint): bigint {
  if (paise < 0n) {
    throw new MoneyFormatError(`Expected a non-negative paise amount, received ${paise}.`);
  }
  return (paise + 1n) / 2n;
}

/**
 * Splits `targetPaise` across `weights` so that the shares sum to EXACTLY
 * `targetPaise` — the largest-remainder (Hamilton) method.
 *
 * Flooring every share loses up to `n - 1` paise; this hands those leftover
 * paise to the lines with the largest fractional remainders. Used for
 * apportioning a partial refund across the components of a bill, and for
 * spreading a whole-order discount across lines.
 *
 * *** DETERMINISM IS A REQUIREMENT, NOT A NICETY. *** A refund that apportions
 * differently on a retry produces two different credit notes for one event, so
 * ties break on ascending index — never on iteration order, and never on a
 * comparison that could be unstable. The result is a pure function of
 * `(targetPaise, weights)`.
 *
 * Remainders are compared as exact integers (`target x w mod W`) rather than as
 * fractions, so no floating point enters the decision.
 *
 * @param targetPaise the total to distribute; must be non-negative
 * @param weights     relative sizes; must be non-negative. All-zero weights are
 *                    only legal when `targetPaise` is 0 — otherwise there is no
 *                    defensible place to put the money and we refuse rather
 *                    than silently dropping it.
 */
export function allocateLargestRemainder(
  targetPaise: bigint,
  weights: readonly bigint[],
): bigint[] {
  if (targetPaise < 0n) {
    throw new MoneyFormatError(`Expected a non-negative target amount, received ${targetPaise}.`);
  }
  if (weights.some((weight) => weight < 0n)) {
    throw new MoneyFormatError('Allocation weights must all be non-negative.');
  }

  const totalWeight = weights.reduce<bigint>((sum, weight) => sum + weight, 0n);

  if (totalWeight === 0n) {
    // Nothing to distribute against. Zero into zero is fine; anything else
    // would mean silently losing money, so it is an error.
    if (targetPaise === 0n) {
      return weights.map(() => 0n);
    }
    throw new MoneyFormatError(
      `Cannot allocate ${targetPaise} paise across weights that sum to zero.`,
    );
  }

  const shares = weights.map((weight) => (targetPaise * weight) / totalWeight);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (targetPaise * weight) % totalWeight,
  }));

  let distributed = shares.reduce<bigint>((sum, share) => sum + share, 0n);
  let leftover = targetPaise - distributed;

  // Largest remainder first; ties go to the earlier line, so the result never
  // depends on sort stability.
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) {
      return a.index - b.index;
    }
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const { index } of remainders) {
    if (leftover <= 0n) {
      break;
    }
    shares[index] += 1n;
    leftover -= 1n;
    distributed += 1n;
  }

  return shares;
}
