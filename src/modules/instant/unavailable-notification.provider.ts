import { Injectable, Logger } from '@nestjs/common';
import type { NotificationPort, NotificationRequest, NotificationResult } from './instant-notification.contract';

/**
 * The null object bound to `NOTIFICATION_PORT` until `modules/notification`
 * (M-08) is merged — the direct counterpart of `booking`'s
 * `UnavailableBookingPaymentProvider` (for `BOOKING_PAYMENT_PORT`),
 * `document`'s `UnavailableDocumentStorageProvider` (for
 * `DOCUMENT_STORAGE_PORT`) and `search`'s `SearchAiNullProvider` (for
 * `SEARCH_AI_PORT`).
 *
 * *** UNLIKE EVERY ONE OF THOSE, THIS ONE DOES NOT THROW. ***
 *
 * That is the whole design of the port, not a shortcut. A booking with no
 * payment is not a booking, so the payment null object throws a 503 and every
 * call site rewraps it. An instant consult with no PUSH notification is still
 * an instant consult: SSE (`instant-presence.controller.ts`) is the primary
 * channel for a doctor with the app open — which is exactly the population
 * "Available Now" describes — and push is the fallback for a backgrounded app.
 *
 * So M-13 is fully functional against this provider. Every call site treats
 * `notify` as fire-and-forget and ignores the result; nothing in the routing,
 * acceptance, timeout or completion-gate paths branches on it. The
 * `provider_unavailable` reason exists so an operator reading a log can tell
 * "M-08 is not wired up yet" from "that doctor has no device token".
 *
 * It stays in the tree AFTER the merge, unbound: it is the null object this
 * module was built and tested against, and rebinding it here is the hard
 * kill-switch that takes push notifications out of the instant path at the DI
 * level.
 */
@Injectable()
export class UnavailableNotificationProvider implements NotificationPort {
  private readonly logger = new Logger(UnavailableNotificationProvider.name);

  async notify(request: NotificationRequest): Promise<NotificationResult> {
    // `debug`, not `warn`: until M-08 is merged this fires on every single
    // routing attempt, and a warning that is always true is a warning nobody
    // reads.
    this.logger.debug(
      `No notification provider configured; dropping "${request.templateCode}" for ${request.audience.kind} ${request.audience.id}.`,
    );
    return { queued: false, notificationId: null, reason: 'provider_unavailable' };
  }
}
