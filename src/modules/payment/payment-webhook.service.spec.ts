import { createHmac } from 'node:crypto';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { AuditService } from '../../shared/audit/audit.service';
import { PAYMENT_CAPTURED_EVENT } from './payment.contract';
import type { PaymentEventRepository } from './payment-event.repository';
import type { PaymentRepository } from './payment.repository';
import { PaymentWebhookService } from './payment-webhook.service';
import type { RefundRepository } from './refund.repository';
import type { RefundService } from './refund.service';

const SECRET = 'whsec_test_secret';

/** A realistic `payment.captured` envelope. */
function capturedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity: 'event',
    account_id: 'acc_BFQ7uQEaa7j2z6',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: 'pay_29QQoUBi66xm2f',
          entity: 'payment',
          amount: 70_800,
          currency: 'INR',
          status: 'captured',
          order_id: 'order_test_1',
          method: 'upi',
          captured: true,
          ...overrides,
        },
      },
    },
    created_at: 1_567_674_599,
  };
}

function refundEnvelope(event: string, entity: Record<string, unknown>): Record<string, unknown> {
  return {
    entity: 'event',
    event,
    contains: ['refund'],
    payload: { refund: { entity: { entity: 'refund', currency: 'INR', ...entity } } },
    created_at: 1_567_674_599,
  };
}

function sign(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const PAYMENT_ID = 'e1f7a8d0-0000-4000-8000-000000000001';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';

/** A `payments` row shaped like the real one, billing FR-7.3's 708.00. */
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
    status: 'pending',
    gatewayOrderId: 'order_test_1',
    gatewayPaymentId: null,
    paymentMethod: null,
    paidAt: null,
    payoutPaidAt: null,
    ...overrides,
  } as never;
}

