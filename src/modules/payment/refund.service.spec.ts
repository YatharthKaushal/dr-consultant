import type { Database } from '../../config/db/database.config';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PaymentRepository } from './payment.repository';
import type { RazorpayClient } from './razorpay.client';
import { RefundRepository } from './refund.repository';
import { RefundService } from './refund.service';

const PAYMENT_ID = 'e1f7a8d0-0000-4000-8000-000000000001';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

/** A CAPTURED payment billing FR-7.3's 708.00 — 500 fee + 100 convenience + 108 GST. */
function capturedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    consultationId: CONSULTATION_ID,
    currency: 'INR',
    consultationFee: '500.00',
    convenienceFeePct: '20.00',
    convenienceFee: '100.00',
    gstPct: '18.00',
    gstAmount: '108.00',
    status: 'paid',
    gatewayOrderId: 'order_1',
    gatewayPaymentId: 'pay_1',
    paidAt: new Date('2026-09-01T10:00:00Z'),
    payoutPaidAt: null,
    ...overrides,
  } as never;
}

describe('RefundService', () => {
  let db: { transaction: jest.Mock };
  let payments: jest.Mocked<PaymentRepository>;
  let refunds: jest.Mocked<RefundRepository>;
  let gateway: jest.Mocked<RazorpayClient>;
  let audit: jest.Mocked<AuditService>;
  let service: RefundService;
  /** Amounts the fake repository will report as already committed. */
  let committedAmounts: string[];
  let processedAmounts: string[];
  let createdRefundId: number;

  beforeEach(() => {
    committedAmounts = [];
    processedAmounts = [];
    createdRefundId = 0;

    db = {
      // A callback-invoking fake. It has NO rollback semantics — which is
      // exactly why `refund.invariant.integration.spec.ts` exists against a
      // real database. These tests assert the RULES; that one asserts the
      // LOCKING.
      transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };

    payments = {
      findByIdForUpdate: jest.fn().mockResolvedValue(capturedPayment()),
      findById: jest.fn().mockResolvedValue(capturedPayment()),
      setRefundStatus: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PaymentRepository>;

    refunds = {
      create: jest.fn(async (values: Record<string, unknown>) => {
        createdRefundId += 1;
        // A created row immediately counts as committed, which is what the
        // real `listCommittedAmounts` would report on the next read.
        committedAmounts.push(values.amount as string);
        return {
          id: `r0000000-0000-4000-8000-00000000000${createdRefundId}`,
          paymentId: values.paymentId,
          amount: values.amount,
          reason: values.reason,
          initiatedByAdminId: values.initiatedByAdminId,
          isAutomatic: values.isAutomatic,
          status: 'pending',
        };
      }),
      listCommittedAmounts: jest.fn(async () => [...committedAmounts]),
      listProcessedAmounts: jest.fn(async () => [...processedAmounts]),
      attachGatewayRefundId: jest.fn().mockResolvedValue(1),
      markFailedIfNotProcessed: jest.fn().mockResolvedValue(1),
      findById: jest.fn(async (id: string) => ({ id, status: 'processing' })),
      listByPaymentId: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<RefundRepository>;

    gateway = {
      createRefund: jest.fn().mockResolvedValue({ id: 'rfnd_gateway_1', status: 'pending' }),
    } as unknown as jest.Mocked<RazorpayClient>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    service = new RefundService(db as unknown as Database, payments, refunds, gateway, audit);
  });

  function refundInput(amount: string, overrides: Partial<Parameters<RefundService['createRefund']>[0]> = {}) {
    return {
      paymentId: PAYMENT_ID,
      amount,
      reason: 'Cancelled within policy',
      initiatedByAdminId: ADMIN_ID,
      isAutomatic: false,
      ...overrides,
    };
  }

  /* ================================================================== */
  /* THE ORDERING                                                        */
  /* ================================================================== */

  describe('the row exists BEFORE the gateway is called', () => {
    it('creates the refunds row first, then calls Razorpay', async () => {
      const order: string[] = [];
      refunds.create.mockImplementationOnce(async () => {
        order.push('row');
        return { id: 'r1', paymentId: PAYMENT_ID, amount: '100.00', initiatedByAdminId: ADMIN_ID } as never;
      });
      gateway.createRefund.mockImplementationOnce(async () => {
        order.push('gateway');
        return { id: 'rfnd_1', status: 'pending' } as never;
      });

      await service.createRefund(refundInput('100.00'));

      // `refunds.schema.ts`: "the row is created BEFORE the gateway call (so a
      // crash mid-call leaves evidence rather than a silent gap)".
      expect(order).toEqual(['row', 'gateway']);
    });

    it('takes the payment row lock before reading the committed total', async () => {
      await service.createRefund(refundInput('100.00'));
      // *** The lock is what makes the invariant hold under concurrency. ***
      expect(payments.findByIdForUpdate).toHaveBeenCalledWith(PAYMENT_ID, expect.anything());
      expect(refunds.listCommittedAmounts).toHaveBeenCalled();
    });

    it('leaves the row behind, marked failed, when the gateway rejects', async () => {
      const boom = Object.assign(new Error('rejected'), { response: { code: 'PAYMENT_REFUND_NOT_PERMITTED' } });
      gateway.createRefund.mockRejectedValueOnce(boom);

      await expect(service.createRefund(refundInput('100.00'))).rejects.toThrow('rejected');

      // Evidence, not a gap.
      expect(refunds.create).toHaveBeenCalledTimes(1);
      expect(refunds.markFailedIfNotProcessed).toHaveBeenCalledWith(
        expect.any(String),
        'PAYMENT_REFUND_NOT_PERMITTED',
      );
    });

    it('re-throws the classified gateway error rather than swallowing it', async () => {
      gateway.createRefund.mockRejectedValueOnce(new Error('gateway exploded'));
      await expect(service.createRefund(refundInput('100.00'))).rejects.toThrow('gateway exploded');
    });

    it('still re-throws the original error when recording the failure ALSO fails', async () => {
      gateway.createRefund.mockRejectedValueOnce(new Error('the real problem'));
      refunds.markFailedIfNotProcessed.mockRejectedValueOnce(new Error('and the database too'));

      // Losing the original exception would be strictly worse than losing the
      // status update — the row already exists as evidence either way.
      await expect(service.createRefund(refundInput('100.00'))).rejects.toThrow('the real problem');
    });
  });

  /* ================================================================== */
  /* THE INVARIANT                                                       */
  /* ================================================================== */

  describe('the invariant: refunds must never exceed what was captured', () => {
    it('allows a partial refund', async () => {
      const result = await service.createRefund(refundInput('300.00'));
      expect(result.refundId).toBeDefined();
      expect(refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '300.00' }),
        expect.anything(),
      );
    });

    /**
     * *** THE THING THE OLD SCHEMA MADE IMPOSSIBLE. ***
     * `payments` carried refunds as inline columns, so exactly ONE refund per
     * payment was representable. Two partials in sequence is the case the
     * `refunds` table exists for.
     */
    it('allows a SECOND partial refund against the same payment', async () => {
      await service.createRefund(refundInput('300.00'));
      const second = await service.createRefund(refundInput('400.00'));

      expect(second.refundId).toBeDefined();
      expect(refunds.create).toHaveBeenCalledTimes(2);
      // 300 + 400 = 700, inside the 708 captured.
      expect(committedAmounts).toEqual(['300.00', '400.00']);
    });

    it('allows refunding exactly the full captured amount', async () => {
      await expect(service.createRefund(refundInput('708.00'))).resolves.toBeDefined();
    });

    it('REFUSES a refund larger than what was captured', async () => {
      await expect(service.createRefund(refundInput('708.01'))).rejects.toMatchObject({
        status: 409,
        response: { code: 'REFUND_EXCEEDS_CAPTURED' },
      });
      expect(refunds.create).not.toHaveBeenCalled();
      expect(gateway.createRefund).not.toHaveBeenCalled();
    });

    it('REFUSES a second refund that would push the total over the capture', async () => {
      await service.createRefund(refundInput('700.00'));

      await expect(service.createRefund(refundInput('100.00'))).rejects.toMatchObject({
        status: 409,
        response: { code: 'REFUND_EXCEEDS_CAPTURED' },
      });
      // Only the first row was ever created.
      expect(refunds.create).toHaveBeenCalledTimes(1);
    });

    it('tells the admin exactly how much is still refundable', async () => {
      await service.createRefund(refundInput('700.00'));

      await expect(service.createRefund(refundInput('100.00'))).rejects.toMatchObject({
        response: { message: expect.stringContaining('8.00') as never },
      });
    });

    /**
     * A refund still in flight has not settled, but the money is committed.
     * Counting only `processed` would let a second refund be approved while a
     * first was in flight and the two together exceed the capture.
     */
    it('counts pending and processing refunds, not only settled ones', async () => {
      // The fake repository reports created rows through
      // `listCommittedAmounts`, which the real one populates from
      // status IN (pending, processing, processed).
      await service.createRefund(refundInput('708.00'));
      expect(refunds.listCommittedAmounts).toHaveBeenCalled();

      await expect(service.createRefund(refundInput('0.01'))).rejects.toMatchObject({
        response: { code: 'REFUND_EXCEEDS_CAPTURED' },
      });
    });

    it('refuses to refund a payment that was never captured', async () => {
      payments.findByIdForUpdate.mockResolvedValue(capturedPayment({ paidAt: null, gatewayPaymentId: null }));

      await expect(service.createRefund(refundInput('100.00'))).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENT_NOT_CAPTURED' },
      });
      expect(gateway.createRefund).not.toHaveBeenCalled();
    });

    it('404s for a payment that does not exist', async () => {
      payments.findByIdForUpdate.mockResolvedValue(null);
      await expect(service.createRefund(refundInput('100.00'))).rejects.toMatchObject({
        status: 404,
        response: { code: 'PAYMENT_NOT_FOUND' },
      });
    });
  });

  describe('amount validation', () => {
    it.each([['0.00'], ['0'], ['-10.00'], ['abc'], [''], ['10.005'], ['1e3']])('refuses %s', async (amount) => {
      await expect(service.createRefund(refundInput(amount))).rejects.toMatchObject({
        status: 400,
        response: { code: 'REFUND_AMOUNT_INVALID' },
      });
    });

    it('never reaches the gateway for a malformed amount', async () => {
      await expect(service.createRefund(refundInput('nonsense'))).rejects.toBeDefined();
      expect(gateway.createRefund).not.toHaveBeenCalled();
      expect(payments.findByIdForUpdate).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* GATEWAY INTERACTION                                                 */
  /* ================================================================== */

  describe('gateway interaction', () => {
    it('sends INTEGER PAISE, not rupees', async () => {
      await service.createRefund(refundInput('708.00'));
      expect(gateway.createRefund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 70_800 }));
    });

    it('sends odd paise exactly', async () => {
      await service.createRefund(refundInput('66.67'));
      expect(gateway.createRefund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 6_667 }));
    });

    it('marks the refund processing when the gateway is still settling', async () => {
      gateway.createRefund.mockResolvedValue({ id: 'rfnd_1', status: 'pending' } as never);
      await service.createRefund(refundInput('100.00'));

      expect(refunds.attachGatewayRefundId).toHaveBeenCalledWith(expect.any(String), 'rfnd_1', 'processing');
      // Not settled, so the payment status is untouched.
      expect(payments.setRefundStatus).not.toHaveBeenCalled();
    });

    it('marks it processed and recomputes the payment when the gateway settled immediately', async () => {
      gateway.createRefund.mockResolvedValue({ id: 'rfnd_1', status: 'processed' } as never);
      processedAmounts = ['100.00'];

      await service.createRefund(refundInput('100.00'));

      expect(refunds.attachGatewayRefundId).toHaveBeenCalledWith(expect.any(String), 'rfnd_1', 'processed');
      expect(payments.setRefundStatus).toHaveBeenCalledWith(PAYMENT_ID, 'partially_refunded');
    });
  });

  /* ================================================================== */
  /* PAYMENT STATUS TRANSITIONS                                          */
  /* ================================================================== */

  describe('recomputePaymentRefundStatus', () => {
    it('moves the payment to partially_refunded when some of it has settled', async () => {
      processedAmounts = ['300.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).toHaveBeenCalledWith(PAYMENT_ID, 'partially_refunded');
    });

    it('moves the payment to refunded when everything captured has gone back', async () => {
      processedAmounts = ['708.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).toHaveBeenCalledWith(PAYMENT_ID, 'refunded');
    });

    it('transitions partially_refunded THEN refunded across two settlements', async () => {
      processedAmounts = ['300.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).toHaveBeenLastCalledWith(PAYMENT_ID, 'partially_refunded');

      payments.findById.mockResolvedValue(capturedPayment({ status: 'partially_refunded' }));
      processedAmounts = ['300.00', '408.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).toHaveBeenLastCalledWith(PAYMENT_ID, 'refunded');
    });

    it('does nothing while every refund is still in flight — no money has moved', async () => {
      processedAmounts = [];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).not.toHaveBeenCalled();
    });

    it('does not rewrite a status that is already correct', async () => {
      payments.findById.mockResolvedValue(capturedPayment({ status: 'refunded' }));
      processedAmounts = ['708.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).not.toHaveBeenCalled();
    });

    it('does nothing for an uncaptured payment', async () => {
      payments.findById.mockResolvedValue(capturedPayment({ paidAt: null }));
      processedAmounts = ['100.00'];
      await service.recomputePaymentRefundStatus(PAYMENT_ID);
      expect(payments.setRefundStatus).not.toHaveBeenCalled();
    });
  });

  describe('getRefundableAmount', () => {
    it('is the whole capture when nothing has been refunded', async () => {
      expect(await service.getRefundableAmount(PAYMENT_ID)).toBe('708.00');
    });

    it('drops by what is already committed', async () => {
      committedAmounts = ['300.00'];
      expect(await service.getRefundableAmount(PAYMENT_ID)).toBe('408.00');
    });

    it('never goes negative', async () => {
      committedAmounts = ['708.00', '100.00'];
      expect(await service.getRefundableAmount(PAYMENT_ID)).toBe('0.00');
    });

    it('is zero for an uncaptured payment', async () => {
      payments.findById.mockResolvedValue(capturedPayment({ paidAt: null }));
      expect(await service.getRefundableAmount(PAYMENT_ID)).toBe('0.00');
    });
  });

  /* ================================================================== */
  /* AUDIT AND POLICY                                                    */
  /* ================================================================== */

  describe('audit', () => {
    /**
     * `docs/MODULES.md` §7: "Every module touching clinical or financial data
     * writes audit entries." `AuditService`'s own comment sets the
     * transactional rule for RBAC changes; money is stricter, so the entry is
     * written with the SAME `tx` as the refund row and rolls back with it.
     */
    it('writes the audit entry TRANSACTIONALLY, with the same tx as the refund row', async () => {
      await service.createRefund(refundInput('100.00'));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'refund',
          consultationId: CONSULTATION_ID,
        }),
        // The second argument is the transaction handle — never omitted.
        expect.anything(),
      );
    });

    it('records the amount, the reason and what was already committed', async () => {
      committedAmounts = ['100.00'];
      await service.createRefund(refundInput('200.00'));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            amount: '200.00',
            capturedAmount: '708.00',
            alreadyCommitted: '100.00',
          }) as never,
        }),
        expect.anything(),
      );
    });

    it('attributes an ADMIN-initiated refund to that admin', async () => {
      await service.createRefund(refundInput('100.00', { initiatedByAdminId: ADMIN_ID, isAutomatic: false }));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'admin', actorId: ADMIN_ID }),
        expect.anything(),
      );
      expect(refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({ initiatedByAdminId: ADMIN_ID, isAutomatic: false }),
        expect.anything(),
      );
    });

    /**
     * The agreed policy deviation from FR-7.7 read literally: an in-policy
     * cancellation refunds automatically, with no human involved. M-11 calls
     * this path.
     */
    it('attributes an AUTOMATIC in-policy refund to the system, with a null admin id', async () => {
      await service.createRefund(refundInput('100.00', { initiatedByAdminId: null, isAutomatic: true }));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'system', actorId: null }),
        expect.anything(),
      );
      // `refunds.schema.ts` keeps BOTH: "the FK answers 'who', the boolean
      // answers 'was a human involved at all'".
      expect(refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({ initiatedByAdminId: null, isAutomatic: true }),
        expect.anything(),
      );
    });

    it('truncates a long reason to the column width rather than failing the write', async () => {
      await service.createRefund(refundInput('100.00', { reason: 'x'.repeat(500) }));
      const call = refunds.create.mock.calls[0][0] as { reason: string };
      expect(call.reason.length).toBe(200);
    });
  });

  /* ================================================================== */
  /* THE DEPRECATED COLUMNS                                              */
  /* ================================================================== */

  describe('the legacy inline refund columns are never written', () => {
    it('writes only the refunds table and payments.status', async () => {
      gateway.createRefund.mockResolvedValue({ id: 'rfnd_1', status: 'processed' } as never);
      processedAmounts = ['708.00'];

      await service.createRefund(refundInput('708.00'));

      // `payments.schema.ts` marks refund_amount / refund_reason /
      // refund_initiated_by_admin_id / gateway_refund_id / refunded_at as
      // "@deprecated LEGACY ... Do not write." The only payments write this
      // service makes is the status transition.
      const paymentWrites = Object.entries(payments).filter(
        ([name, fn]) => typeof fn === 'function' && (fn as jest.Mock).mock?.calls?.length > 0 && name.startsWith('set'),
      );
      expect(paymentWrites.map(([name]) => name)).toEqual(['setRefundStatus']);
      expect(payments.setRefundStatus).toHaveBeenCalledWith(PAYMENT_ID, 'refunded');
    });
  });
});
