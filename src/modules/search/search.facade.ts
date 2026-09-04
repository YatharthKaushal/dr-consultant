import { Injectable } from '@nestjs/common';
import type { DiscoveryRequest, DiscoveryResponse, SearchContract } from './search.contract';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

@Injectable()
export class SearchFacade implements SearchContract {
  constructor(
    private readonly search: SearchService,
    private readonly repo: SearchRepository,
  ) {}

  /**
   * The whole six-stage pipeline, crisis gate included. Takes `patientId`
   * and `source` explicitly rather than reading an auth context, because its
   * named consumer is the MCP tool surface (a separate worktree, under
   * `modules/search/tools/`), which has no authenticated patient and passes
   * `{ patientId: null, source: 'mcp' }`.
   */
  async discover(request: DiscoveryRequest): Promise<DiscoveryResponse> {
    return this.search.discover(request);
  }

  /** The crisis guardrail alone, over the same admin-edited keyword list — for M-16/M-17/M-18, per `docs/MODULES.md` §7's safety-override rule. */
  async screenForCrisis(text: string): Promise<{ fired: boolean }> {
    return this.search.screenForCrisis(text);
  }

  /**
   * ADDITIVE (M-21/data rights execution). Thin delegation to
   * `SearchRepository.countDataRightsRows` — see `SearchContract`'s doc
   * comment. Read-only.
   */
  async countDataRightsRowsForPatient(patientId: string): Promise<{ searchQueries: number; searchRateLimits: number }> {
    return this.repo.countDataRightsRows(patientId);
  }

  /**
   * ADDITIVE (M-21/data rights execution). Thin delegation to
   * `SearchRepository.deleteAllForPatient` — see `SearchContract`'s doc
   * comment for why `search_queries` (and only `search_queries`) is
   * hard-deleted here.
   */
  async deleteSearchQueriesForPatient(patientId: string): Promise<{ deletedCount: number }> {
    return this.repo.deleteAllForPatient(patientId);
  }
}
