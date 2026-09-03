import type { Database } from '../../config/db/database.config';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PaymentConfigService } from './payment-config.service';
import type { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import type { PricingFacade } from '../pricing/pricing.facade';
import type { RazorpayClient } from './razorpay.client';

const PAYMENT_ID = 'e1f7a8d0-0000-4000-8000-000000000001';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    consultationId: CONSULTATION_ID,
    currency: 'INR',
    consultationFee: '500.00',
    convenienceFeePct: '20.00',
    convenienceFee: '100.00',
    gstPct: '18.00',
    gstAmount: '108.00',
    status: 'created',
    gatewayOrderId: null,
    gatewayPaymentId: null,
    paymentMethod: null,
    paidAt: null,
    payoutPaidAt: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  } as never;
}

describe('PaymentService', () => {
  let payments: jest.Mocked<PaymentRepository>;
  let config: jest.Mocked<PaymentConfigService>;
  let gateway: jest.Mocked<RazorpayClient>;
  let audit: jest.Mocked<AuditService>;
  let pricing: jest.Mocked<PricingFacade>;
  let service: PaymentService;

  beforeEach(() => {
    payments = {
      insert: jest.fn().mockResolvedValue(paymentRow()),
      findById: jest.fn().mockResolvedValue(paymentRow()),
      findByConsultationId: jest.fn().mockResolvedValue(null),
      setGatewayOrderId: jest.fn().mockResolvedValue(undefined),
      markPaidIfUnpaid: jest.fn().mockResolvedValue(1),
      markFailedIfNotPaid: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<PaymentRepository>;

    config = {
      getRatesForBilling: jest.fn().mockResolvedValue({ convenienceFeePct: '20.00', gstPct: '18.00' }),
    } as unknown as jest.Mocked<PaymentConfigService>;

    gateway = {
      createOrder: jest.fn().mockResolvedValue({ id: 'order_test_1', amount: 70_800, currency: 'INR', status: 'created' }),
      fetchOrderPayments: jest.fn().mockResolvedValue([]),
      getPublishableKeyId: jest.fn().mockReturnValue('rzp_test_publishable'),
    } as unknown as jest.Mocked<RazorpayClient>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    pricing = {
      // Every fixture in this spec is a LEGACY payment (`priceQuoteId: null`),
      // so `capturedTotalPaise` takes the `calculateBill` branch and none of
      // these are reached. They exist so the constructor is satisfiable.
      getQuoteTotals: jest.fn().mockResolvedValue({}),
      preview: jest.fn(),
      createQuote: jest.fn(),
      pin: jest.fn(),
      materialiseAndPin: jest.fn(),
      markConsumed: jest.fn().mockResolvedValue({ changed: true }),
      abandon: jest.fn().mockResolvedValue({ changed: true }),
      allocateInvoiceNumber: jest.fn().mockResolvedValue({ number: 'INV/2026-27/000001', issuedAt: new Date() }),
      allocateCreditNoteNumber: jest.fn().mockResolvedValue({ number: 'CRN/2026-27/000001', issuedAt: new Date() }),
      apportionRefund: jest.fn(),
      refundAmountForPct: jest.fn(),
      hasCatalogue: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<PricingFacade>;

    service = new PaymentService({} as Database, payments, config, gateway, audit, pricing);
  });

  /* ================================================================== */
  /* quote                                                               */
  /* ================================================================== */

  describe('quote', () => {
    /** FR-7.3, through the service rather than through the arithmetic directly. */
    it('reproduces the FR-7.3 worked example exactly', async () => {
      expect(await service.quote('500.00')).toEqual({
        consultationFee: '500.00',
        convenienceFeePct: '20.00',
        convenienceFee: '100.00',
        gstPct: '18.00',
        gstAmount: '108.00',
        totalPayable: '708.00',
        currency: 'INR',
      });
    });

    it('persists NOTHING — booking shows this before checkout', async () => {
      await service.quote('500.00');
      expect(payments.insert).not.toHaveBeenCalled();
      expect(gateway.createOrder).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('uses today’s rates, which is why they are snapshotted at order time instead', async () => {
      config.getRatesForBilling.mockResolvedValue({ convenienceFeePct: '10.00', gstPct: '5.00' });
      const quote = await service.quote('500.00');
      // 500 + 50 = 550, +5% = 27.50 -> 577.50.
      expect(quote.totalPayable).toBe('577.50');
    });
  });

  /* ================================================================== */
  /* createOrderForConsultation                                          */
  /* ================================================================== */

  describe('createOrderForConsultation', () => {
    it('writes the payments row BEFORE calling the gateway', async () => {
      const order: string[] = [];
      payments.insert.mockImplementationOnce(async () => {
        order.push('row');
        return paymentRow();
      });
      gateway.createOrder.mockImplementationOnce(async () => {
        order.push('gateway');
        return { id: 'order_test_1' } as never;
      });

      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });

      // A row written first, with no gateway_order_id yet, is visible evidence
      // a checkout was started. The reverse order can leave an order at
      // Razorpay we have no record of.
      expect(order).toEqual(['row', 'gateway']);
    });

    it('SNAPSHOTS the rates onto the row', async () => {
      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });

      // `payments.schema.ts`: "The rate in force at checkout — app_config may
      // have moved on since." A bill reprinted a year later must show what was
      // actually charged.
      expect(payments.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          consultationFee: '500.00',
          convenienceFeePct: '20.00',
          convenienceFee: '100.00',
          gstPct: '18.00',
          gstAmount: '108.00',
        }),
      );
    });

    it('sends the total to the gateway in INTEGER PAISE', async () => {
      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });
      expect(gateway.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 70_800, currency: 'INR' }));
    });

    /** Razorpay treats `receipt` as an idempotency key and rejects a duplicate, so a repeated create for one row is impossible at the gateway too. */
    it('sends our payment id as the receipt', async () => {
      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });
      expect(gateway.createOrder).toHaveBeenCalledWith(expect.objectContaining({ receipt: PAYMENT_ID }));
      // A uuid is 36 chars, inside Razorpay's 40-char receipt limit.
      expect(PAYMENT_ID.length).toBeLessThanOrEqual(40);
    });

    it('attaches the gateway order id and returns the publishable key', async () => {
      const result = await service.createOrderForConsultation({
        consultationId: CONSULTATION_ID,
        consultationFeeInr: '500.00',
      });

      expect(payments.setGatewayOrderId).toHaveBeenCalledWith(PAYMENT_ID, 'order_test_1');
      expect(result).toEqual({
        paymentId: PAYMENT_ID,
        gatewayOrderId: 'order_test_1',
        gatewayKeyId: 'rzp_test_publishable',
        breakdown: expect.objectContaining({ totalPayable: '708.00' }) as never,
      });
    });

    it('refuses a second order for a consultation that already has one', async () => {
      payments.findByConsultationId.mockResolvedValue(paymentRow());

      await expect(
        service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'PAYMENT_ALREADY_EXISTS' } });

      expect(gateway.createOrder).not.toHaveBeenCalled();
    });

    /** Two concurrent checkouts both pass the SELECT; the UNIQUE on `consultation_id` settles it. */
    it('turns a unique-violation race into the same 409, not a 500', async () => {
      payments.insert.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(
        service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'PAYMENT_ALREADY_EXISTS' } });
    });

    it('propagates a non-unique database error rather than mislabelling it a conflict', async () => {
      payments.insert.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
      await expect(
        service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' }),
      ).rejects.toThrow('connection lost');
    });

    it('audits the order creation against the consultation', async () => {
      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'payment',
          entityId: PAYMENT_ID,
          consultationId: CONSULTATION_ID,
          metadata: expect.objectContaining({ amountPaise: 70_800 }) as never,
        }),
      );
    });

    it('never marks the payment paid — only a verified webhook may do that', async () => {
      await service.createOrderForConsultation({ consultationId: CONSULTATION_ID, consultationFeeInr: '500.00' });
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* getByConsultationId                                                 */
  /* ================================================================== */

  describe('getByConsultationId', () => {
    it('returns the status booking gates on', async () => {
      const paidAt = new Date('2026-09-01T11:00:00Z');
      payments.findByConsultationId.mockResolvedValue(paymentRow({ status: 'paid', paidAt }));

      expect(await service.getByConsultationId(CONSULTATION_ID)).toEqual({
        paymentId: PAYMENT_ID,
        status: 'paid',
        paidAt,
      });
    });

    it('returns null when there is no payment', async () => {
      payments.findByConsultationId.mockResolvedValue(null);
      expect(await service.getByConsultationId(CONSULTATION_ID)).toBeNull();
    });
  });

  /* ================================================================== */
  /* reconcileWithGateway                                                */
  /* ================================================================== */

  describe('reconcileWithGateway — asks the gateway, never trusts local state', () => {
    it('marks a payment paid when the gateway says it was captured but no webhook arrived', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'pending' }));
      gateway.fetchOrderPayments.mockResolvedValue([
        { id: 'pay_1', status: 'captured', amount: 70_800, method: 'upi' } as never,
      ]);

      const result = await service.reconcileWithGateway(PAYMENT_ID);

      expect(result).toEqual({ status: 'paid', changed: true });
      expect(payments.markPaidIfUnpaid).toHaveBeenCalledWith(
        PAYMENT_ID,
        expect.objectContaining({ gatewayPaymentId: 'pay_1', paymentMethod: 'upi' }),
      );
    });

    /** The same guard the webhook uses, so reconciliation can never double-capture. */
    it('reports changed:false when a webhook won the race', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1' }));
      gateway.fetchOrderPayments.mockResolvedValue([{ id: 'pay_1', status: 'captured', amount: 70_800 } as never]);
      payments.markPaidIfUnpaid.mockResolvedValue(0);

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'paid', changed: false });
    });

    it('does nothing for an already-paid payment, and does not call the gateway', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'paid', paidAt: new Date() }));

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'paid', changed: false });
      expect(gateway.fetchOrderPayments).not.toHaveBeenCalled();
    });

    it('does nothing when the order was never created — no money can have moved', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: null, status: 'created' }));

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'created', changed: false });
      expect(gateway.fetchOrderPayments).not.toHaveBeenCalled();
    });

    it('leaves a genuinely unpaid payment alone', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'pending' }));
      gateway.fetchOrderPayments.mockResolvedValue([]);

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'pending', changed: false });
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
    });

    it('marks failed when every attempt at the gateway failed', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'pending' }));
      gateway.fetchOrderPayments.mockResolvedValue([{ id: 'pay_1', status: 'failed', amount: 70_800 } as never]);

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'failed', changed: true });
    });

    it('does NOT mark failed while an attempt is still in flight alongside a failed one', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'pending' }));
      gateway.fetchOrderPayments.mockResolvedValue([
        { id: 'pay_1', status: 'failed', amount: 70_800 } as never,
        { id: 'pay_2', status: 'authorized', amount: 70_800 } as never,
      ]);

      expect(await service.reconcileWithGateway(PAYMENT_ID)).toEqual({ status: 'pending', changed: false });
      expect(payments.markFailedIfNotPaid).not.toHaveBeenCalled();
    });

    /** *** The amount check. *** A capture we did not bill is not payment for this consultation. */
    it('REFUSES to mark paid when the gateway captured a different amount', async () => {
      payments.findById.mockResolvedValue(paymentRow({ gatewayOrderId: 'order_test_1', status: 'pending' }));
      gateway.fetchOrderPayments.mockResolvedValue([{ id: 'pay_1', status: 'captured', amount: 100 } as never]);

      const result = await service.reconcileWithGateway(PAYMENT_ID);

      expect(result).toEqual({ status: 'pending', changed: false });
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ reconciliation: 'amount_mismatch' }) as never }),
      );
    });

    it('404s for a payment that does not exist', async () => {
      payments.findById.mockResolvedValue(null);
      await expect(service.reconcileWithGateway(PAYMENT_ID)).rejects.toMatchObject({
        status: 404,
        response: { code: 'PAYMENT_NOT_FOUND' },
      });
    });
  });
});
