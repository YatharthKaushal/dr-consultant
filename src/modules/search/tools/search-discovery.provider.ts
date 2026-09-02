import { Injectable } from '@nestjs/common';
import { SearchFacade } from '../search.facade';
import type { DiscoveryPort, DiscoveryResult } from './search-tool.contract';

/**
 * Binds `DISCOVERY_PORT` to the real M-09 pipeline (`SearchFacade.discover`),
 * replacing `UnavailableDiscoveryProvider`.
 *
 * The two sides were designed independently and their shapes differ on
 * purpose, so this adapter is a narrowing, not a rename:
 *
 *   - `DiscoveryResponse` (M-09) is the PATIENT-APP payload — a superset
 *     sized so three unsettled Figma concepts can all render from it
 *     (guidance prose with substitution tokens, browse suggestions, popular
 *     searches, per-doctor reasons, ranking scores, meta about which
 *     interpretation path ran).
 *   - `DiscoveryResult` (this module) is the AGENT payload: ids and a plain
 *     reason. An external client resolves ids to names through
 *     `list_service_catalogue`/`list_concern_taxonomy`, which are the tools
 *     that already exist for exactly that.
 *
 * Deliberately NOT forwarded: `guidance.text` (it carries `{{specialty:...}}`
 * substitution tokens meaningful only to our own frontend), `score` (a
 * ranking number, not a clinical measure, and nothing outside our ranker
 * should reason about it), and `suggestions` (browse chips for a screen).
 *
 * CRISIS (SRS FR-5.6 / §6.3): the crisis branch returns guidance and nothing
 * else. `DiscoveryResult`'s crisis variant has no concern/specialty fields at
 * all, so this narrowing makes it structurally impossible to carry routing
 * data out of a crisis — the mapping cannot leak what the type cannot hold.
 */
@Injectable()
export class SearchDiscoveryProvider implements DiscoveryPort {
  constructor(private readonly search: SearchFacade) {}

  async discover(input: { text: string; source: 'mcp'; locale?: string }): Promise<DiscoveryResult> {
    const response = await this.search.discover({
      // No authenticated patient on this surface: an MCP caller is a machine,
      // so the query is logged unattributed and never joins anyone's recent
      // searches (see `search_queries.patient_id`, nullable for this reason).
      patientId: null,
      source: input.source,
      queryText: input.text,
    });

    if (response.crisis) {
      return {
        outcome: 'crisis',
        guidance: {
          message: response.crisis.message,
          helplines: response.crisis.helplines,
        },
      };
    }

    return {
      outcome: 'routed',
      interpretedConcernIds: response.matchedConcerns.map((concern) => concern.id),
      recommendedSpecialtyIds: response.matchedSpecialties.map((specialty) => specialty.id),
      matchReason: buildMatchReason(response.matchedConcerns.map((concern) => concern.name)),
    };
  }
}

/**
 * FR-5.4's "matched to: sleep, anxiety", built from CURATED concern names —
 * never from model prose, which is why this is assembled here rather than
 * forwarding `guidance.text`. `undefined` (not an empty string) when nothing
 * matched, so the field is simply absent rather than an empty claim.
 */
function buildMatchReason(concernNames: readonly string[]): string | undefined {
  if (concernNames.length === 0) return undefined;
  return `Matched to: ${concernNames.join(', ')}`;
}
