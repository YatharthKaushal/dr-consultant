/**
 * *** THE MONEY ARITHMETIC. READ BEFORE CHANGING ANYTHING HERE. ***
 *
 * Every rupee figure this backend stores or shows is produced here, and the
 * rules are not stylistic:
 *
 *   1. ALL arithmetic happens in INTEGER PAISE, as `bigint`. Rupees are a
 *      presentation format, not a calculation format. `0.1 + 0.2 !== 0.3` in
 *      IEEE-754 and a bill that is off by one paise is a bill the client's CA
 *      has to explain.
 *   2. PERCENTAGES ARE INTEGER BASIS POINTS, never floats. Rate columns are
 *      `numeric(5,2)`, so `18.50` is a legal rate. Multiplying `50000 * 0.185`
 *      in floating point is precisely the class of error this file exists to
 *      prevent; `50000n * 1850n / 10000n` is exact.
 *   3. ROUNDING HAPPENS ONCE PER COMPONENT, half-up, and the rounded component
 *      is what feeds the next step. Recomputing a component from a stored total
 *      later would not necessarily reproduce it — which is why components are
 *      stored, not just their sum.
 *   4. NOTHING here reads config, a row, or the clock. Every function is pure,
 *      which is what makes a bill testable as arithmetic rather than as an
 *      integration.
 *
 * ── WHY THIS LIVES IN `shared/` ────────────────────────────────────────────
 *
 * It began life as `modules/payment/payment-money.util.ts`, which trapped the
 * only correct money arithmetic in the codebase inside one module. The visible
 * cost was real: `booking-policy.engine.ts` could not import it, so it grew its
 * own float-based refund calculation and sent the result to a payment gateway.
 *
 * `backend/README.md` §2 — "`src/shared` and `src/config` are imported by
 * modules and never import them" — and rule 4 above are the same statement from
 * two directions: a function of no config, no row and no clock is a shared
 * primitive by definition. Booking, payment, pricing and promotions all price
 * in paise, and there must be exactly one implementation of that.
 *
 * WHAT DELIBERATELY DID NOT MOVE: `calculateBill`. It encodes M-12's specific
 * two-component fee model (fee -> convenience -> GST-on-subtotal), which is a
 * DOMAIN rule, not a primitive. It stays in `modules/payment` beside the rows
 * it prices. Do not move it here "for symmetry".
 */

/** Paise in one rupee. */
const PAISE_PER_RUPEE = 100n;

/**
 * Basis points in 100%. A "basis point" here is one hundredth of one percent,
 * which is exactly the precision `numeric(5,2)` gives a rate column: `18.50`%
 * is 1850, `20.00`% is 2000.
 */
export const BASIS_POINTS_PER_100_PERCENT = 10_000n;

/**
 * `numeric(10,2)` holds at most 8 integer digits. Enforced on the way in so a
 * fee that could never be stored is refused where the error still names the
 * field, rather than as a Postgres `numeric field overflow` three calls later.
 */
const MAX_RUPEE_INTEGER_DIGITS = 8;

/** `numeric(5,2)` — at most 3 integer digits, so 0.00 to 999.99. */
const MAX_PCT_INTEGER_DIGITS = 3;

/** A non-negative decimal with at most 8 integer and at most 2 fractional digits. */
const RUPEE_PATTERN = new RegExp(`^\\d{1,${MAX_RUPEE_INTEGER_DIGITS}}(?:\\.\\d{1,2})?$`);

/** A non-negative decimal with at most 3 integer and at most 2 fractional digits. */
const PCT_PATTERN = new RegExp(`^\\d{1,${MAX_PCT_INTEGER_DIGITS}}(?:\\.\\d{1,2})?$`);

/** Thrown for a malformed money or rate input. Callers turn it into an HTTP 400/500 as appropriate — this layer stays free of Nest. */
export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyFormatError';
  }
}

/**
 * A decimal rupee string -> integer paise.
 *
 * STRING IN, NOT NUMBER IN, deliberately: `numeric` columns come back from
 * `pg` as strings precisely so no precision is lost, and accepting a `number`
 * here would invite a caller to `parseFloat` first and hand us a value that has
 * already drifted.
 *
 * Strict by design. `"500.005"`, `"-1"`, `"1e3"`, `"500."`, `""` and `"₹500"`
 * are all rejected rather than coerced: silently truncating a third decimal
 * place is how a rounding bug gets into a bill, and every legitimate caller
 * (a `numeric(10,2)` column, or a validated DTO) already produces this shape.
 */
export function rupeesToPaise(rupees: string): bigint {
  if (typeof rupees !== 'string' || !RUPEE_PATTERN.test(rupees)) {
    throw new MoneyFormatError(
      `Expected a non-negative rupee amount with at most ${MAX_RUPEE_INTEGER_DIGITS} integer and 2 decimal places, received ${JSON.stringify(rupees)}.`,
    );
  }

  const [whole, fraction = ''] = rupees.split('.');
  // Pad rather than parse: "500.5" is 50 paise in the fractional position, not 5.
  const paiseFraction = fraction.padEnd(2, '0');
  return BigInt(whole) * PAISE_PER_RUPEE + BigInt(paiseFraction);
}

