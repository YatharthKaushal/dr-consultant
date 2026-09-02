import { Injectable } from '@nestjs/common';
import type { DiscoveryRequest, DiscoveryResponse, SearchContract } from './search.contract';
import { SearchService } from './search.service';

@Injectable()
export class SearchFacade implements SearchContract {
  constructor(private readonly search: SearchService) {}

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
}
