import { Injectable } from '@nestjs/common';
import { NotificationService } from './notification.service';
import type { NotificationContract, NotificationRequest, NotificationResult } from './notification.contract';

/**
 * M-08's only public surface. Thin by design — every decision (template
 * resolution, FR-16.2 screening, the delivery record, which Firebase app to
 * send through) lives in `NotificationService`, and this class exists to be
 * the one type another module imports, so swapping the local implementation
 * for a TCP client later changes nothing at any call site
 * (`backend/README.md` §1). Mirrors `StorageFacade`, `AiFacade` and
 * `PaymentFacade`.
 *
 * *** M-13 (presence and instant consult) IS BEING BUILT AGAINST A LOCAL
 * MIRROR OF `NotificationContract` IN A PARALLEL WORKTREE, AND BINDS THIS
 * CLASS TO ITS OWN `NOTIFICATION_PORT` TOKEN. *** `implements
 * NotificationContract` is what makes that safe: because the mirror is
 * structurally identical, a signature drift on either side surfaces at M-13's
 * `useExisting` binding as a `tsc` error rather than as a runtime surprise
 * after both merge. The same arrangement `PaymentFacade`/M-11 and
 * `AiFacade`/`SEARCH_AI_PORT` already run on.
 *
 * Only `notify` is on the contract. The in-app inbox and device registration
 * are HTTP surfaces for the apps themselves, not something another MODULE
 * calls, so they stay on `NotificationService` behind the controllers and out
 * of every other module's reach.
 */
@Injectable()
export class NotificationFacade implements NotificationContract {
  constructor(private readonly notifications: NotificationService) {}

  /** Best-effort, and never throws — see `NotificationService.notify`. */
  async notify(request: NotificationRequest): Promise<NotificationResult> {
    return this.notifications.notify(request);
  }
}