describe('PaymentWebhookService', () => {
  let events: jest.Mocked<PaymentEventRepository>;
  let payments: jest.Mocked<PaymentRepository>;
  let refunds: jest.Mocked<RefundRepository>;
  let refundService: jest.Mocked<RefundService>;
  let audit: jest.Mocked<AuditService>;
  let emitter: jest.Mocked<EventEmitter2>;
  let service: PaymentWebhookService;

  beforeEach(() => {
    events = {
      insertIfNew: jest.fn().mockResolvedValue({ id: 1 }),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      attachPaymentId: jest.fn().mockResolvedValue(undefined),
      findByGatewayEventId: jest.fn(),
      listUnprocessed: jest.fn(),
      listByPaymentId: jest.fn(),
    } as unknown as jest.Mocked<PaymentEventRepository>;

    payments = {
      findById: jest.fn().mockResolvedValue(paymentRow()),
      findByGatewayOrderId: jest.fn().mockResolvedValue(paymentRow()),
      findByGatewayPaymentId: jest.fn().mockResolvedValue(null),
      markPaidIfUnpaid: jest.fn().mockResolvedValue(1),
      markFailedIfNotPaid: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<PaymentRepository>;

    refunds = {
      findByGatewayRefundId: jest.fn().mockResolvedValue(null),
      markProcessedIfNot: jest.fn().mockResolvedValue(1),
      markFailedIfNotProcessed: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<RefundRepository>;

    refundService = { recomputePaymentRefundStatus: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<RefundService>;
    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
    emitter = { emit: jest.fn().mockReturnValue(true) } as unknown as jest.Mocked<EventEmitter2>;

    service = new PaymentWebhookService(events, payments, refunds, refundService, audit, emitter);
  });

  /* ================================================================== */
  /* THE SECURITY BOUNDARY                                               */
  /* ================================================================== */

  describe('verifySignature — the entire auth boundary for a @Public() route', () => {
    const body = Buffer.from(JSON.stringify(capturedEnvelope()));

    it('accepts a correctly-computed HMAC-SHA256 signature', () => {
      expect(service.verifySignature(body, sign(body), SECRET)).toBe(true);
    });

    it('rejects a signature computed with the wrong secret', () => {
      expect(service.verifySignature(body, sign(body, 'the-wrong-secret'), SECRET)).toBe(false);
    });

    it('rejects a signature for a DIFFERENT body — the whole point of signing the payload', () => {
      const tampered = Buffer.from(JSON.stringify(capturedEnvelope({ amount: 1 })));
      expect(service.verifySignature(tampered, sign(body), SECRET)).toBe(false);
    });

    it('rejects a missing signature header', () => {
      expect(service.verifySignature(body, undefined, SECRET)).toBe(false);
      expect(service.verifySignature(body, '', SECRET)).toBe(false);
    });

    /**
     * `Buffer.from(x, 'hex')` silently TRUNCATES at the first non-hex
     * character, so `"ab!!!!..."` would become a 1-byte buffer. Without the
     * explicit hex check that short buffer could be compared against a short
     * slice and prefix-match. Rejected outright instead.
     */
    it('rejects a non-hex signature rather than letting Buffer.from truncate it', () => {
      expect(service.verifySignature(body, 'not-hex-at-all', SECRET)).toBe(false);
      expect(service.verifySignature(body, `${sign(body).slice(0, 10)}!!!!`, SECRET)).toBe(false);
    });

    /** `timingSafeEqual` THROWS on differing buffer lengths. That must be a `false`, never an unhandled exception. */
    it('rejects a truncated signature without throwing', () => {
      expect(() => service.verifySignature(body, sign(body).slice(0, 32), SECRET)).not.toThrow();
      expect(service.verifySignature(body, sign(body).slice(0, 32), SECRET)).toBe(false);
    });

    it('rejects an over-long signature without throwing', () => {
      expect(service.verifySignature(body, `${sign(body)}00`, SECRET)).toBe(false);
    });

    it('rejects an empty body and an empty secret', () => {
      expect(service.verifySignature(Buffer.alloc(0), sign(body), SECRET)).toBe(false);
      expect(service.verifySignature(body, sign(body), '')).toBe(false);
    });

    it('is case-insensitive about hex, since the header casing is not ours to dictate', () => {
      expect(service.verifySignature(body, sign(body).toUpperCase(), SECRET)).toBe(true);
    });

    /**
     * The signature is over the RAW BYTES. Re-serialising a parsed object does
     * not reproduce them — key order and number formatting are not preserved —
     * so this asserts that a semantically identical but differently-formatted
     * body does NOT verify against the original signature.
     */
    it('is computed over the exact bytes, not over a re-serialised object', () => {
      const original = Buffer.from('{"event":"payment.captured","created_at":1}');
      const reordered = Buffer.from('{"created_at":1,"event":"payment.captured"}');
      const signature = sign(original);

      expect(service.verifySignature(original, signature, SECRET)).toBe(true);
      expect(service.verifySignature(reordered, signature, SECRET)).toBe(false);
    });

    it('rejects before any database write — nothing is touched for an unverified body', () => {
      service.verifySignature(body, 'deadbeef', SECRET);
      expect(events.insertIfNew).not.toHaveBeenCalled();
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('rejectUnverified', () => {
    it('throws a 401 with our own code', () => {
      expect(() => service.rejectUnverified()).toThrow(
        expect.objectContaining({
          status: 401,
          response: expect.objectContaining({ code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' }),
        }) as never,
      );
    });
  });

  /* ================================================================== */
  /* IDEMPOTENCY                                                         */
  /* ================================================================== */

  describe('idempotency — decided by the database, not by a preceding SELECT', () => {
    const rawBody = Buffer.from(JSON.stringify(capturedEnvelope()));

    it('processes a fresh event', async () => {
      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      expect(result).toEqual({ received: true, handled: true, outcome: 'processed' });
      expect(events.insertIfNew).toHaveBeenCalledWith(expect.objectContaining({ gatewayEventId: 'evt_1' }));
      expect(payments.markPaidIfUnpaid).toHaveBeenCalledTimes(1);
      expect(events.markProcessed).toHaveBeenCalledWith(1);
    });

    /**
     * *** THE REPLAY BRANCH. ***
     * `insertIfNew` returning null IS the unique-constraint violation, i.e.
     * "already handled" — `payment-events.schema.ts`: "The unique constraint IS
     * the idempotency guarantee — a violating insert is the 'already handled'
     * branch, decided by the database."
     */
    it('treats a replayed event id as a NO-OP and never touches the payment', async () => {
      events.insertIfNew.mockResolvedValueOnce(null);

      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      expect(result).toEqual({ received: true, handled: false, outcome: 'duplicate' });
      // The critical assertion: no second capture.
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
      expect(events.markProcessed).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('a replay still answers 2xx, so Razorpay stops retrying', async () => {
      events.insertIfNew.mockResolvedValueOnce(null);
      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(result.received).toBe(true);
    });

    it('records the event BEFORE processing it, so a crash mid-handler still leaves the delivery captured', async () => {
      const order: string[] = [];
      events.insertIfNew.mockImplementationOnce(async () => {
        order.push('insert');
        return { id: 1 } as never;
      });
      payments.markPaidIfUnpaid.mockImplementationOnce(async () => {
        order.push('process');
        return 1;
      });

      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(order).toEqual(['insert', 'process']);
    });
  });

  /* ================================================================== */
  /* ALWAYS 2xx ONCE RECORDED                                            */
  /* ================================================================== */

  describe('a handler failure still answers 2xx and is recorded for the sweep', () => {
    it('records processing_error and leaves processed_at null when the handler throws', async () => {
      const rawBody = Buffer.from(JSON.stringify(capturedEnvelope()));
      payments.markPaidIfUnpaid.mockRejectedValueOnce(new Error('database is on fire'));

      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      // *** 2xx, not a throw. *** A non-2xx makes Razorpay retry, and a retry
      // storm on a poison event helps nobody.
      expect(result).toEqual({ received: true, handled: false, outcome: 'failed' });
      expect(events.markFailed).toHaveBeenCalledWith(1, 'database is on fire');
      expect(events.markProcessed).not.toHaveBeenCalled();
    });

    it('answers 2xx for a body that is not valid JSON, once it is signature-verified', async () => {
      const result = await service.record({
        eventId: 'evt_1',
        rawBody: Buffer.from('not json at all'),
        signatureVerified: true,
      });
      expect(result.received).toBe(true);
      expect(result.outcome).toBe('failed');
    });

    it('answers 2xx for a verified body that is a JSON array rather than an object', async () => {
      const result = await service.record({ eventId: 'evt_1', rawBody: Buffer.from('[1,2,3]'), signatureVerified: true });
      expect(result.received).toBe(true);
    });

    it('records an unhandled event type without acting on it, rather than retrying forever', async () => {
      const rawBody = Buffer.from(JSON.stringify({ event: 'payment.authorized', payload: {} }));
      const result = await service.record({ eventId: 'evt_x', rawBody, signatureVerified: true });

      expect(result.outcome).toBe('processed');
      expect(events.markProcessed).toHaveBeenCalledWith(1);
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* UNRESOLVABLE EVENTS                                                 */
  /* ================================================================== */

  describe('an event for a payment we cannot resolve yet', () => {
    it('is still durably recorded, with a null payment_id', async () => {
      payments.findByGatewayOrderId.mockResolvedValue(null);
      payments.findByGatewayPaymentId.mockResolvedValue(null);
      const rawBody = Buffer.from(JSON.stringify(capturedEnvelope()));

      const result = await service.record({ eventId: 'evt_orphan', rawBody, signatureVerified: true });

      // `payment_events.payment_id` is "nullable so an out-of-order or
      // unmatched event is still durably captured rather than dropped on the
      // floor" (payment-events.schema.ts).
      expect(events.insertIfNew).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayEventId: 'evt_orphan', paymentId: null }),
      );
      // Deferred, not failed — a different thing, recorded differently.
      expect(result).toEqual({ received: true, handled: false, outcome: 'deferred' });
      expect(events.markFailed).toHaveBeenCalledWith(1, expect.stringContaining('deferred') as never);
      expect(events.markProcessed).not.toHaveBeenCalled();
    });

    it('still answers 2xx', async () => {
      payments.findByGatewayOrderId.mockResolvedValue(null);
      payments.findByGatewayPaymentId.mockResolvedValue(null);
      const rawBody = Buffer.from(JSON.stringify(capturedEnvelope()));

      const result = await service.record({ eventId: 'evt_orphan', rawBody, signatureVerified: true });
      expect(result.received).toBe(true);
    });

    it('defers a refund.processed whose refunds row has not committed yet', async () => {
      refunds.findByGatewayRefundId.mockResolvedValue(null);
      const rawBody = Buffer.from(
        JSON.stringify(refundEnvelope('refund.processed', { id: 'rfnd_1', payment_id: 'pay_1', amount: 10_000, status: 'processed' })),
      );

      const result = await service.record({ eventId: 'evt_r', rawBody, signatureVerified: true });
      expect(result.outcome).toBe('deferred');
      expect(refunds.markProcessedIfNot).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* payment.captured                                                    */
  /* ================================================================== */

  describe('payment.captured', () => {
    const rawBody = Buffer.from(JSON.stringify(capturedEnvelope()));

    it('marks the payment paid with the gateway id and method', async () => {
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      expect(payments.markPaidIfUnpaid).toHaveBeenCalledWith(
        PAYMENT_ID,
        expect.objectContaining({ gatewayPaymentId: 'pay_29QQoUBi66xm2f', paymentMethod: 'upi' }),
      );
    });

    it('is a no-op when the payment was already captured', async () => {
      payments.findById.mockResolvedValue(paymentRow({ paidAt: new Date(), gatewayPaymentId: 'pay_old' }));

      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      expect(result.outcome).toBe('processed');
      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
    });

    it('handles losing the race — markPaidIfUnpaid returning 0 is not an error', async () => {
      payments.markPaidIfUnpaid.mockResolvedValue(0);
      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(result.outcome).toBe('processed');
    });

    /**
     * *** THE AMOUNT CHECK. ***
     * A capture for an amount we did not bill is not payment for this
     * consultation. Accepting it would let an underpayment unlock a consult.
     */
    it('REFUSES to mark paid when the captured amount is not the billed amount', async () => {
      const wrongAmount = Buffer.from(JSON.stringify(capturedEnvelope({ amount: 100 })));

      const result = await service.record({ eventId: 'evt_1', rawBody: wrongAmount, signatureVerified: true });

      expect(payments.markPaidIfUnpaid).not.toHaveBeenCalled();
      expect(result.outcome).toBe('failed');
      expect(events.markFailed).toHaveBeenCalled();
    });

    it('accepts exactly the FR-7.3 amount of 70800 paise', async () => {
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(payments.markPaidIfUnpaid).toHaveBeenCalled();
    });

    it('links the event row to the payment once resolved', async () => {
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(events.attachPaymentId).toHaveBeenCalledWith(1, PAYMENT_ID);
    });

    it('writes an audit entry for the capture', async () => {
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          entityType: 'payment',
          metadata: expect.objectContaining({ outcome: 'captured' }) as never,
        }),
      );
    });

    /* ---------------------------------------------------------------- */
    /* The paid -> scheduled signal that booking listens for             */
    /* ---------------------------------------------------------------- */

    it('announces the capture so booking can take the consultation live', async () => {
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(emitter.emit).toHaveBeenCalledWith(PAYMENT_CAPTURED_EVENT, {
        paymentId: PAYMENT_ID,
        consultationId: CONSULTATION_ID,
        gatewayPaymentId: 'pay_29QQoUBi66xm2f',
      });
    });

    it('does NOT announce a capture it refused for an amount mismatch', async () => {
      const wrongAmount = Buffer.from(JSON.stringify(capturedEnvelope()).replace('70800', '70799'));
      await service.record({ eventId: 'evt_1', rawBody: wrongAmount, signatureVerified: true });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does NOT re-announce a replayed capture — the second delivery is a no-op', async () => {
      payments.findById.mockResolvedValue(paymentRow({ paidAt: new Date(), status: 'paid' }));
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does NOT announce when it lost the race and marked nothing', async () => {
      payments.markPaidIfUnpaid.mockResolvedValue(0);
      await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('records the capture as PROCESSED even if announcing it throws', async () => {
      // The capture is already committed by the time the event is emitted, so a
      // throw here must not rewrite a successful capture into a `failed`
      // delivery with a processing_error — which is what would happen if the
      // emit were not wrapped, since `record` treats any handler throw as a
      // failed delivery and feeds it to the retry sweep.
      emitter.emit.mockImplementation(() => {
        throw new Error('listener blew up');
      });

      const result = await service.record({ eventId: 'evt_1', rawBody, signatureVerified: true });

      expect(result.outcome).toBe('processed');
      expect(payments.markPaidIfUnpaid).toHaveBeenCalled();
      expect(events.markFailed).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* payment.failed                                                      */
  /* ================================================================== */

  describe('payment.failed', () => {
    const failedBody = Buffer.from(
      JSON.stringify({
        entity: 'event',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_failed_1',
              order_id: 'order_test_1',
              amount: 70_800,
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Payment failed',
              error_source: 'customer',
              error_step: 'payment_authorization',
              error_reason: 'payment_failed',
            },
          },
        },
      }),
    );

    it('records the failure with OUR classified kind, not the gateway description', async () => {
      await service.record({ eventId: 'evt_f', rawBody: failedBody, signatureVerified: true });

      expect(payments.markFailedIfNotPaid).toHaveBeenCalledWith(PAYMENT_ID, 'payment_declined');
    });

    it('cannot undo a capture — a late payment.failed for an already-paid payment is ignored', async () => {
      // `markFailedIfNotPaid` is guarded on `paid_at IS NULL` in SQL; 0 rows
      // means the guard fired.
      payments.markFailedIfNotPaid.mockResolvedValue(0);

      const result = await service.record({ eventId: 'evt_f', rawBody: failedBody, signatureVerified: true });

      expect(result.outcome).toBe('processed');
      expect(audit.write).not.toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'failed' }) as never }),
      );
    });
  });

  /* ================================================================== */
  /* refund.processed / refund.failed                                    */
  /* ================================================================== */

  describe('refund.processed', () => {
    const body = Buffer.from(
      JSON.stringify(refundEnvelope('refund.processed', { id: 'rfnd_1', payment_id: 'pay_1', amount: 20_000, status: 'processed' })),
    );

    beforeEach(() => {
      refunds.findByGatewayRefundId.mockResolvedValue({
        id: 'r0000000-0000-4000-8000-000000000001',
        paymentId: PAYMENT_ID,
        amount: '200.00',
        status: 'processing',
      } as never);
    });

    it('settles the refund and recomputes the payment status', async () => {
      const result = await service.record({ eventId: 'evt_rp', rawBody: body, signatureVerified: true });

      expect(refunds.markProcessedIfNot).toHaveBeenCalledWith('r0000000-0000-4000-8000-000000000001');
      // Only now can the payment become partially_refunded / refunded.
      expect(refundService.recomputePaymentRefundStatus).toHaveBeenCalledWith(PAYMENT_ID);
      expect(result.outcome).toBe('processed');
    });

    /** The per-refund idempotency layer `refunds.schema.ts` describes. */
    it('is a no-op when the refund was already processed', async () => {
      refunds.markProcessedIfNot.mockResolvedValue(0);

      const result = await service.record({ eventId: 'evt_rp', rawBody: body, signatureVerified: true });

      expect(result.outcome).toBe('processed');
      expect(refundService.recomputePaymentRefundStatus).not.toHaveBeenCalled();
    });
  });

  describe('refund.failed', () => {
    const body = Buffer.from(
      JSON.stringify(refundEnvelope('refund.failed', { id: 'rfnd_2', payment_id: 'pay_1', amount: 20_000, status: 'failed' })),
    );

    it('marks the refund failed', async () => {
      refunds.findByGatewayRefundId.mockResolvedValue({
        id: 'r0000000-0000-4000-8000-000000000002',
        paymentId: PAYMENT_ID,
        amount: '200.00',
        status: 'processing',
      } as never);

      await service.record({ eventId: 'evt_rf', rawBody: body, signatureVerified: true });
      expect(refunds.markFailedIfNotProcessed).toHaveBeenCalled();
    });

    it('cannot reverse a refund that already settled', async () => {
      refunds.findByGatewayRefundId.mockResolvedValue({
        id: 'r0000000-0000-4000-8000-000000000002',
        paymentId: PAYMENT_ID,
        amount: '200.00',
        status: 'processed',
      } as never);
      refunds.markFailedIfNotProcessed.mockResolvedValue(0);

      const result = await service.record({ eventId: 'evt_rf', rawBody: body, signatureVerified: true });
      expect(result.outcome).toBe('processed');
    });
  });
});
