/**
 * *** THE FACADE IS THE CONTRACT, SO IT HAS TO BE ABLE TO SAY EVERYTHING THE
 * CONTRACT SAYS. ***
 *
 * `PaymentFacade implements PaymentContract` is documented as the thing that
 * makes M-11's blind mirror safe: "a signature drift on either side surfaces
 * here as a `tsc` error rather than as a runtime surprise". It did not catch
 * `refundPct` — booking's mirror declared it, `RefundService` read it, and
 * neither this class nor `PaymentContract` mentioned it. The calls worked only
 * because the facade forwards its argument object by reference.
 *
 * Hand-rolled `jest.fn()` collaborators; never `Test.createTestingModule`.
 */

import type { PaymentContract } from './payment.contract';
import { PaymentFacade } from './payment.facade';
import type { PaymentService } from './payment.service';
import type { RefundService } from './refund.service';

const PAYMENT_ID = 'p0000000-0000-4000-8000-000000000001';

function harness() {
  const createRefund = jest.fn(async () => ({ refundId: 'r1', status: 'processing' }));
  const payments = {} as unknown as PaymentService;
  const refunds = { createRefund } as unknown as RefundService;
  return { facade: new PaymentFacade(payments, refunds), createRefund };
}

describe('PaymentFacade.createRefund — the refund base crosses the seam', () => {
  /**
   * *** RED WITHOUT THE FIX, AND RED AT COMPILE TIME. ***
   *
   * With `refundPct` missing from the parameter type this object literal is an
   * excess-property error, so the suite does not build. That is the point: a
   * caller typed against the facade could not ASK for the captured-total base at
   * all, even though the service behind it implements exactly that.
   */
  it('accepts and forwards refundPct', async () => {
    const { facade, createRefund } = harness();

    await facade.createRefund({
      paymentId: PAYMENT_ID,
      amount: '500.00',
      reason: 'Cancellation within policy (100%).',
      initiatedByAdminId: null,
      isAutomatic: true,
      refundPct: 100,
    });

    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({ refundPct: 100 }));
  });

  /** The same call through the CONTRACT type, which is what M-11 holds. */
  it('accepts refundPct through PaymentContract, not just through the class', async () => {
    const { facade, createRefund } = harness();
    const contract: PaymentContract = facade;

    await contract.createRefund({
      paymentId: PAYMENT_ID,
      amount: '500.00',
      reason: 'Cancellation within policy (50%).',
      initiatedByAdminId: null,
      isAutomatic: true,
      refundPct: 50,
    });

    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({ refundPct: 50 }));
  });

  /** Omitting it stays legal — a legacy payment is still refunded by `amount`. */
  it('still accepts a call with no refundPct at all', async () => {
    const { facade, createRefund } = harness();

    await facade.createRefund({
      paymentId: PAYMENT_ID,
      amount: '500.00',
      reason: 'Admin refund.',
      initiatedByAdminId: 'a1',
      isAutomatic: false,
    });

    expect(createRefund).toHaveBeenCalledWith(expect.not.objectContaining({ refundPct: expect.anything() }));
  });
});
