import type { PaymentEventRow } from '../../schema/payment-events.schema';
import type { PaymentRow } from '../../schema/payments.schema';
import type { RefundRow } from '../../schema/refunds.schema';
import type { PriceQuoteView } from '../pricing/pricing.contract';
import type { PaymentBreakdown } from './payment.contract';
import { capturedTotalPaise, paiseToRupees, rupeesToPaise, sumRupees } from './payment-money.util';

/**
 * Row -> view translation. Keeps DTOs and rows out of each other's layers
 * (`backend/README.md` §2: "mappers keep DTOs and rows out of each other's
 * layers").
 *
 * Nothing here reads the `@deprecated` inline `payments.refund_*` columns.
 * Refund totals come from the `refunds` table, which is the source of truth.
 */

/**
 * FR-7.2's bill.
 *
 * *** `totalPayable` COMES FROM `capturedTotalPaise`, THE ONE DERIVATION. ***
 *
 * This function used to sum the three stored columns itself. That was one of
 * FOUR independent re-derivations of the captured total, and the fourth
 * (`payment.service.ts#expectedTotalPaise`) computed it DIFFERENTLY — they
 * agreed only by construction, and would diverge the moment a bill carried a
 * discount or a third component. `payment-money.util.ts#capturedTotalPaise`
 * carries the full argument; every call site now goes through it.
 *
 * @param quoteTotalPayable `price_quotes.total_payable` when this payment was
 *        priced by the engine. Required for a payment with a `priceQuoteId`;
 *        ignored for a legacy row. Optional in the SIGNATURE only so existing
 *        callers and fixtures for legacy rows compile unchanged — a quoted
 *        payment called without it throws rather than guessing.
 */
export function toBreakdown(payment: PaymentRow, quoteTotalPayable: string | null = null): PaymentBreakdown {
  return {
    consultationFee: payment.consultationFee,
    convenienceFeePct: payment.convenienceFeePct,
    convenienceFee: payment.convenienceFee,
    gstPct: payment.gstPct,
    gstAmount: payment.gstAmount,
    totalPayable: paiseToRupees(capturedTotalPaise(payment, quoteTotalPayable)),
    currency: payment.currency,
  };
}

/**
 * *** A PRICED QUOTE -> THE LEGACY `PaymentBreakdown` SHAPE. ***
 *
 * `PaymentBreakdown` is inherently a TWO-COMPONENT shape — a consultation fee, a
 * convenience fee at one percentage, and one GST rate. The engine prices an
 * ORDERED LIST of components, each with its own treatment. Mapping the second
 * onto the first is therefore lossy by construction, and the interesting part is
 * which losses are acceptable:
 *
 *   `consultationFee`     the fee the caller supplied. Authoritative and
 *                         unmapped — FR-7.4 says the doctor's payout IS this
 *                         number, so it must never be a derived figure.
 *   `convenienceFee`      everything else that is charged, net of discount:
 *                         `gross - discount - consultationFee`. For the seeded
 *                         and FR-7.3 catalogues (both exclusive) this makes the
 *                         three legacy columns still sum to the total, which
 *                         keeps every existing screen correct.
 *   `convenienceFeePct`   the first `percent_of` component's rate, for display.
 *   `gstPct`              the HIGHEST taxable rate on the bill, as the headline
 *                         rate. With per-component treatments there may be no
 *                         single rate; this is a label, and `taxSplit` carries
 *                         the amounts that were actually charged.
 *
 * *** `totalPayable` IS THE QUOTE'S OWN COLUMN AND IS NEVER RE-SUMMED HERE. ***
 * That is the whole point: a bill with a discount or an inclusive component
 * cannot be recovered from the three legacy fields, so the authoritative number
 * is carried across untouched and `quoteId` points at where it lives.
 */
