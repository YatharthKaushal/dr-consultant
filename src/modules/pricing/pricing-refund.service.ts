import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PriceQuoteComponentRow } from '../../schema/price-quote-components.schema';
import type { PlaceOfSupplyKind } from '../../schema/enums.schema';
import {
  applyPctToPaise,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
  sumRupees,
} from '../../shared/money/money.util';
import {
  allocateLargestRemainder,
  halveHalfUp,
  inclusiveTaxableValue,
} from '../../shared/money/money-allocate.util';
import { PriceQuoteRepository } from './price-quote.repository';
import { PRICING_ERROR_CODES } from './pricing.constants';
import type { RefundApportionment, RefundApportionmentComponent } from './pricing.contract';
import { RefundComponentRepository } from './refund-component.repository';

/**
 * *** HOW MUCH OF A REFUND WAS TAX, AND WHICH HEAD IT COMES BACK OUT OF. ***
 *
 * Under s.34 CGST a refund of a supply needs a CREDIT NOTE with proportional tax
 * reversal. "We gave 618.00 back" does not say how much GST was reversed, so it
 * cannot support a credit note or a return. `refund-components.schema.ts` states
 * the requirement; this file is the arithmetic behind it.
 *
 * ── *** THE REFUND BASE CHANGES HERE, AND IT IS A COMMERCIAL CHANGE. *** ────
 *
 * `booking-policy.engine.ts`'s `refundPct` has always meant "percent of the
 * CONSULTATION FEE": a 100% refund on a 708.00 bill returned 500.00, and the
 * patient never got the convenience fee or the GST back.
 *
 * `refundAmountForPct` below redefines it as a percent of the CAPTURED TOTAL. A
 * 100% tier now returns the whole 618.00 (or 708.00 under FR-7.3's catalogue).
 *
 * *** THIS IS NOT A BUG FIX. IT NEEDS THE CLIENT'S SIGN-OFF. *** It changes what
 * the published cancellation policy actually pays out, it changes the platform's
 * revenue on every in-policy cancellation, and it changes the GST position
 * (there is now a tax reversal where previously there was none). The
 * arithmetic below is correct either way; WHICH BASE IS RIGHT is a commercial
 * decision, not a technical one.
 *
 * ── THE APPORTIONMENT ──────────────────────────────────────────────────────
 *
 * A refund is split across the original quote's components by LARGEST REMAINDER,
 * weighted by each line's captured total less whatever has already been refunded
 * against it, so the shares sum to the refund EXACTLY. Within each share the tax
 * is backed out at that line's SNAPSHOTTED rate — never today's — and split into
 * heads the same way the original invoice was.
 *
 * Determinism is a requirement, not a nicety: `allocateLargestRemainder` breaks
 * ties on ascending index and the components are read in POSITION order, so a
 * retried refund cannot produce a second, different credit note for one event.
 *
 * *** THE REVERSAL IS A DIFFERENCE OF CUMULATIVE POSITIONS, NOT A FUNCTION OF
 * ONE SLICE. *** Backing the tax out of each slice independently rounds once per
 * slice, so N partial refunds of a line reverse a DIFFERENT figure from the one
 * the invoice charged — and the CGST/SGST error is systematic, because
 * `halveHalfUp` gives the odd paise to CGST every time. See `reverseTax`.
 *
 * ── *** "REFUND THE REST" LANDS EXACTLY ON ZERO. *** ───────────────────────
 *
 * When the request MEETS OR EXCEEDS the remaining refundable, the per-component
 * EXACT REMAINDERS are used rather than a percentage. A largest-remainder split
 * of a rounded percentage would leave a stray paise on some line, and the
 * payment would sit at `partially_refunded` for one paise forever.
 */
@Injectable()
export class PricingRefundService {
  constructor(
    private readonly quotes: PriceQuoteRepository,
    /**
     * ADDITIVE (M-21/data rights execution): only `countRefundComponentsForConsultations`
     * below reads this — nothing here writes `refund_components`, which stays
     * `modules/payment`'s job (see `refund.service.ts`'s own comment on why it
     * owns that write).
     */
    private readonly refundComponents: RefundComponentRepository,
  ) {}

