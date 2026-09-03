/**
 * The row -> view translation, and specifically the two money figures the admin
 * panel puts in front of a human before they type a refund amount.
 *
 * There was no spec for this file, which is how `refundableAmount` came to
 * disagree with the service that actually enforces the limit.
 */
import type { PaymentRow } from '../../schema/payments.schema';
import type { RefundRow } from '../../schema/refunds.schema';
import { toBreakdown, toDoctorPayoutView, toPaymentAdminView } from './payment.mapper';

const PAYMENT_ID = 'p0000000-0000-4000-8000-000000000001';

/** FR-7.3's worked example, captured: 500 + 100 + 108 = 708.00. */
function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    consultationId: 'c0000000-0000-4000-8000-000000000001',
    currency: 'INR',
    consultationFee: '500.00',
    convenienceFeePct: '20.00',
    convenienceFee: '100.00',
    gstPct: '18.00',
    gstAmount: '108.00',
    status: 'paid',
    gatewayOrderId: 'order_test_1',
    gatewayPaymentId: 'pay_test_1',
    paymentMethod: 'upi',
    paidAt: new Date('2026-01-01T00:00:00Z'),
    failureReason: null,
    refundAmount: '0',
    refundReason: null,
    refundInitiatedByAdminId: null,
    gatewayRefundId: null,
    refundedAt: null,
    payoutPaidAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as PaymentRow;
}

function refundRow(amount: string, status: RefundRow['status']): RefundRow {
  return {
    id: `r-${amount}-${status}`,
    paymentId: PAYMENT_ID,
    amount,
    reason: 'test',
    status,
    initiatedByAdminId: null,
    isAutomatic: true,
    gatewayRefundId: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as RefundRow;
}

describe('toBreakdown', () => {
  /** FR-7.3, and there is deliberately no stored total column to disagree with it. */
  it('sums the stored components rather than reading a total', () => {
    expect(toBreakdown(paymentRow()).totalPayable).toBe('708.00');
  });

  it('sums components that carry odd paise exactly', () => {
    // 333.33 + 53.60 + 69.65 = 456.58, all hand-derived.
    const breakdown = toBreakdown(
      paymentRow({ consultationFee: '333.33', convenienceFee: '53.60', gstAmount: '69.65' }),
    );
    expect(breakdown.totalPayable).toBe('456.58');
  });
});

describe('toDoctorPayoutView', () => {
  /** FR-7.4: "consultation fee 500 rupees, platform deduction 0 rupees, doctor earning 500 rupees." */
  it('gives the doctor the whole consultation fee with zero deduction', () => {
    const view = toDoctorPayoutView(paymentRow());
    expect(view.consultationFee).toBe('500.00');
    expect(view.platformDeduction).toBe('0.00');
    expect(view.doctorEarning).toBe('500.00');
  });

  it.each([
    ['pending', { paidAt: null, payoutPaidAt: null }],
    ['payable', { paidAt: new Date(), payoutPaidAt: null }],
    ['paid', { paidAt: new Date(), payoutPaidAt: new Date() }],
  ])('reports payout status %s', (expected, overrides) => {
    expect(toDoctorPayoutView(paymentRow(overrides as Partial<PaymentRow>)).payoutStatus).toBe(expected);
  });
});

describe('toPaymentAdminView — the two refund figures', () => {
  it('reports nothing refunded and everything refundable on a fresh capture', () => {
    const view = toPaymentAdminView(paymentRow(), []);
    expect(view.refundedAmount).toBe('0.00');
    expect(view.refundableAmount).toBe('708.00');
  });

  it('counts only SETTLED refunds as refunded', () => {
    const view = toPaymentAdminView(paymentRow(), [
      refundRow('300.00', 'processed'),
      refundRow('100.00', 'pending'),
    ]);
    // "How much has actually gone back" is settled money only.
    expect(view.refundedAmount).toBe('300.00');
  });

  /**
   * *** REGRESSION: THE CEILING SHOWN MUST BE THE CEILING ENFORCED. ***
   *
   * `refundableAmount` was computed from `processed` refunds alone, while
   * `RefundService.createRefund` refuses anything that pushes the COMMITTED
   * total (pending + processing + processed) past the capture. So with a
   * 708.00 capture and a 708.00 refund still in flight, the transactions list
   * told an admin 708.00 was still refundable — and `GET .../refundable`,
   * which calls `getRefundableAmount` and does count committed rows, said
   * 0.00. The optimistic number was the one on the screen an admin types into.
   */
  it('subtracts an in-flight PENDING refund from the refundable ceiling', () => {
    const view = toPaymentAdminView(paymentRow(), [refundRow('708.00', 'pending')]);
    expect(view.refundableAmount).toBe('0.00');
    // Nothing has settled, so nothing has been refunded yet.
    expect(view.refundedAmount).toBe('0.00');
  });

  it('subtracts a PROCESSING refund from the refundable ceiling', () => {
    const view = toPaymentAdminView(paymentRow(), [refundRow('200.00', 'processing')]);
    expect(view.refundableAmount).toBe('508.00');
  });

  /** A failed refund never moved money, so its amount is genuinely free again. */
  it('does NOT subtract a failed refund', () => {
    const view = toPaymentAdminView(paymentRow(), [refundRow('200.00', 'failed')]);
    expect(view.refundableAmount).toBe('708.00');
  });

  it('mixes settled, in-flight and failed correctly', () => {
    const view = toPaymentAdminView(paymentRow(), [
      refundRow('300.00', 'processed'),
      refundRow('200.00', 'pending'),
      refundRow('100.00', 'failed'),
    ]);
    expect(view.refundedAmount).toBe('300.00');
    // 708.00 - (300.00 + 200.00) = 208.00. The failed 100.00 does not count.
    expect(view.refundableAmount).toBe('208.00');
  });

  /** Nothing can be refunded from a payment that was never captured. */
  it('reports zero refundable on an uncaptured payment', () => {
    const view = toPaymentAdminView(paymentRow({ paidAt: null, status: 'created' }), []);
    expect(view.refundableAmount).toBe('0.00');
  });

  /** Never negative, even if the data is somehow inconsistent. */
  it('clamps at zero rather than reporting a negative ceiling', () => {
    const view = toPaymentAdminView(paymentRow(), [refundRow('900.00', 'processed')]);
    expect(view.refundableAmount).toBe('0.00');
  });
});
