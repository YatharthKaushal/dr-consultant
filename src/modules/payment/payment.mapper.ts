import type { PaymentEventRow } from '../../schema/payment-events.schema';
import type { PaymentRow } from '../../schema/payments.schema';
import type { RefundRow } from '../../schema/refunds.schema';
import type { PaymentBreakdown } from './payment.contract';
import { paiseToRupees, rupeesToPaise, sumRupees } from './payment-money.util';

/**
 * Row -> view translation. Keeps DTOs and rows out of each other's layers
 * (`backend/README.md` §2: "mappers keep DTOs and rows out of each other's
 * layers").
 *
 * Nothing here reads the `@deprecated` inline `payments.refund_*` columns.
 * Refund totals come from the `refunds` table, which is the source of truth.
 */

/**
 * FR-7.2's bill, rebuilt from the stored components.
 *
 * `totalPayable` is SUMMED, never read from a column — there is deliberately
 * no stored total, so the components and the total cannot drift apart. See
 * `payment-money.util.ts`.
 */
export function toBreakdown(payment: PaymentRow): PaymentBreakdown {
  const totalPaise =
    rupeesToPaise(payment.consultationFee) + rupeesToPaise(payment.convenienceFee) + rupeesToPaise(payment.gstAmount);

  return {
    consultationFee: payment.consultationFee,
    convenienceFeePct: payment.convenienceFeePct,
    convenienceFee: payment.convenienceFee,
    gstPct: payment.gstPct,
    gstAmount: payment.gstAmount,
    totalPayable: paiseToRupees(totalPaise),
    currency: payment.currency,
  };
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

export function toPaymentAdminView(payment: PaymentRow, refunds: readonly RefundRow[]): PaymentAdminView {
  const breakdown = toBreakdown(payment);
  const settledPaise = sumRupees(refunds.filter((refund) => refund.status === 'processed').map((refund) => refund.amount));
  const capturedPaise = payment.paidAt === null ? 0n : rupeesToPaise(breakdown.totalPayable);
  const refundablePaise = capturedPaise > settledPaise ? capturedPaise - settledPaise : 0n;

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