export function toBreakdownFromQuote(
  quote: PriceQuoteView,
  consultationFeeInr: string,
  currency: string,
): PaymentBreakdown {
  const grossPaise = rupeesToPaise(quote.grossTotal);
  const discountPaise = rupeesToPaise(quote.discountTotal);
  const feePaise = rupeesToPaise(consultationFeeInr);
  const netOfFeePaise = grossPaise - discountPaise - feePaise;

  const taxPaise =
    rupeesToPaise(quote.cgstTotal) + rupeesToPaise(quote.sgstTotal) + rupeesToPaise(quote.igstTotal);

  // The headline rate: the highest rate any taxable line actually carried.
  // A label, not an input to any arithmetic.
  const headlineRate = quote.components
    .filter((component) => component.taxTreatment === 'taxable')
    .map((component) => component.taxRatePct)
    .sort((a, b) => Number(b) - Number(a))[0];

  return {
    consultationFee: consultationFeeInr,
    convenienceFeePct: convenienceRateOf(quote),
    // Never negative: a catalogue whose doctor line exceeds the whole gross is a
    // misconfiguration, and a negative column would fail `numeric` checks
    // downstream rather than surfacing here.
    convenienceFee: paiseToRupees(netOfFeePaise > 0n ? netOfFeePaise : 0n),
    gstPct: headlineRate ?? '0.00',
    gstAmount: paiseToRupees(taxPaise),
    totalPayable: quote.totalPayable,
    currency,

    subtotal: quote.taxableTotal,
    quoteId: quote.quoteId,
    placeOfSupply: {
      stateCode: quote.placeOfSupply.stateCode,
      stateName: quote.placeOfSupply.stateName,
      pincode: quote.placeOfSupply.pincode,
      kind: quote.placeOfSupply.kind,
    },
    taxSplit: { cgst: quote.cgstTotal, sgst: quote.sgstTotal, igst: quote.igstTotal },
    discount:
      quote.discount === null
        ? null
        : {
            applied: quote.discount.applied,
            code: quote.discount.code,
            amount: quote.discount.amount,
            cappedAmount: quote.discount.cappedAmount,
            reason: quote.discount.reason,
            message: quote.discount.message,
          },
  };
}

/**
 * The first `percent_of` component's DERIVATION rate — FR-7.3's "convenience fee
 * is 20 percent", which is what `payments.convenience_fee_pct` has always meant.
 *
 * *** NOT `taxRatePct`. *** The convenience fee is derived at 20% and TAXED at
 * 18%; putting the tax rate in this column would misreport the fee on every
 * legacy screen that reads it.
 */
function convenienceRateOf(quote: PriceQuoteView): string {
  const derived = quote.components.find((component) => component.basis === 'percent_of');
  return derived?.basisPct ?? '0.00';
}