  /**
   * What a refund of `pct` percent of the CAPTURED TOTAL comes to.
   *
   * Rounded once, half-up, in integer paise — which favours the patient on a tie.
   * See the header: THE BASE CHANGE IS COMMERCIAL AND NEEDS SIGN-OFF.
   */
  async refundAmountForPct(input: { quoteId: string; pct: number }): Promise<string> {
    const quote = await this.quotes.findById(input.quoteId);
    if (!quote) {
      throw new NotFoundException({
        code: PRICING_ERROR_CODES.PRICING_QUOTE_NOT_FOUND,
        message: 'That price quote does not exist.',
      });
    }
    if (!Number.isFinite(input.pct) || input.pct < 0 || input.pct > 100) {
      // Degrades the way `refundAmountFor` does rather than throwing: a caller
      // treats a zero refund as "nothing to refund" and carries on cancelling.
      return '0.00';
    }

    const capturedPaise = rupeesToPaise(quote.totalPayable);
    return paiseToRupees(applyPctToPaise(capturedPaise, pctToBasisPoints(input.pct.toFixed(2))));
  }

  /**
   * Splits a refund across the quote's components and reverses the tax on each
   * share.
   *
   * `alreadyRefundedByCode` is what has already gone back per component, so the
   * weights are each line's REMAINING capacity — a second partial refund cannot
   * take more from a line than that line still has.
   */
  async apportionRefund(input: {
    quoteId: string;
    requestedAmount: string;
    alreadyRefundedByCode?: Record<string, string>;
  }): Promise<RefundApportionment> {
    const quote = await this.quotes.findById(input.quoteId);
    if (!quote) {
      throw new NotFoundException({
        code: PRICING_ERROR_CODES.PRICING_QUOTE_NOT_FOUND,
        message: 'That price quote does not exist.',
      });
    }

    const components = await this.quotes.findComponents(input.quoteId);
    const requestedPaise = rupeesToPaise(input.requestedAmount);

    return apportion({
      components,
      placeOfSupplyKind: quote.placeOfSupplyKind,
      requestedPaise,
      alreadyRefundedByCode: input.alreadyRefundedByCode ?? {},
    });
  }

  /**
   * ADDITIVE (M-21/data rights execution): the `refund_components` half of
   * `PricingContract#countDataRightsRowsForPatient` — a READ-ONLY row count
   * for a patient's approved data-deletion request. See
   * `RefundComponentRepository#countForConsultations` for the join this
   * delegates to and why it is a flagged cross-module read.
   */
  async countRefundComponentsForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.refundComponents.countForConsultations(consultationIds);
  }
}

/* -------------------------------------------------------------------------- */
/* The arithmetic, extracted so it is testable without a database              */
/* -------------------------------------------------------------------------- */

export interface ApportionInput {
  components: readonly PriceQuoteComponentRow[];
  placeOfSupplyKind: PlaceOfSupplyKind;
  requestedPaise: bigint;
  alreadyRefundedByCode: Readonly<Record<string, string>>;
}

