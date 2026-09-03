import type { PriceQuoteComponentRow } from '../../schema/price-quote-components.schema';
import type { PriceQuoteRow } from '../../schema/price-quotes.schema';
import { basisPointsToPct, paiseToRupees, rupeesToPaise } from '../../shared/money/money.util';
import { findGstStateCode } from './pricing-gst.constants';
import type { PricedComponent, PricedQuote } from './pricing.engine';
import type {
  DiscountView,
  PriceQuoteView,
  PricedComponentView,
  SupplierView,
} from './pricing.contract';
import type { PricingTaxProfile } from './pricing.constants';

/**
 * Paise and rows -> the view the checkout screen renders. `backend/README.md`
 * §2: "mappers keep DTOs and rows out of each other's layers."
 *
 * *** EVERY MONEY FIELD LEAVES HERE AS A DECIMAL STRING. *** `bigint` does not
 * survive `JSON.stringify` and a `number` would invite float arithmetic on a
 * bill downstream. `paiseToRupees` always renders exactly two decimal places, so
 * every value round-trips through `rupeesToPaise` unchanged.
 */

/** One priced component (engine output, in paise) -> its view. */
export function toComponentView(component: PricedComponent): PricedComponentView {
  return {
    code: component.code,
    label: component.label,
    position: component.position,
    hsnSac: component.hsnSac,
    grossAmount: paiseToRupees(component.grossPaise),
    discountAmount: paiseToRupees(component.discountPaise),
    discountBearer: component.discountBearer,
    taxableValue: paiseToRupees(component.taxableValuePaise),
    taxTreatment: component.taxTreatment,
    taxMode: component.taxMode,
    taxRatePct: basisPointsToPct(component.taxRateBasisPoints),
    cgstAmount: paiseToRupees(component.cgstPaise),
    sgstAmount: paiseToRupees(component.sgstPaise),
    igstAmount: paiseToRupees(component.igstPaise),
    lineTotal: paiseToRupees(component.lineTotalPaise),
    basis: component.basis,
    basisPct: component.basisPct,
    basisCodes: component.basisCodes,
  };
}

/** One stored component row -> its view. Reads the SNAPSHOT, never today's catalogue. */
export function toComponentViewFromRow(row: PriceQuoteComponentRow): PricedComponentView {
  return {
    code: row.code,
    label: row.label,
    position: row.position,
    hsnSac: row.hsnSac,
    grossAmount: row.grossAmount,
    discountAmount: row.discountAmount,
    discountBearer: row.discountBearer,
    taxableValue: row.taxableValue,
    taxTreatment: row.taxTreatment,
    taxMode: row.taxMode,
    taxRatePct: row.taxRatePct,
    cgstAmount: row.cgstAmount,
    sgstAmount: row.sgstAmount,
    igstAmount: row.igstAmount,
    lineTotal: row.lineTotal,
    basis: row.basis,
    basisPct: row.basisPct,
    basisCodes: row.basisCodes,
  };
}

/**
 * A freshly priced quote (engine output) -> the view.
 *
 * Used for `preview`, where there is no row yet, and immediately after
 * `createQuote`, where re-reading the row would cost a query to learn nothing.
 */