/** One refund, as an admin or a patient sees it. The gateway's own `failure_reason` is NOT included — `refunds.schema.ts`: "Never shown verbatim to a patient." */
export interface RefundView {
  id: string;
  paymentId: string;
  amount: string;
  reason: string | null;
  status: string;
  isAutomatic: boolean;
  initiatedByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toRefundView(refund: RefundRow): RefundView {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: refund.amount,
    reason: refund.reason,
    status: refund.status,
    isAutomatic: refund.isAutomatic,
    initiatedByAdminId: refund.initiatedByAdminId,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

/**
 * FR-7.4's doctor payout view: "consultation fee 500 rupees, platform
 * deduction 0 rupees, doctor earning 500 rupees."
 *
 * There is no arithmetic to it and no stored payout amount — the doctor's
 * earning IS `payments.consultation_fee`, and the platform takes nothing from
 * it. The convenience fee and the GST are charged to the PATIENT on top; the
 * whole point of the transparent-billing model is that neither touches the
 * doctor's fee.
 *
 * `payoutPaidAt` is the payout STATUS: NULL means still owed. Payouts are
 * manual this release (SRS §2.4, §11), so nothing here moves money.
 */
export interface DoctorPayoutView {
  paymentId: string;
  consultationId: string;
  consultationFee: string;
  platformDeduction: string;
  doctorEarning: string;
  currency: string;
  paidAt: Date | null;
  payoutPaidAt: Date | null;
  /** `pending` while the consultation is unpaid, `payable` once captured and not yet transferred, `paid` once transferred. */
  payoutStatus: 'pending' | 'payable' | 'paid';
}

export function toDoctorPayoutView(payment: PaymentRow): DoctorPayoutView {
  const payoutStatus: DoctorPayoutView['payoutStatus'] =
    payment.payoutPaidAt !== null ? 'paid' : payment.paidAt !== null ? 'payable' : 'pending';

  return {
    paymentId: payment.id,
    consultationId: payment.consultationId,
    consultationFee: payment.consultationFee,
    // FR-7.4: zero, always. Not a calculation, a commitment.
    platformDeduction: '0.00',
    doctorEarning: payment.consultationFee,
    currency: payment.currency,
    paidAt: payment.paidAt,
    payoutPaidAt: payment.payoutPaidAt,
    payoutStatus,
  };
}

/** One transaction row in the admin list (FR-18.4), with its refund position folded in. */
export interface PaymentAdminView {
  id: string;
  consultationId: string;
  status: string;
  breakdown: PaymentBreakdown;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  paymentMethod: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  /** Sum of SETTLED refunds. From the `refunds` table, never from the deprecated inline column. */
  refundedAmount: string;
  refundableAmount: string;
  payout: DoctorPayoutView;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The refund statuses that count against what was captured.
 *
 * *** MUST MATCH `RefundRepository.listCommittedAmounts` EXACTLY. *** A
 * `pending` row (recorded, not yet sent) and a `processing` row (the gateway
 * accepted it, settlement pending) are both money already committed, and
 * `RefundService` refuses a refund that would push the COMMITTED total past the
 * capture — not the settled total.
 */
const COMMITTED_REFUND_STATUSES: ReadonlySet<string> = new Set(['pending', 'processing', 'processed']);

export function toPaymentAdminView(
  payment: PaymentRow,
  refunds: readonly RefundRow[],
  quoteTotalPayable: string | null = null,
): PaymentAdminView {
  const breakdown = toBreakdown(payment, quoteTotalPayable);
  const settledPaise = sumRupees(refunds.filter((refund) => refund.status === 'processed').map((refund) => refund.amount));
  // *** `refundableAmount` COUNTS IN-FLIGHT REFUNDS; `refundedAmount` DOES NOT. ***
  // The two answer different questions and the difference is not cosmetic.
  // "How much has been refunded" is settled money only. "How much can still be
  // refunded" is what `RefundService.createRefund` will actually allow, and it
  // subtracts `pending` and `processing` rows too.
  //
  // Computing this from settled refunds alone made the admin list advertise a
  // ceiling the service would then refuse: with a 708.00 capture and a 708.00
  // refund still in flight, the row claimed 708.00 was refundable while
  // `GET .../refundable` — which calls `getRefundableAmount` and does count
  // committed rows — correctly said 0.00. Two screens, two answers, and the
  // optimistic one was the screen an admin types an amount into.
  const committedPaise = sumRupees(
    refunds.filter((refund) => COMMITTED_REFUND_STATUSES.has(refund.status)).map((refund) => refund.amount),
  );
  const capturedPaise = payment.paidAt === null ? 0n : rupeesToPaise(breakdown.totalPayable);
  const refundablePaise = capturedPaise > committedPaise ? capturedPaise - committedPaise : 0n;

  return {
    id: payment.id,
    consultationId: payment.consultationId,
    status: payment.status,
    breakdown,
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId: payment.gatewayPaymentId,
    paymentMethod: payment.paymentMethod,
    paidAt: payment.paidAt,
    failureReason: payment.failureReason,
    refundedAmount: paiseToRupees(settledPaise),
    refundableAmount: paiseToRupees(refundablePaise),
    payout: toDoctorPayoutView(payment),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

/** A recorded webhook delivery, for the admin's "what did the gateway actually tell us" view. The raw payload is NOT included — it can carry gateway internals. */
export interface PaymentEventView {
  id: number;
  gatewayEventId: string;
  eventType: string;
  paymentId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  processingError: string | null;
}

export function toPaymentEventView(event: PaymentEventRow): PaymentEventView {
  return {
    id: event.id,
    gatewayEventId: event.gatewayEventId,
    eventType: event.eventType,
    paymentId: event.paymentId,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
    processingError: event.processingError,
  };
}
