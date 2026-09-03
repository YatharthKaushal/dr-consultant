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

describe('toBreakdown — the ONE derivation of a captured total', () => {
  /**
   * *** THIS BEHAVIOUR CHANGED DELIBERATELY, AND THE CHANGE IS THE POINT. ***
   *
   * `toBreakdown` used to sum the three stored columns itself. That was one of
   * FOUR independent re-derivations of the captured total, and
   * `payment.service.ts#expectedTotalPaise` — the one that GATES
   * `reconcileWithGateway`'s amount check — recomputed it via `calculateBill`
   * instead. They agreed only by construction; a discount or a third component
   * would have made the sweep silently refuse to mark real captures paid.
   *
   * All four now go through `payment-money.util.ts#capturedTotalPaise`:
   *   quote present -> `price_quotes.total_payable`
   *   quote absent  -> `calculateBill`, which is what a legacy row was billed at
   *                    and what its gateway order was actually created for.
   */
  it('reproduces FR-7.3 for a legacy row', () => {
    expect(toBreakdown(paymentRow()).totalPayable).toBe('708.00');
  });

  /**
   * Odd paise, on a row whose columns are CONSISTENT WITH ITS OWN SNAPSHOTTED
   * RATES — which is the only state a real row can be in, because the row and
   * the gateway order are written from one `calculateBill` result.
   *
   * At a 333.33 fee: convenience is round(333.33 x 20%) = 66.67, subtotal
   * 400.00, GST round(400.00 x 18%) = 72.00, total 472.00.
   *
   * (The previous version of this test used 333.33 / 53.60 / 69.65 — amounts
   * that contradict the row's own 20% and 18% rates and that no real row could
   * hold. Under one shared derivation such a row resolves to what its rates say
   * it was billed, not to the sum of its inconsistent columns.)
   */
  it('handles odd paise exactly on a legacy row', () => {
    const breakdown = toBreakdown(
      paymentRow({ consultationFee: '333.33', convenienceFee: '66.67', gstAmount: '72.00' }),
    );
    expect(breakdown.totalPayable).toBe('472.00');
  });

  /**
   * *** A QUOTED PAYMENT'S TOTAL IS THE QUOTE'S COLUMN, NOT A RE-SUM. ***
   * Here the legacy columns deliberately disagree with the quote — which is
   * exactly what a discounted bill looks like, since the three columns become a
   * lossy summary once a discount exists.
   */
  it('reads the quote’s total for a priced payment, ignoring the legacy columns', () => {
    const breakdown = toBreakdown(
      paymentRow({ priceQuoteId: 'q0000000-0000-4000-8000-000000000001' }),
      '559.00',
    );
    expect(breakdown.totalPayable).toBe('559.00');
  });

  /**
   * *** NEVER FALL BACK. *** A quoted payment whose quote cannot be resolved is
   * a broken invariant, and re-deriving it from the legacy columns would compute
   * a different number for any discounted bill — the exact divergence the shared
   * helper exists to close. Refusing means a capture waits for a human, which is
   * the correct direction to err for money.
   */
  it('refuses to guess when a priced payment’s quote is missing', () => {
    expect(() => toBreakdown(paymentRow({ priceQuoteId: 'q0000000-0000-4000-8000-000000000001' }))).toThrow(
      /refusing to re-derive/,
    );
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
