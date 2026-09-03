import { Injectable, Logger } from '@nestjs/common';
import type {
  DiscountEvaluation,
  DiscountOrderContext,
  DiscountPort,
  DiscountReservation,
  DiscountReservationResult,
} from './pricing-discount.contract';

/**
 * The null object bound to `DISCOUNT_PORT` until `modules/promotion` is merged —
 * the direct counterpart of `booking`'s `UnavailableBookingPaymentProvider` (for
 * `BOOKING_PAYMENT_PORT`), `document`'s `UnavailableDocumentStorageProvider` and
 * `search`'s `SearchAiNullProvider`.
 *
 * *** IT DOES NOT THROW, AND THAT ASYMMETRY WITH
 * `UnavailableBookingPaymentProvider` IS DELIBERATE. ***
 *
 * That provider throws `PAYMENT_PORT_UNAVAILABLE` as a 503 on every call,
 * because payment is LOAD-BEARING for checkout: a booking that cannot take money
 * is not a booking, and failing loudly is the only honest answer.
 *
 * Discounts are not load-bearing. A missing promotions module means "no coupon
 * is available", never "checkout is down". If this threw, every quote would fail
 * the moment a patient typed a code — and worse, `createQuote` calls `reserve`
 * on the normal path, so an absent promotions module would take the entire
 * checkout offline for patients who never used a coupon at all.
 *
 * So `preview` and `reserve` REFUSE (`applicable: false`, reason `UNAVAILABLE`),
 * which is a first-class outcome the caller already handles for a dozen other
 * reasons, and `confirm`/`release`/`getForConsultation` return `null` — "there
 * was no reservation", which is true.
 *
 * It stays in the tree AFTER the merge, unbound: it is the null object this
 * module was built and tested against, and rebinding it here is the hard
 * kill-switch that takes promotions out of the pricing path at the DI level
 * without a code change anywhere else.
 */
@Injectable()
export class UnavailableDiscountProvider implements DiscountPort {
  private readonly logger = new Logger(UnavailableDiscountProvider.name);

  async preview(code: string, _context: DiscountOrderContext): Promise<DiscountEvaluation> {
    this.logger.debug(`No promotions provider is configured; refusing code ${code}.`);
    return this.unavailable();
  }

  async reserve(input: { code: string; consultationId: string }): Promise<DiscountReservationResult> {
    this.logger.debug(
      `No promotions provider is configured; not reserving ${input.code} for consultation ${input.consultationId}.`,
    );
    return { reserved: false, ...this.unavailable() };
  }

  /** No reservation was ever taken, so there is nothing to consume. `null` says exactly that. */
  async confirm(_input: { consultationId: string; paymentId: string }): Promise<null> {
    return null;
  }

  /** Likewise: releasing nothing is a no-op, not a failure. The stale-draft sweep depends on this being quiet. */
  async release(_input: { consultationId: string; reason: string }): Promise<null> {
    return null;
  }

  async getForConsultation(_consultationId: string): Promise<DiscountReservation | null> {
    return null;
  }

  private unavailable(): { applicable: false; reason: 'UNAVAILABLE'; message: string } {
    return {
      applicable: false,
      reason: 'UNAVAILABLE',
      message: 'Discount codes are not available at the moment.',
    };
  }
}
