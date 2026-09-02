import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TOOL_ERROR_CODES } from './search-tool.constants';
import type { DiscoveryPort, DiscoveryResult } from './search-tool.contract';

/**
 * PLACEHOLDER binding for `DISCOVERY_PORT`, so this module compiles, boots
 * and tests green while the AI symptom-discovery pipeline is built in a
 * different worktree (`modules/search`, M-09).
 *
 * It refuses every call with a clean, documented error rather than returning
 * a plausible-looking empty result. That distinction matters here more than
 * usual: `discover_care` is the tool an agent reaches for when a patient has
 * just described a health problem in their own words, and a silent
 * "no matches" would be indistinguishable, to the agent, from a genuine
 * "nothing fits your symptoms" — which is exactly the wrong thing to tell
 * someone who may be describing a crisis.
 *
 * POST-MERGE the coordinator swaps this one binding in
 * `search-tool.module.ts` for the pipeline's own `DiscoveryPort`
 * implementation. Same swap `availability.module.ts` has queued for
 * `BUSY_INTERVAL_PROVIDER` once M-11 lands.
 */
@Injectable()
export class UnavailableDiscoveryProvider implements DiscoveryPort {
  async discover(_input: { text: string; source: 'mcp'; locale?: string }): Promise<DiscoveryResult> {
    throw new ServiceUnavailableException({
      code: TOOL_ERROR_CODES.DISCOVERY_UNAVAILABLE,
      message: 'Symptom discovery is not available in this deployment. Use list_service_catalogue to browse professional types instead.',
    });
  }
}
