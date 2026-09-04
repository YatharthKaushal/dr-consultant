/**
 * *** THE ADMIN READ SURFACE, AND THE QUOTE TOTAL IT HAS TO RESOLVE. ***
 *
 * `toPaymentAdminView` -> `toBreakdown` -> `capturedTotalPaise`, and
 * `capturedTotalPaise` THROWS for a payment that carries a `price_quote_id`
 * when no quote total is supplied — deliberately, because silently re-deriving
 * one from the three legacy columns computes a different number for any bill
 * carrying a discount.
 *
 * `createOrderForConsultation` writes a `price_quote_id` on EVERY payment it
 * creates ("no call site can produce an unpriced payment"), so this service has
 * to resolve those totals or the whole screen 500s.
 *
 * Hand-rolled `jest.fn()` collaborators throughout; never
 * `Test.createTestingModule`.
 */

import type { PaymentRow } from '../../schema/payments.schema';
import type { RefundRow } from '../../schema/refunds.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PricingFacade } from '../pricing/pricing.facade';
import type { PaymentEventRepository } from './payment-event.repository';
import type { PaymentRepository } from './payment.repository';
import type { PaymentService } from './payment.service';
import type { RefundRepository } from './refund.repository';
import { PaymentAdminService } from './payment-admin.service';

const PAYMENT_ID = 'p0000000-0000-4000-8000-000000000001';
const QUOTE_ID = 'q0000000-0000-4000-8000-000000000001';

/**
 * An engine-priced payment. The three legacy columns are a LOSSY SUMMARY of a
 * discounted bill: they sum to 559.00 while the quote's authoritative total is
 * 559.00 too here, but the point is that only the quote is allowed to say so.
 */
function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    consultationId: 'c0000000-0000-4000-8000-000000000001',
    currency: 'INR',
    consultationFee: '500.00',
    convenienceFeePct: '20.00',
    convenienceFee: '50.00',
    gstPct: '18.00',
    gstAmount: '9.00',
    status: 'paid',
    gatewayOrderId: 'order_test_1',
    gatewayPaymentId: 'pay_test_1',
    paymentMethod: 'upi',
    paidAt: new Date('2026-01-01T00:00:00Z'),
    failureReason: null,
    priceQuoteId: QUOTE_ID,
    invoiceNumber: null,
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

interface Harness {
  service: PaymentAdminService;
  getQuoteTotals: jest.Mock;
}

function harness(rows: PaymentRow[], refunds: RefundRow[] = []): Harness {
  const getQuoteTotals = jest.fn(async (ids: readonly string[]) =>
    Object.fromEntries(ids.filter((id) => id === QUOTE_ID).map((id) => [id, '559.00'])),
  );

  const payments = {
    list: jest.fn(async () => rows),
    listForExport: jest.fn(async () => rows),
    countMatching: jest.fn(async () => rows.length),
  } as unknown as PaymentRepository;

  const refundRepo = {
    listByPaymentIds: jest.fn(async () => refunds),
    listByPaymentId: jest.fn(async () => refunds),
  } as unknown as RefundRepository;

  const events = { listByPaymentId: jest.fn(async () => []) } as unknown as PaymentEventRepository;
  const paymentService = { getById: jest.fn(async () => rows[0]) } as unknown as PaymentService;
  const audit = { write: jest.fn(async () => undefined) } as unknown as AuditService;
  const pricing = { getQuoteTotals } as unknown as PricingFacade;

  return {
    service: new PaymentAdminService(payments, refundRepo, events, paymentService, audit, pricing),
    getQuoteTotals,
  };
}

/* ========================================================================== */

describe('PaymentAdminService — the quote total every read has to resolve', () => {
  /**
   * *** REGRESSION: THE ADMIN TRANSACTIONS LIST 500'd ON EVERY PRICED PAYMENT. ***
   *
   * `toPaymentAdminView(row, refunds)` was called with no third argument, so
   * `quoteTotalPayable` defaulted to `null` and `capturedTotalPaise` threw
   * "refusing to re-derive its total" for every row written since the pricing
   * engine merged — which is every row, because `createOrderForConsultation`
   * always writes a `price_quote_id`.
   *
   * The throw is the correct behaviour of `capturedTotalPaise`; the defect was
   * that this service never resolved the totals it is required to supply.
   */
  it('lists a priced payment with the quote total, not a re-derivation', async () => {
    const { service, getQuoteTotals } = harness([paymentRow()]);

    const page = await service.listPayments({});

    expect(getQuoteTotals).toHaveBeenCalledWith([QUOTE_ID]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].breakdown.totalPayable).toBe('559.00');
  });

  it('returns the payment detail for a priced payment', async () => {
    const { service } = harness([paymentRow()]);

    const detail = await service.getPaymentDetail(PAYMENT_ID);

    expect(detail.payment.breakdown.totalPayable).toBe('559.00');
  });

  it('exports a priced payment to CSV with the quote total', async () => {
    const { service } = harness([paymentRow()]);

    const csv = await service.exportPaymentsCsv('a0000000-0000-4000-8000-000000000001', {});

    expect(csv.rowCount).toBe(1);
    expect(csv.content).toContain('559.00');
  });

  /**
   * ONE query for the page, not one per row — `getQuoteTotals` takes a list for
   * exactly this reason.
   */
  it('resolves every quote on the page in a single call', async () => {
    const second = paymentRow({ id: 'p0000000-0000-4000-8000-000000000002' });
    const { service, getQuoteTotals } = harness([paymentRow(), second]);

    await service.listPayments({});

    expect(getQuoteTotals).toHaveBeenCalledTimes(1);
    expect(getQuoteTotals).toHaveBeenCalledWith([QUOTE_ID]);
  });

  /**
   * *** A LEGACY ROW MUST NOT BE HANDED TO PRICING AT ALL. ***
   * `price_quote_id IS NULL` means it was priced by `calculateBill` and must
   * keep being priced by `calculateBill`. 500 + 100 + 108 = 708.00.
   */
  it('prices a legacy row with calculateBill and asks pricing nothing', async () => {
    const { service, getQuoteTotals } = harness([
      paymentRow({ priceQuoteId: null, convenienceFee: '100.00', gstAmount: '108.00' }),
    ]);

    const page = await service.listPayments({});

    expect(page.items[0].breakdown.totalPayable).toBe('708.00');
    expect(getQuoteTotals).not.toHaveBeenCalled();
  });
});
