import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PAYMENT_CAPTURED_EVENT, type PaymentCapturedEvent } from '../payment/payment.contract';
import { BookingSlotHoldService } from './booking-slot-hold.service';

/**
 * *** CLOSES THE PAID -> SCHEDULED LOOP. ***
 *
 * M-12 captures a payment and announces it; this takes the consultation live
 * immediately, instead of leaving the patient on a `pending_payment` screen
 * until the hold lapses and the sweep gets to it.
 *
 * ── Why a listener and not a call from the payment module ─────────────────
 *
 * The compile-time dependency runs booking -> payment: `booking.module.ts`
 * imports `PaymentFacade` and binds it at `BOOKING_PAYMENT_PORT`. Having
 * payment call `BookingFacade.confirmPayment` directly would close that into a
 * module cycle. Listening here inverts the RUNTIME direction while leaving the
 * COMPILE-TIME direction untouched — payment still knows nothing about booking,
 * and this file imports from payment's public surface (`payment.contract.ts`),
 * which is the direction this module already depends in. `EventsModule` is
 * `@Global()`, so no import is needed to receive the event.
 *
 * ── This is a fast path, not the guarantee ────────────────────────────────
 *
 * Losing an event costs LATENCY, NOT CORRECTNESS, and that is by design. The
 * durable guarantee lives in `BookingSlotHoldService`'s two-tier sweep: every
 * expired hold that has a gateway order is reconciled against Razorpay, and one
 * that comes back paid is confirmed there. So a dropped event, a crashed
 * process, or a listener that throws all degrade to "the booking goes live up
 * to `booking.slot_hold_minutes` later" — never to a paid consultation that
 * stays `pending_payment` forever.
 *
 * That is also why this swallows its errors (see below) rather than retrying:
 * something else is already responsible for eventually getting this right.
 */
@Injectable()
export class BookingPaymentListener {
  private readonly logger = new Logger(BookingPaymentListener.name);

  constructor(private readonly holds: BookingSlotHoldService) {}

  /**
   * `confirmPayment` is idempotent and takes `SELECT ... FOR UPDATE` on the
   * consultation, so racing the sweep — or a redelivered webhook — is safe: one
   * caller performs the transition and the other observes `scheduled` and
   * no-ops. A hold that has already been released lands in `confirmLateCapture`
   * underneath, which re-acquires the slot or queues it for an admin with the
   * money held. Neither outcome is decided here.
   *
   * NOTHING IS RETHROWN. `@nestjs/event-emitter` would catch and log it anyway
   * (`suppressErrors` defaults to true), but catching it here is what lets the
   * log name the consultation that failed — the framework's own message would
   * not, and "a payment was captured but its booking is still
   * `pending_payment`" is precisely the situation an operator needs to be able
   * to find. The sweep will retry it regardless.
   */
  @OnEvent(PAYMENT_CAPTURED_EVENT)
  async onPaymentCaptured(event: PaymentCapturedEvent): Promise<void> {
    try {
      await this.holds.confirmPayment(event.consultationId);
      this.logger.log(`Consultation ${event.consultationId} confirmed from captured payment ${event.paymentId}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not confirm consultation ${event.consultationId} after payment ${event.paymentId} ` +
          `(gateway payment ${event.gatewayPaymentId}) was captured; the expiry sweep will retry it. ${message}`,
      );
    }
  }
}