/** Integer paise -> a `numeric(10,2)`-shaped rupee string. Always exactly two decimal places, so it round-trips through `rupeesToPaise` unchanged. */
export function paiseToRupees(paise: bigint): string {
  if (paise < 0n) {
    throw new MoneyFormatError(`Expected a non-negative paise amount, received ${paise}.`);
  }
  const whole = paise / PAISE_PER_RUPEE;
  const fraction = paise % PAISE_PER_RUPEE;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** A decimal percentage string -> integer basis points (hundredths of a percent). `"20"` and `"20.00"` both give 2000. */
export function pctToBasisPoints(pct: string): bigint {
  if (typeof pct !== 'string' || !PCT_PATTERN.test(pct)) {
    throw new MoneyFormatError(
      `Expected a non-negative percentage with at most ${MAX_PCT_INTEGER_DIGITS} integer and 2 decimal places, received ${JSON.stringify(pct)}.`,
    );
  }
  const [whole, fraction = ''] = pct.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Integer basis points -> a `numeric(5,2)`-shaped percentage string, for snapshotting the rate onto the row it priced. */
export function basisPointsToPct(basisPoints: bigint): string {
  if (basisPoints < 0n) {
    throw new MoneyFormatError(`Expected non-negative basis points, received ${basisPoints}.`);
  }
  const whole = basisPoints / 100n;
  const fraction = basisPoints % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * `base * pct`, in integer paise, rounded HALF-UP to the nearest paise.
 *
 * Half-up (0.5 rounds away from zero) rather than banker's rounding: it is what
 * `docs/SRS.md`'s worked example implies, it is what a human checking the bill
 * with a calculator will do, and Indian GST invoicing convention rounds half
 * up. Every input here is non-negative, so "away from zero" and "up" coincide
 * and no negative-number branch is needed.
 *
 * Exact because it is integer arithmetic throughout: `(n + d/2) / d` with
 * truncating bigint division IS half-up for non-negative `n`.
 *
 * *** THE `+ d/2` TRICK IS ONLY UNCONDITIONALLY EXACT FOR AN EVEN DIVISOR. ***
 * Here the divisor is 10 000, so `d/2` is exactly 5 000 and an exact half
 * rounds up — no caveat needed. For an ODD divisor `d/2` truncates, and while
 * that happens to stay correct on a parity argument, relying on it is fragile.
 * `inclusiveTaxableValue` in `money-allocate.util.ts` divides by `10000 + rate`
 * and uses the unconditionally-exact doubled form instead; see its header.
 */
export function applyPctToPaise(basePaise: bigint, pctBasisPoints: bigint): bigint {
  if (basePaise < 0n || pctBasisPoints < 0n) {
    throw new MoneyFormatError('Percentage arithmetic requires non-negative operands.');
  }
  const numerator = basePaise * pctBasisPoints;
  const half = BASIS_POINTS_PER_100_PERCENT / 2n;
  return (numerator + half) / BASIS_POINTS_PER_100_PERCENT;
}

/**
 * Rupees -> the integer paise Razorpay's API speaks.
 *
 * THE GATEWAY BOUNDARY, and the only place the conversion is allowed to happen
 * — `refunds.schema.ts` is explicit that "the paise conversion belongs at the
 * gateway boundary where Razorpay's integer-paise API is spoken, not in
 * storage". Returns a `number` because that is what JSON carries; safe because
 * `numeric(10,2)`'s ceiling is ~1e10 paise, three orders of magnitude below
 * `Number.MAX_SAFE_INTEGER`, and asserted rather than assumed.
 */
export function paiseToGatewayAmount(paise: bigint): number {
  if (paise < 0n) {
    throw new MoneyFormatError(`Expected a non-negative paise amount, received ${paise}.`);
  }
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyFormatError(`Amount ${paise} paise exceeds the safe integer range for a JSON request body.`);
  }
  return Number(paise);
}

/** The gateway's integer paise -> `bigint`, for comparing what Razorpay says was charged against what we calculated. Rejects a non-integer rather than truncating it. */
export function gatewayAmountToPaise(amount: unknown): bigint {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new MoneyFormatError(`Expected a non-negative integer paise amount from the gateway, received ${JSON.stringify(amount)}.`);
  }
  return BigInt(amount);
}

/** Sums a list of `numeric(10,2)` rupee strings exactly, in paise. Used for "how much of this payment has already been refunded". */
export function sumRupees(amounts: readonly string[]): bigint {
  return amounts.reduce<bigint>((total, amount) => total + rupeesToPaise(amount), 0n);
}