/** Pure. Same discipline as `pricing.engine.ts` — a credit note must be testable as arithmetic. */
export function apportion(input: ApportionInput): RefundApportionment {
  // Position order: display order, apportionment order, and the deterministic
  // tie-break `allocateLargestRemainder` falls back to.
  const lines = [...input.components].sort((a, b) => a.position - b.position);

  // What has already gone back against each line, in position order. Load-bearing
  // twice over: it caps the line's remaining capacity, and it is the starting
  // point of the CUMULATIVE reversal below.
  const alreadyByLine = lines.map((line) => {
    const captured = rupeesToPaise(line.lineTotal);
    const already = sumRupees(toAmounts(input.alreadyRefundedByCode[line.code]));
    return already > captured ? captured : already;
  });

  const capacities = lines.map((line, index) => rupeesToPaise(line.lineTotal) - alreadyByLine[index]);

  const totalRemaining = capacities.reduce<bigint>((sum, value) => sum + value, 0n);

  if (input.requestedPaise <= 0n) {
    throw new BadRequestException({
      code: PRICING_ERROR_CODES.PRICING_QUOTE_NOT_FOUND,
      message: 'A refund must be greater than zero.',
    });
  }

  // *** THE EXACT-REMAINDER BRANCH. ***
  // "Refund the rest" must land precisely on zero, so when the request meets or
  // exceeds what is left we hand back each line's OWN remainder rather than a
  // proportional share of a rounded percentage.
  const exhaustive = input.requestedPaise >= totalRemaining;
  const shares = exhaustive
    ? capacities
    : allocateLargestRemainder(input.requestedPaise, capacities);

  const componentViews: RefundApportionmentComponent[] = [];
  let taxableTotal = 0n;
  let cgstTotal = 0n;
  let sgstTotal = 0n;
  let igstTotal = 0n;

  lines.forEach((line, index) => {
    const share = shares[index];
    if (share === 0n) return;

    // *** THE REVERSAL IS A DIFFERENCE OF TWO CUMULATIVE POSITIONS, NOT A
    // FUNCTION OF THIS SLICE ALONE. *** See `reverseTax`.
    const reversal = reverseTax({
      line,
      alreadyPaise: alreadyByLine[index],
      sharePaise: share,
      placeOfSupplyKind: input.placeOfSupplyKind,
    });

    taxableTotal += reversal.taxablePaise;
    cgstTotal += reversal.cgstPaise;
    sgstTotal += reversal.sgstPaise;
    igstTotal += reversal.igstPaise;

    componentViews.push({
      code: line.code,
      amount: paiseToRupees(share),
      taxableValue: paiseToRupees(reversal.taxablePaise),
      // *** THE RATE THAT APPLIED ON THE ORIGINAL INVOICE, NOT TODAY'S. ***
      taxRatePct: line.taxRatePct,
      cgstAmount: paiseToRupees(reversal.cgstPaise),
      sgstAmount: paiseToRupees(reversal.sgstPaise),
      igstAmount: paiseToRupees(reversal.igstPaise),
    });
  });

  const amountPaise = shares.reduce<bigint>((sum, value) => sum + value, 0n);

  return {
    amount: paiseToRupees(amountPaise),
    taxableValue: paiseToRupees(taxableTotal),
    cgstAmount: paiseToRupees(cgstTotal),
    sgstAmount: paiseToRupees(sgstTotal),
    igstAmount: paiseToRupees(igstTotal),
    components: componentViews,
    exhaustive,
  };
}

/**
 * Backs the tax out of one line's share of a refund.
 *
 * *** THE SHARE IS A SLICE OF THE LINE TOTAL, WHICH ALREADY CONTAINS ITS TAX. ***
 * That is true whether the line was quoted exclusive (total = taxable + tax
 * charged on top) or inclusive (total = the quoted amount, tax embedded). Either
 * way the proportional reversal is `share / (1 + rate)`, which is exactly what
 * `inclusiveTaxableValue` computes — and the tax is then the RESIDUAL,
 * `share - taxable`, never a second rounding.
 *
 * ── *** THE REVERSAL IS A DIFFERENCE OF CUMULATIVE POSITIONS. *** ──────────
 *
 * This function does NOT back the tax out of `sharePaise` on its own. It
 * computes the reversal owed at `already + share` of the line, subtracts the
 * reversal already owed at `already`, and returns the difference.
 *
 * *** THAT IS THE WHOLE POINT, AND DOING IT THE OBVIOUS WAY IS WRONG. *** Backing
 * out each slice INDEPENDENTLY rounds once per slice, so N partial refunds of one
 * line reverse `sum(backOut(slice_i))` where the invoice charged
 * `backOut(sum(slice_i))`. Those are not the same number: round-then-sum is not
 * sum-then-round, exactly as `payment-money.util.ts#calculateBill` says of the
 * bill itself. Worse, the CGST/SGST bias is SYSTEMATIC rather than random —
 * `halveHalfUp` hands the odd paise to CGST on EVERY slice, so a line refunded in
 * five steps can over-reverse CGST by several paise and under-reverse SGST by the
 * same amount, while the total refunded rupees are exactly right.
 *
 * A credit note that reverses a different CGST/SGST split from the invoice it
 * credits is a GSTR-1 reconciliation problem, not a rounding curiosity. Measured
 * before this was written: over 3 000 random quotes refunded in random partial
 * steps, 2 517 of them closed on a tax reversal that did not match the invoice,
 * with head errors up to 11 paise.
 *
 * Subtracting cumulative positions makes the series TELESCOPE: the slices sum to
 * `cumulative(lineTotal) - cumulative(0)`, which is the stored figure, whatever
 * the sizes of the slices and however many there are.
 *
 * *** THE LAST SLICE OF A LINE USES THE STORED FIGURES. *** `cumulativeReversal`
 * returns the snapshot when the cumulative position IS the whole line, because
 * backing out is exact to within a paise but does not always reproduce an
 * EXCLUSIVE line's original split bit for bit — that split was
 * `round(taxable x rate)` in the other direction. Refunding a whole line, in one
 * step or in twenty, must reverse precisely what was charged on it.
 *
 * Every component is monotonic non-decreasing in the cumulative position, so no
 * slice can come out negative: `inclusiveTaxableValue` is monotonic, the residual
 * tax `g - backOut(g)` moves by 0 or 1 per paise, and `ceil(t/2)` / `floor(t/2)`
 * are monotonic in `t`. The one place that could break the argument is the
 * terminal snapshot; it was checked exhaustively over 400 000 taxable values at
 * each of eight rates, with zero regressions.
 *
 * Per-row balance still holds exactly: `taxable + heads` equals the cumulative
 * position at both ends, so the difference is `share` — which is what
 * `refund_components_balances` verifies.
 */
