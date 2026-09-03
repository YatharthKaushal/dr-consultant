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
 * ── *** "REFUND THE REST" LANDS EXACTLY ON ZERO. *** ───────────────────────
 *
 * When the request MEETS OR EXCEEDS the remaining refundable, the per-component
 * EXACT REMAINDERS are used rather than a percentage. A largest-remainder split
 * of a rounded percentage would leave a stray paise on some line, and the
 * payment would sit at `partially_refunded` for one paise forever.
 */
@Injectable()
export class PricingRefundService {
  constructor(private readonly quotes: PriceQuoteRepository) {}

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

  const capacities = lines.map((line) => {
    const captured = rupeesToPaise(line.lineTotal);
    const already = sumRupees(toAmounts(input.alreadyRefundedByCode[line.code]));
    return captured > already ? captured - already : 0n;
  });

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

    const reversal = reverseTax({
      line,
      sharePaise: share,
      // A COMPLETE reversal of an untouched line gives back exactly what was
      // charged on it — see `reverseTax`.
      isCompleteLineReversal: share === rupeesToPaise(line.lineTotal),
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
 * `share - taxable`, never a second rounding. `amount = taxable + heads` holds
 * exactly, which is what `refund_components_balances` verifies.
 *
 * *** A COMPLETE REVERSAL OF AN UNTOUCHED LINE USES THE STORED FIGURES. ***
 * Backing out is exact to within a paise but is not guaranteed to reproduce an
 * EXCLUSIVE line's original split bit for bit, because that split was
 * `round(taxable x rate)` in the other direction. Refunding a whole line should
 * reverse precisely what was charged on it, so when the share is the entire line
 * total the snapshot is used directly rather than recomputed.
 */
function reverseTax(input: {
  line: PriceQuoteComponentRow;
  sharePaise: bigint;
  isCompleteLineReversal: boolean;
  placeOfSupplyKind: PlaceOfSupplyKind;
}): { taxablePaise: bigint; cgstPaise: bigint; sgstPaise: bigint; igstPaise: bigint } {
  if (input.isCompleteLineReversal) {
    return {
      taxablePaise: rupeesToPaise(input.line.taxableValue),
      cgstPaise: rupeesToPaise(input.line.cgstAmount),
      sgstPaise: rupeesToPaise(input.line.sgstAmount),
      igstPaise: rupeesToPaise(input.line.igstAmount),
    };
  }

  const rateBasisPoints = pctToBasisPoints(input.line.taxRatePct);

  // An exempt line carries no tax to reverse; the whole share is taxable value.
  // `inclusiveTaxableValue` short-circuits a zero rate anyway, but saying it here
  // keeps the exempt case bit-for-bit obvious.
  if (input.line.taxTreatment === 'exempt' || rateBasisPoints === 0n) {
    return { taxablePaise: input.sharePaise, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n };
  }

  const taxablePaise = inclusiveTaxableValue(input.sharePaise, rateBasisPoints);
  const taxPaise = input.sharePaise - taxablePaise;

  // Split into heads the same way the original invoice was: CGST computed, SGST
  // the residual, so the two always sum to the tax being reversed.
  if (input.placeOfSupplyKind === 'intra_state') {
    const cgstPaise = halveHalfUp(taxPaise);
    return { taxablePaise, cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0n };
  }
  return { taxablePaise, cgstPaise: 0n, sgstPaise: 0n, igstPaise: taxPaise };
}

function toAmounts(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}
