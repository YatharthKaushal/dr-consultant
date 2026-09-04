import { Injectable } from '@nestjs/common';
import type { ClarificationCaseSummaryView, ClarificationContract } from './clarification.contract';
import { ClarificationService } from './clarification.service';

/**
 * M-17's single public surface (`backend/README.md` §2).
 *
 * See `clarification.contract.ts` for the full argument. Short version: the
 * one NAMED future consumer (M-20, unbuilt) needs a governance-shaped
 * summary, never case content and never `sourceConsultationId` — so that is
 * all this facade exposes. Posting a case, assigning an expert and every
 * message exchange are this module's own acts, reached through
 * `clarification.controller.ts`/`clarification-admin.controller.ts` with the
 * caller's own credentials; there is no facade method that lets another
 * module act on a doctor's or admin's behalf.
 */
@Injectable()
export class ClarificationFacade implements ClarificationContract {
  constructor(private readonly clarification: ClarificationService) {}

  /** See `ClarificationContract#getCaseSummary`. No ownership check — the caller (a trusted module-to-module read) authorizes. */
  async getCaseSummary(caseId: string): Promise<ClarificationCaseSummaryView | null> {
    return this.clarification.getCaseSummary(caseId);
  }

  /** *** M-21 CALLS THIS. *** See `ClarificationContract#countCasesForConsultations` — a pure, read-only count, nothing here is anonymized or deleted. */
  async countCasesForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.clarification.countCasesForConsultations(consultationIds);
  }
}
