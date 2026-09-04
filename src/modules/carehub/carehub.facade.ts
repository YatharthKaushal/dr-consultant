import { Injectable } from '@nestjs/common';
import type { CareHubContract, RecommendedContentItem } from './carehub.contract';
import { CarehubService } from './carehub.service';

/**
 * M-18's single public surface (`backend/README.md` §2).
 *
 * *** THIS IS WHAT THE COORDINATOR REBINDS `CARE_HUB_PORT` TO. *** See
 * `carehub.contract.ts`'s doc comment on `RecommendedContentItem` for the
 * full seam: `followup-care-hub.contract.ts` declares `CareHubPort` locally
 * and cannot see this file, so this class satisfies it STRUCTURALLY —
 * `{ provide: CARE_HUB_PORT, useExisting: CareHubFacade }`, one line, in
 * `followup.module.ts`, post-merge. This module does not touch that file.
 */
@Injectable()
export class CareHubFacade implements CareHubContract {
  constructor(private readonly carehub: CarehubService) {}

  /** See `CareHubContract#getRecommendedForConsultation`. No ownership check — the caller authorizes. */
  async getRecommendedForConsultation(consultationId: string): Promise<RecommendedContentItem[]> {
    return this.carehub.getRecommendedForConsultation(consultationId);
  }

  /** *** M-21 CALLS THIS. *** See `CareHubContract#countRecommendationsForConsultations` — a pure, read-only count, nothing here is anonymized or deleted. */
  async countRecommendationsForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.carehub.countRecommendationsForConsultations(consultationIds);
  }
}
