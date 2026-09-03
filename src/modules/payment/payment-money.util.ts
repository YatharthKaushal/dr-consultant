/**
 * *** M-12'S BILL CALCULATION, PLUS A RE-EXPORT OF THE SHARED MONEY PRIMITIVES. ***
 *
 * ── WHAT MOVED, AND WHY ────────────────────────────────────────────────────
 *
 * The money PRIMITIVES that used to live here — `rupeesToPaise`,
 * `paiseToRupees`, `pctToBasisPoints`, `basisPointsToPct`, `applyPctToPaise`,
 * `paiseToGatewayAmount`, `gatewayAmountToPaise`, `sumRupees` and
 * `MoneyFormatError` — now live in `src/shared/money/money.util.ts`, which
 * carries the four money rules in full. Read that file before changing any
 * arithmetic.
 *
 * They moved because keeping the only correct money arithmetic inside ONE
 * feature module had a real, shipped cost: `booking-policy.engine.ts` could not
 * import it across the module boundary, so it grew its own float-based refund
 * calculation and sent the result to a payment gateway. Booking, payment,
 * pricing and promotions all price in paise; there must be exactly one
 * implementation of that, and `backend/README.md` §2 puts it in `shared`.
 *
 * *** THIS FILE RE-EXPORTS THEM ON PURPOSE. *** Every existing importer keeps
 * compiling unchanged, so the move is a pure addition with no test churn. New
 * code should import from `src/shared/money` directly; these re-exports exist
 * to make the transition mechanical, not to be a permanent second address.
 *
 * ── WHAT DELIBERATELY DID NOT MOVE ─────────────────────────────────────────
 *
 * `calculateBill` and `BillInPaise`. They encode M-12's SPECIFIC two-component
 * fee model — fee, then a convenience fee as a percentage of it, then GST on
 * the subtotal — which is a domain rule belonging to this module, not a
 * primitive. `shared/` holds arithmetic; the shape of one product's bill is not
 * arithmetic. Do not move it there "for symmetry".
 */

import { applyPctToPaise, pctToBasisPoints, rupeesToPaise } from '../../shared/money/money.util';

export {
  MoneyFormatError,
  applyPctToPaise,
  basisPointsToPct,
  gatewayAmountToPaise,
  paiseToGatewayAmount,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
  sumRupees,
} from '../../shared/money/money.util';

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
 * THE LEGACY BILL CALCULATION. FR-7.2's five components, in the order FR-7.3
 * states them, each rounded once.
 *
 *   consultation fee            (given)
 *   + convenience fee           = round(fee x convenience_pct)
 *   = subtotal
 *   + GST                       = round(subtotal x gst_pct)      <- on the SUBTOTAL
 *   = total payable
 *
 * ── FR-7.3 IS AN ACCEPTANCE CRITERION, NOT AN EXAMPLE ──────────────────────
 *
 * `docs/SRS.md` FR-7.3: "Worked example at a fee of 500 rupees: convenience fee
 * is 20 percent, which is 100 rupees; subtotal is 600 rupees; GST at 18 percent
 * exclusive is 108 rupees; final patient payable is 708 rupees."
 *
 * GST is EXCLUSIVE and charged on the SUBTOTAL (fee + convenience), not on the
 * fee alone — 18% of 600 is 108, whereas 18% of 500 would be 90 and the total
 * would come out at 690.
 *
 * FR-7.4's doctor payout view is the same numbers read differently: the doctor
 * receives `consultationFee` in full, platform deduction is zero. There is no
 * calculation for it, which is why there is no function for it here — the
 * payout IS `payments.consultation_fee`.
 *
 * ── WHY THERE IS NO STORED TOTAL COLUMN (AND WHERE THAT STOPS BEING TRUE) ──
 *
 * `payments` stores fee, convenience fee, GST and both rates, but no total. The
 * total is their sum, and a stored copy could disagree with its own components.
 * That argument holds for exactly as long as those three columns ARE the whole
 * bill. Once a bill can carry a discount, a third component or an inclusive
 * component, they become a lossy summary and re-summing them computes a
 * DIFFERENT number rather than recomputing the total — at which point the total
 * must be stored somewhere immutable. See the pricing module.
 *
 * ── DEPRECATION ────────────────────────────────────────────────────────────
 *
 * @deprecated Superseded by the pricing engine's per-component model, which
 * computes `sum(round(component x rate))` where this computes
 * `round(subtotal x rate)`. THOSE ARE NOT THE SAME FUNCTION — round-then-sum
 * differs from sum-then-round at some fees (a 103-paise fee with a 21-paise
 * convenience fee gives 22 paise of GST here and 23 there).
 *
 * *** THAT IS WHY THIS IS NOT DELETED. *** Every `payments` row created before
 * the pricing engine existed was priced by this function, and the webhook's
 * capture check and `reconcileWithGateway`'s amount check must keep reproducing
 * those historical totals exactly. Re-pricing an old row with the new engine
 * would make those checks reject real captures. Legacy rows (no pinned quote)
 * are priced here; new rows are priced by the engine.
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
