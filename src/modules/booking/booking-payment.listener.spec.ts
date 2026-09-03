import { Logger } from '@nestjs/common';
import type { BookingSlotHoldService } from './booking-slot-hold.service';
import { BookingPaymentListener } from './booking-payment.listener';
import type { PaymentCapturedEvent } from '../payment/payment.contract';

const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';

function capturedEvent(overrides: Partial<PaymentCapturedEvent> = {}): PaymentCapturedEvent {
  return {
    paymentId: 'e1f7a8d0-0000-4000-8000-000000000001',
    consultationId: CONSULTATION_ID,
    gatewayPaymentId: 'pay_test_1',
    ...overrides,
  };
}

describe('BookingPaymentListener', () => {
  let holds: jest.Mocked<BookingSlotHoldService>;
  let listener: BookingPaymentListener;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    holds = { confirmPayment: jest.fn().mockResolvedValue({ id: CONSULTATION_ID, status: 'scheduled' }) } as unknown as jest.Mocked<BookingSlotHoldService>;
    listener = new BookingPaymentListener(holds);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms the consultation named by the event', async () => {
    await listener.onPaymentCaptured(capturedEvent());
    expect(holds.confirmPayment).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('confirms by CONSULTATION id, never by payment id — they are different rows', async () => {
    await listener.onPaymentCaptured(capturedEvent({ paymentId: 'not-the-consultation' }));
    expect(holds.confirmPayment).toHaveBeenCalledWith(CONSULTATION_ID);
    expect(holds.confirmPayment).not.toHaveBeenCalledWith('not-the-consultation');
  });

  /* ------------------------------------------------------------------ */
  /* Failure must stay contained — the sweep is the real guarantee       */
  /* ------------------------------------------------------------------ */

  it('SWALLOWS a confirm failure rather than rethrowing into the emitter', async () => {
    // A throw here reaches `@nestjs/event-emitter`, which logs it without the
    // consultation id. Worse, it would surface as an unhandled rejection in the
    // webhook's call stack. The sweep retries this regardless, so there is
    // nothing to gain by propagating.
    holds.confirmPayment.mockRejectedValue(new Error('deadlock detected'));

    await expect(listener.onPaymentCaptured(capturedEvent())).resolves.toBeUndefined();
  });

  it('names the consultation and the payment in the error log, so the pair can be found', async () => {
    holds.confirmPayment.mockRejectedValue(new Error('deadlock detected'));

    await listener.onPaymentCaptured(capturedEvent());

    const logged = errorLog.mock.calls[0]?.[0] as string;
    expect(logged).toContain(CONSULTATION_ID);
    expect(logged).toContain('e1f7a8d0-0000-4000-8000-000000000001');
    expect(logged).toContain('deadlock detected');
  });

  it('survives a non-Error rejection without producing "[object Object]"', async () => {
    holds.confirmPayment.mockRejectedValue('a bare string');

    await expect(listener.onPaymentCaptured(capturedEvent())).resolves.toBeUndefined();
    expect(errorLog.mock.calls[0]?.[0] as string).toContain('a bare string');
  });

  it('is safe to run twice for the same capture — idempotency lives in confirmPayment', async () => {
    await listener.onPaymentCaptured(capturedEvent());
    await listener.onPaymentCaptured(capturedEvent());

    expect(holds.confirmPayment).toHaveBeenCalledTimes(2);
    expect(holds.confirmPayment).toHaveBeenNthCalledWith(2, CONSULTATION_ID);
  });
});