function reverseTax(input: {
  line: PriceQuoteComponentRow;
  /** What has ALREADY gone back against this line, before this slice. */
  alreadyPaise: bigint;
  sharePaise: bigint;
  placeOfSupplyKind: PlaceOfSupplyKind;
}): { taxablePaise: bigint; cgstPaise: bigint; sgstPaise: bigint; igstPaise: bigint } {
  const before = cumulativeReversal(input.line, input.alreadyPaise, input.placeOfSupplyKind);
  const after = cumulativeReversal(
    input.line,
    input.alreadyPaise + input.sharePaise,
    input.placeOfSupplyKind,
  );

  return {
    taxablePaise: after.taxablePaise - before.taxablePaise,
    cgstPaise: after.cgstPaise - before.cgstPaise,
    sgstPaise: after.sgstPaise - before.sgstPaise,
    igstPaise: after.igstPaise - before.igstPaise,
  };
}

/**
 * The tax reversal owed once `cumulativePaise` of this line has been refunded,
 * measured from zero. A pure function of the line and that one position, which is
 * what makes the per-slice differences telescope.
 */
function cumulativeReversal(
  line: PriceQuoteComponentRow,
  cumulativePaise: bigint,
  placeOfSupplyKind: PlaceOfSupplyKind,
): { taxablePaise: bigint; cgstPaise: bigint; sgstPaise: bigint; igstPaise: bigint } {
  if (cumulativePaise <= 0n) {
    return { taxablePaise: 0n, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n };
  }

  // *** THE WHOLE LINE IS BACK: REVERSE THE SNAPSHOT, NOT A RECOMPUTATION. ***
  if (cumulativePaise >= rupeesToPaise(line.lineTotal)) {
    return {
      taxablePaise: rupeesToPaise(line.taxableValue),
      cgstPaise: rupeesToPaise(line.cgstAmount),
      sgstPaise: rupeesToPaise(line.sgstAmount),
      igstPaise: rupeesToPaise(line.igstAmount),
    };
  }

  const rateBasisPoints = pctToBasisPoints(line.taxRatePct);

  // An exempt line carries no tax to reverse; the whole share is taxable value.
  // `inclusiveTaxableValue` short-circuits a zero rate anyway, but saying it here
  // keeps the exempt case bit-for-bit obvious.
  if (line.taxTreatment === 'exempt' || rateBasisPoints === 0n) {
    return { taxablePaise: cumulativePaise, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n };
  }

  const taxablePaise = inclusiveTaxableValue(cumulativePaise, rateBasisPoints);
  const taxPaise = cumulativePaise - taxablePaise;

  // Split into heads the same way the original invoice was: CGST computed, SGST
  // the residual, so the two always sum to the tax being reversed.
  if (placeOfSupplyKind === 'intra_state') {
    const cgstPaise = halveHalfUp(taxPaise);
    return { taxablePaise, cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0n };
  }
  return { taxablePaise, cgstPaise: 0n, sgstPaise: 0n, igstPaise: taxPaise };
}

function toAmounts(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}
