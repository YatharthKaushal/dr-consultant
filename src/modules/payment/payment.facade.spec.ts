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

import type { PaymentBreakdown, PaymentContract } from './payment.contract';
import { PaymentFacade } from './payment.facade';
import type { PaymentService } from './payment.service';
import type { RefundService } from './refund.service';

const PAYMENT_ID = 'p0000000-0000-4000-8000-000000000001';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const PATIENT_ID = 'a0000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'b0000000-0000-4000-8000-000000000001';
const SPECIALTY_ID = 'd0000000-0000-4000-8000-000000000001';

function harness() {
  const createRefund = jest.fn(async () => ({ refundId: 'r1', status: 'processing' }));
  const countDataRightsRowsForConsultations = jest.fn(async () => ({ payments: 0, refunds: 0, paymentEvents: 0 }));
  const quote = jest.fn(async () => ({ totalPayable: '500.00' }) as unknown as PaymentBreakdown);
  const createOrderForConsultation = jest.fn(async () => ({
    paymentId: PAYMENT_ID,
    gatewayOrderId: 'order_1',
    gatewayKeyId: 'rzp_test_key',
    breakdown: { totalPayable: '500.00' },
  }));
  const payments = { quote, createOrderForConsultation } as unknown as PaymentService;
  const refunds = { createRefund, countDataRightsRowsForConsultations } as unknown as RefundService;
  return {
    facade: new PaymentFacade(payments, refunds),
    createRefund,
    quote,
    createOrderForConsultation,
    countDataRightsRowsForConsultations,
  };
}

describe('PaymentFacade.quote — the options argument crosses the seam', () => {
  /**
   * *** THE BUG THIS SUITE WAS WRITTEN TO CATCH. ***
   *
   * `PaymentFacade.quote` used to declare only `(consultationFeeInr: string)`
   * and call `this.payments.quote(consultationFeeInr)` — ONE argument, always.
   * That compiled clean against `PaymentContract`'s `quote(fee, options?)`,
   * because a narrower function is assignable to a wider one — so
   * `implements PaymentContract` caught nothing, and every caller's
   * `discountCode`/`patientId`/`doctorId`/`specialtyId`/`mode` was silently
   * DROPPED at this exact seam regardless of what `PaymentService#quote`
   * itself supports. `booking.service.ts#quoteForDoctor` calls this method —
   * through `BOOKING_PAYMENT_PORT`, bound to this facade — so a discount code
   * typed into the pre-booking quote screen never reached pricing at all.
   */
  it('forwards options to PaymentService#quote, not just the fee', async () => {
    const { facade, quote } = harness();

    await facade.quote('500.00', {
      discountCode: 'SAVE20',
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      specialtyId: SPECIALTY_ID,
      mode: 'scheduled',
      materialise: false,
    });

    expect(quote).toHaveBeenCalledWith(
      '500.00',
      expect.objectContaining({
        discountCode: 'SAVE20',
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        specialtyId: SPECIALTY_ID,
        mode: 'scheduled',
        materialise: false,
      }),
    );
  });

  /** The same call through the CONTRACT type, which is what booking holds. */
  it('forwards options through PaymentContract, not just through the class', async () => {
    const { facade, quote } = harness();
    const contract: PaymentContract = facade;

    await contract.quote('500.00', { discountCode: 'SAVE20', patientId: PATIENT_ID });

    expect(quote).toHaveBeenCalledWith('500.00', expect.objectContaining({ discountCode: 'SAVE20', patientId: PATIENT_ID }));
  });

  /** Omitting options stays legal — a one-argument caller must keep compiling and working. */
  it('still accepts a call with no options at all', async () => {
    const { facade, quote } = harness();
    await facade.quote('500.00');
    expect(quote).toHaveBeenCalledWith('500.00', undefined);
  });
});

describe('PaymentFacade.createOrderForConsultation — the discount fields cross the seam', () => {
  it('forwards discountCode, patientId, doctorId, specialtyId and mode to PaymentService', async () => {
    const { facade, createOrderForConsultation } = harness();

    await facade.createOrderForConsultation({
      consultationId: CONSULTATION_ID,
      consultationFeeInr: '500.00',
      discountCode: 'SAVE20',
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      specialtyId: SPECIALTY_ID,
      mode: 'scheduled',
    });

    expect(createOrderForConsultation).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCode: 'SAVE20',
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        specialtyId: SPECIALTY_ID,
        mode: 'scheduled',
      }),
    );
  });
});

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

describe('PaymentFacade.countDataRightsRowsForConsultations', () => {
  it('delegates to RefundService, which reads across payments/refunds/payment_events', async () => {
    const { facade, countDataRightsRowsForConsultations } = harness();
    countDataRightsRowsForConsultations.mockResolvedValueOnce({ payments: 2, refunds: 1, paymentEvents: 4 });

    await expect(facade.countDataRightsRowsForConsultations([CONSULTATION_ID])).resolves.toEqual({
      payments: 2,
      refunds: 1,
      paymentEvents: 4,
    });
    expect(countDataRightsRowsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
  });
});
