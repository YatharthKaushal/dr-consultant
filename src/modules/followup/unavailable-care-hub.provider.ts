import { Injectable, Logger } from '@nestjs/common';
import type { CareHubPort, RecommendedCareHubItem } from './followup-care-hub.contract';

/**
 * The null object bound to `CARE_HUB_PORT` until `modules/carehub` (M-18) is
 * merged — the direct counterpart of `pricing`'s `UnavailableDiscountProvider`
 * for `DISCOUNT_PORT`.
 *
 * Returns an empty array, never throws: a Care Plan with no recommended
 * self-help is still a complete Care Plan (FR-14.1 lists it as one of five
 * sections, and `docs/MODULES.md`'s M-16 note is explicit that this section
 * "appears once M-18 is built"). Recommending nothing is correct, not
 * degraded, until then.
 */
@Injectable()
export class UnavailableCareHubProvider implements CareHubPort {
  private readonly logger = new Logger(UnavailableCareHubProvider.name);

  async getRecommendedForConsultation(consultationId: string): Promise<RecommendedCareHubItem[]> {
    this.logger.debug(`No Care Hub provider configured (M-18 not yet built); recommending nothing for ${consultationId}.`);
    return [];
  }
}
