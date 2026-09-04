import { Injectable, Logger } from '@nestjs/common';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '../../schema/enums.schema';
import type { GovernanceComplaintsPort } from './governance-complaints.contract';

/**
 * The null object bound to `GOVERNANCE_COMPLAINTS_PORT` until `modules/
 * feedback` (M-19) is merged — the direct counterpart of `pricing`'s
 * `UnavailableDiscountProvider` (for `DISCOUNT_PORT`) and `followup`'s
 * `UnavailableCareHubProvider`/`UnavailableAdminDirectoryProvider`.
 *
 * Every key of `COMPLAINT_STATUSES` at `0`, built from that const rather than
 * hand-rolled — the module task brief for this build is explicit that this
 * must "import the const" instead of re-typing the four status strings, so a
 * future status addition to `complaint_status` cannot leave this null object
 * silently missing a key.
 *
 * `0`, never a throw: a missing complaints module means "no complaint data is
 * available yet," not "the quality dashboard is down." Every OTHER number on
 * the dashboard (completed cases, pending summaries, red flags, follow-up
 * alerts, doctor reliability) is this module's own composition across
 * already-merged facades and must render regardless of whether M-19 exists
 * yet — the same reasoning `UnavailableDiscountProvider`'s header gives for
 * why a missing promotions module refuses a coupon rather than fails checkout.
 *
 * It stays in the tree AFTER the merge, unbound: it is the null object this
 * module was built and tested against, and rebinding
 * `GOVERNANCE_COMPLAINTS_PORT` to the real facade in `governance.module.ts`
 * is the one-line handover every other port in this codebase gets.
 */
@Injectable()
export class UnavailableComplaintsProvider implements GovernanceComplaintsPort {
  private readonly logger = new Logger(UnavailableComplaintsProvider.name);

  async countComplaintsByStatus(): Promise<Record<ComplaintStatus, number>> {
    this.logger.debug('No complaints provider is configured; reporting zero complaints for every status.');
    return Object.fromEntries(COMPLAINT_STATUSES.map((status) => [status, 0])) as Record<ComplaintStatus, number>;
  }
}
