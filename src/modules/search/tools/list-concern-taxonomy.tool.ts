import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CATALOGUE_TOOL_PORT, TOOL_NAMES } from './search-tool.constants';
import type { AgentTool, CatalogueToolPort } from './search-tool.contract';

const inputSchema = z.object({
  specialtyId: z.string().uuid().optional().describe('Optional. Return only the concerns that sit under this specialty. Get the id from list_service_catalogue.'),
});

export type ListConcernTaxonomyInput = z.infer<typeof inputSchema>;

/**
 * NOTE the fields that are NOT here: `matchPhrases` and `matchWeight`.
 * See `ListConcernTaxonomyTool`'s class comment — this omission is the
 * point of the type.
 */
export interface ConcernTaxonomyEntry {
  id: string;
  specialtyId: string;
  code: string;
  name: string;
}

export interface ListConcernTaxonomyOutput {
  concerns: ConcernTaxonomyEntry[];
}

/**
 * Lists the concern taxonomy — the curated vocabulary of things patients come
 * to this platform for, grouped under the specialty that treats them.
 *
 * WHY `matchPhrases` IS DELIBERATELY WITHHELD
 * -------------------------------------------
 * `concerns.match_phrases` is the hand-curated synonym corpus — the English,
 * Hindi and code-mixed trigger phrases that map a patient's own words onto a
 * concern, and from there onto a professional type. It is internal ROUTING
 * data, not catalogue content.
 *
 * SRS §7 requires that mapping layer stay authoritative: symptom-to-specialty
 * routing is a clinical-governance decision, edited under
 * `search.manage_mapping` and auditable, precisely so that who a patient gets
 * sent to is a decision the platform owns and can defend. Handing the corpus
 * to an external agent would let it re-derive our mapping locally and route
 * on its own copy — which then drifts silently the moment clinical governance
 * edits a phrase, and moves the routing decision outside the audited layer
 * altogether. An external agent must call `discover_care` and get OUR answer,
 * not reimplement it from our synonym list.
 *
 * `matchWeight` is withheld for the same reason: it is the tie-breaker
 * *inside* that ranking, and publishing it publishes the ranking.
 *
 * So this tool returns names and codes ONLY — enough for an agent to say
 * "we cover sleep, anxiety and low mood", never enough to rebuild the router.
 */
@Injectable()
export class ListConcernTaxonomyTool implements AgentTool<ListConcernTaxonomyInput, ListConcernTaxonomyOutput> {
  readonly name = TOOL_NAMES.LIST_CONCERN_TAXONOMY;

  readonly description =
    'List the concerns this platform treats — the named problem areas (for example sleep, anxiety, low mood) grouped under the professional type that handles each. Optionally filter to a single specialty. ' +
    'Use this to tell a patient what kinds of difficulty are covered, or to check whether something they mentioned is a concern the platform handles. ' +
    'Returns concern names and codes only. It does NOT return the phrase list used to match a patient description to a concern, so do not attempt to do that matching yourself — call discover_care and use the concerns it returns.';

  readonly inputSchema = inputSchema;

  constructor(@Inject(CATALOGUE_TOOL_PORT) private readonly catalogue: CatalogueToolPort) {}

  async execute(input: ListConcernTaxonomyInput): Promise<ListConcernTaxonomyOutput> {
    const all = await this.catalogue.listActiveConcerns();
    const scoped = input.specialtyId === undefined ? all : all.filter((concern) => concern.specialtyId === input.specialtyId);

    // Field-by-field projection, never a spread. A spread would silently
    // start leaking `matchPhrases` again the day `PublicConcern` grows a
    // field, which is exactly the failure this tool exists to prevent —
    // `list-concern-taxonomy.tool.spec.ts` asserts the absence directly.
    return {
      concerns: scoped.map((concern) => ({
        id: concern.id,
        specialtyId: concern.specialtyId,
        code: concern.code,
        name: concern.name,
      })),
    };
  }
}
