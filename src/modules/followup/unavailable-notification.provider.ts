import { Injectable, Logger } from '@nestjs/common';
import type {
  FollowupNotificationPort,
  FollowupNotificationRequest,
  FollowupNotificationResult,
} from './followup-notification.contract';

/**
 * The null object for `FOLLOWUP_NOTIFICATION_PORT`. NOT bound by
 * `followup.module.ts` today — `NotificationFacade` is real and bound
 * directly — but kept in the tree as the hard kill-switch every notification-
 * consuming module in this codebase keeps (`instant`'s
 * `UnavailableNotificationProvider`, `pricing`'s `UnavailableDiscountProvider`):
 * rebinding this token here at the DI level is how an operator takes push out
 * of the follow-up path without a code change anywhere else.
 *
 * Never throws, matching every real and null notification provider in this
 * codebase: a red-flag alert that could not be PUSHED is still a red-flag
 * alert — the `safety_alerts` row is the durable, authoritative record, and a
 * failed push must never fail (or roll back) the write that created it.
 */
@Injectable()
export class UnavailableFollowupNotificationProvider implements FollowupNotificationPort {
  private readonly logger = new Logger(UnavailableFollowupNotificationProvider.name);

  async notify(request: FollowupNotificationRequest): Promise<FollowupNotificationResult> {
    this.logger.debug(
      `No notification provider configured; dropping "${request.templateCode}" for ${request.audience.kind} ${request.audience.id}.`,
    );
    return { queued: false, notificationId: null, reason: 'provider_unavailable' };
  }
}
