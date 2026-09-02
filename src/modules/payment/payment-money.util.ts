/**
 * *** THE MONEY ARITHMETIC. READ BEFORE CHANGING ANYTHING HERE. ***
 *
 * Every rupee figure this module stores or shows is produced here, and the
 * rules are not stylistic:
 *
 *   1. ALL arithmetic happens in INTEGER PAISE, as `bigint`. Rupees are a
 *      presentation format, not a calculation format. `0.1 + 0.2 !== 0.3` in
 *      IEEE-754 and a bill that is off by one paise is a bill the client's CA
 *      has to explain.
 *   2. PERCENTAGES ARE INTEGER BASIS POINTS, never floats. `convenience_fee_pct`
 *      and `gst_pct` are `numeric(5,2)`, so `18.50` is a legal rate. Multiplying
 *      `50000 * 0.185` in floating point is precisely the class of error this
 *      file exists to prevent; `50000n * 1850n / 10000n` is exact.
 *   3. ROUNDING HAPPENS ONCE PER COMPONENT, half-up, and the rounded component
 *      is what feeds the next step. The convenience fee is rounded before the
 *      subtotal is formed, and GST is charged on that ROUNDED subtotal — which
 *      is what `payments.convenience_fee`'s schema comment means by "stored
 *      because rounding must not be recomputed". Recomputing a component from
 *      the stored total later would not necessarily reproduce it.
 *   4. NOTHING here reads config, a row, or the clock. It is a pure function of
 *      (fee, convenience pct, gst pct), which is what makes FR-7.3 testable as
 *      arithmetic rather than as an integration.
 *
 * ── FR-7.3 IS AN ACCEPTANCE CRITERION, NOT AN EXAMPLE ──────────────────────
 *
 * `docs/SRS.md` FR-7.3: "Worked example at a fee of 500 rupees: convenience fee
 * is 20 percent, which is 100 rupees; subtotal is 600 rupees; GST at 18 percent
 * exclusive is 108 rupees; final patient payable is 708 rupees."
 *
 * `docs/MODULES.md` M-12's done-when repeats it: "the worked example in the SRS
 * reproduces exactly". `payment-money.util.spec.ts` asserts those five numbers
 * literally. GST is EXCLUSIVE and charged on the SUBTOTAL (fee + convenience),
 * not on the fee alone — 18% of 600 is 108, whereas 18% of 500 would be 90 and
 * the total would come out at 690, not 708. That is the arithmetic the worked
 * example pins down.
 *
 * FR-7.4's doctor payout view is the same numbers read differently: the doctor
 * receives `consultationFee` in full, platform deduction is zero. There is no
 * calculation for it, which is why there is no function for it here — the
 * payout IS `payments.consultation_fee`.
 *
 * ── Why there is no stored total column ────────────────────────────────────
 *
 * `payments` stores fee, convenience fee, GST and both rates, but no total.
 * The total is their sum and a stored copy could disagree with its own
 * components after a partial refund or a manual correction. `PaymentBreakdown.
 * totalPayable` is computed on read, every time, from the stored components.
 */

/** Paise in one rupee. */
const PAISE_PER_RUPEE = 100n;

/**
 * Basis points in 100%. A "basis point" here is one hundredth of one percent,
 * which is exactly the precision `numeric(5,2)` gives a rate column: `18.50`%
 * is 1850, `20.00`% is 2000.
 */
const BASIS_POINTS_PER_100_PERCENT = 10_000n;

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

/** Integer basis points -> a `numeric(5,2)`-shaped percentage string, for snapshotting the rate onto the payment row. */
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
 */
export function applyPctToPaise(basePaise: bigint, pctBasisPoints: bigint): bigint {
  if (basePaise < 0n || pctBasisPoints < 0n) {
    throw new MoneyFormatError('Percentage arithmetic requires non-negative operands.');
  }
  const numerator = basePaise * pctBasisPoints;
  const half = BASIS_POINTS_PER_100_PERCENT / 2n;
  return (numerator + half) / BASIS_POINTS_PER_100_PERCENT;
}

/** Every component of one bill, in integer paise. The rupee-string view is `PaymentBreakdown` — this is the internal, exact one. */
export interface BillInPaise {
  consultationFeePaise: bigint;
  convenienceFeeBasisPoints: bigint;
  convenienceFeePaise: bigint;
  /** fee + convenience fee. Exists as a named step because GST is charged on it, not on the fee. */
  subtotalPaise: bigint;
  gstBasisPoints: bigint;
  gstPaise: bigint;
  totalPayablePaise: bigint;
}

/**
 * THE bill calculation. FR-7.2's five components, in the order FR-7.3 states
 * them, each rounded once.
 *
 *   consultation fee            (given)
 *   + convenience fee           = round(fee x convenience_pct)
 *   = subtotal
 *   + GST                       = round(subtotal x gst_pct)      <- on the SUBTOTAL
 *   = total payable
 *
 * @param consultationFeeInr the doctor's fee, a `numeric(10,2)` rupee string
 * @param convenienceFeePct  the rate in force, a `numeric(5,2)` percentage string
 * @param gstPct             the rate in force, a `numeric(5,2)` percentage string
 */
export function calculateBill(
  consultationFeeInr: string,
  convenienceFeePct: string,
  gstPct: string,
): BillInPaise {
  const consultationFeePaise = rupeesToPaise(consultationFeeInr);
  const convenienceFeeBasisPoints = pctToBasisPoints(convenienceFeePct);
  const gstBasisPoints = pctToBasisPoints(gstPct);

  const convenienceFeePaise = applyPctToPaise(consultationFeePaise, convenienceFeeBasisPoints);
  const subtotalPaise = consultationFeePaise + convenienceFeePaise;
  // *** GST is charged on the SUBTOTAL, not on the consultation fee. ***
  // FR-7.3 pins this: 18% of 600 is 108. 18% of 500 would be 90, and the bill
  // would total 690 instead of the 708 the SRS requires.
  const gstPaise = applyPctToPaise(subtotalPaise, gstBasisPoints);
  const totalPayablePaise = subtotalPaise + gstPaise;

  return {
    consultationFeePaise,
    convenienceFeeBasisPoints,
    convenienceFeePaise,
    subtotalPaise,
    gstBasisPoints,
    gstPaise,
    totalPayablePaise,
  };
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
