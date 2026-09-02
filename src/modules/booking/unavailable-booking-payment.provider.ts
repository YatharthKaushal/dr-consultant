import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { BookingPaymentPort, CreatedOrder, PaymentBreakdown } from './booking-payment.contract';

/**
 * The null object bound to `BOOKING_PAYMENT_PORT` until `modules/payment`
 * (M-12) is merged — the direct counterpart of `document`'s
 * `UnavailableDocumentStorageProvider` (for `DOCUMENT_STORAGE_PORT`) and
 * `search`'s `SearchAiNullProvider` (for `SEARCH_AI_PORT`).
 *
 * Every method throws `PAYMENT_PORT_UNAVAILABLE` as a 503. NO CALL SITE IN
 * THIS MODULE EVER LETS THAT REACH A CLIENT: each one catches ANY throw from
 * this port and rewraps it as booking's own `PAYMENT_SETUP_FAILED` /
 * `PAYMENT_RECONCILE_FAILED` handling with a patient-facing message — never
 * this code, never this message, never a raw gateway error. That rewrap is
 * exercised in the unit tests and in live E2E from day one, rather than being
 * a branch nobody runs until a real outage.
 *
 * It stays in the tree AFTER the merge, unbound: it is the null object this
 * module was built and tested against, and rebinding it here is the hard
 * kill-switch that takes payment out of the booking path at the DI level.
 */
@Injectable()
export class UnavailableBookingPaymentProvider implements BookingPaymentPort {
  async quote(_consultationFeeInr: string): Promise<PaymentBreakdown> {
    throw this.unavailable();
  }

  async createOrderForConsultation(_input: { consultationId: string; consultationFeeInr: string }): Promise<CreatedOrder> {
    throw this.unavailable();
  }

  async getByConsultationId(_consultationId: string): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null> {
    throw this.unavailable();
  }

  async reconcileWithGateway(_paymentId: string): Promise<{ status: string; changed: boolean }> {
    throw this.unavailable();
  }

  async createRefund(_input: {
    paymentId: string;
    amount: string;
    reason: string;
    initiatedByAdminId: string | null;
    isAutomatic: boolean;
  }): Promise<{ refundId: string; status: string }> {
    throw this.unavailable();
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PAYMENT_PORT_UNAVAILABLE',
      message: 'No payment provider is configured.',
    });
  }
}