export function toQuoteView(input: {
  priced: PricedQuote;
  quoteId: string | null;
  status: PriceQuoteView['status'];
  currency: string;
  placeOfSupplyStateCode: string;
  placeOfSupplyPincode: string | null;
  supplier: PricingTaxProfile;
  discount: DiscountView | null;
  expiresAt: Date | null;
}): PriceQuoteView {
  return {
    quoteId: input.quoteId,
    status: input.status,
    currency: input.currency,
    components: input.priced.components.map(toComponentView),

    grossTotal: paiseToRupees(input.priced.grossTotalPaise),
    discountTotal: paiseToRupees(input.priced.discountTotalPaise),
    taxableTotal: paiseToRupees(input.priced.taxableTotalPaise),
    cgstTotal: paiseToRupees(input.priced.cgstTotalPaise),
    sgstTotal: paiseToRupees(input.priced.sgstTotalPaise),
    igstTotal: paiseToRupees(input.priced.igstTotalPaise),
    totalPayable: paiseToRupees(input.priced.totalPayablePaise),

    placeOfSupply: {
      stateCode: input.placeOfSupplyStateCode,
      stateName: findGstStateCode(input.placeOfSupplyStateCode)?.name ?? null,
      pincode: input.placeOfSupplyPincode,
      kind: input.priced.placeOfSupplyKind,
    },
    supplier: toSupplierView(input.supplier),
    discount: input.discount,

    doctorPayout: paiseToRupees(input.priced.doctorPayoutPaise),
    platformDeduction: paiseToRupees(input.priced.platformDeductionPaise),

    expiresAt: input.expiresAt,
    fullyDiscounted: input.priced.totalPayablePaise === 0n,
  };
}

/**
 * A stored quote + its components -> the view.
 *
 * *** READS THE SNAPSHOT AND RECOMPUTES NOTHING. *** An admin editing the
 * catalogue tomorrow must not restate an invoice issued today
 * (`price-quote-components.schema.ts`'s snapshot rule), so nothing here goes
 * near the engine or the config.
 */
export function toQuoteViewFromRows(
  quote: PriceQuoteRow,
  components: readonly PriceQuoteComponentRow[],
  discount: DiscountView | null = null,
): PriceQuoteView {
  return {
    quoteId: quote.id,
    status: quote.status,
    currency: quote.currency,
    components: [...components]
      .sort((a, b) => a.position - b.position)
      .map(toComponentViewFromRow),

    grossTotal: quote.grossTotal,
    discountTotal: quote.discountTotal,
    taxableTotal: quote.taxableTotal,
    cgstTotal: quote.cgstTotal,
    sgstTotal: quote.sgstTotal,
    igstTotal: quote.igstTotal,
    totalPayable: quote.totalPayable,

    placeOfSupply: {
      stateCode: quote.placeOfSupplyStateCode,
      stateName: findGstStateCode(quote.placeOfSupplyStateCode)?.name ?? null,
      pincode: quote.placeOfSupplyPincode,
      kind: quote.placeOfSupplyKind,
    },
    supplier: {
      stateCode: quote.supplierStateCode,
      gstin: quote.supplierGstin,
      // *** NOT SNAPSHOTTED. *** `price_quotes` carries the supplier's STATE and
      // GSTIN but has no column for the legal name, so there is nothing honest to
      // put here on a re-read. Empty rather than today's value, which would be a
      // false snapshot — an invoice reprinted after a rename must not silently
      // claim the new name was the one on the original.
      legalName: '',
    },
    discount:
      discount ??
      (quote.discountCode === null
        ? null
        : {
            applied: true,
            code: quote.discountCode,
            instrumentId: quote.discountId,
            kind: null,
            label: quote.discountLabel,
            amount: quote.discountTotal,
            cappedAmount: '0.00',
            attributionOnly: rupeesToPaise(quote.discountTotal) === 0n,
            reason: null,
            message: null,
          }),

    // *** NULL ON A RE-READ. *** The payee is not a stored column, and
    // reconstructing it from today's catalogue would break the snapshot rule.
    // The authoritative payout view is `payment.mapper.ts#toDoctorPayoutView`,
    // driven by `payments.consultation_fee` — see `pricing.contract.ts`.
    doctorPayout: null,
    platformDeduction: null,

    expiresAt: quote.expiresAt,
    fullyDiscounted: rupeesToPaise(quote.totalPayable) === 0n,
  };
}

function toSupplierView(profile: PricingTaxProfile): SupplierView {
  return { stateCode: profile.registeredStateCode, gstin: profile.gstin, legalName: profile.legalName };
}
