import { Injectable, Logger } from '@nestjs/common';
import type { ConsultationLookupStatus, PromotionBookingLookupPort } from './promotion-booking.contract';

/**
 * The null object bound to `PROMOTION_BOOKING_LOOKUP_PORT` until the coordinator
 * rebinds it to an adapter over `BookingFacade` — the direct counterpart of
 * `booking`'s `UnavailableBookingPaymentProvider` (for `BOOKING_PAYMENT_PORT`),
 * `document`'s `UnavailableDocumentStorageProvider` and `search`'s
 * `SearchAiNullProvider`.
 *
 * *** IT REPORTS `unknown`. IT NEVER THROWS. *** Unlike its counterparts, which
 * throw a 503 that every call site rewraps. The reasoning is in
 * `promotion-booking.contract.ts` and it is worth repeating at the
 * implementation: the consumer is a SWEEP that decides whether to release
 * money-adjacent state on a timer, and `unknown` MEANS KEEP. An unbound port
 * therefore cannot leak a redemption — the worst it can do is leave reservations
 * held until a human or the rebind clears them, which is visible and reversible.
 *
 * It stays in the tree AFTER the rebind, unbound: it is the null object this
 * module was built and tested against, and rebinding it here is the hard
 * kill-switch that takes booking out of the promotion sweep at the DI level.
 *
 * The log line is `debug`, not `warn`: pre-merge this is the EXPECTED binding and
 * the sweep runs once a minute, so `warn` would fill the log with a message
 * nobody can act on. Post-merge, seeing it at all means the rebind was missed —
 * which is why it names the token.
 */
@Injectable()
export class UnavailablePromotionBookingLookupProvider implements PromotionBookingLookupPort {
  private readonly logger = new Logger(UnavailablePromotionBookingLookupProvider.name);

  async getConsultationStatus(consultationId: string): Promise<ConsultationLookupStatus> {
    this.report(`status of consultation ${consultationId}`);
    return 'unknown';
  }

  async getConsultationStatuses(
    consultationIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConsultationLookupStatus>> {
    this.report(`statuses of ${consultationIds.length} consultation(s)`);
    // An empty map, not a map of `'unknown'`s: the contract says an absent id
    // and an `'unknown'` id mean the same thing, and returning nothing makes a
    // caller that forgot to handle absence fail in tests rather than in
    // production.
    return new Map();
  }

  async countPriorConsultations(
    patientId: string,
    _excludeConsultationId: string | null,
  ): Promise<number | 'unknown'> {
    this.report(`prior consultation count for patient ${patientId}`);
    return 'unknown';
  }

  private report(what: string): void {
    this.logger.debug(
      `PROMOTION_BOOKING_LOOKUP_PORT is not bound, so ${what} is unknown. ` +
        'Reservations are KEPT and the first-consultation rule is SKIPPED — see promotion-booking.contract.ts.',
    );
  }
}
