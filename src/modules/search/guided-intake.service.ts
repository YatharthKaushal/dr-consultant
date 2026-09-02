import { Injectable } from '@nestjs/common';
import type { SearchSource } from '../../schema/enums.schema';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicConcern } from '../catalogue/catalogue.contract';
import { SearchService } from './search.service';
import type { DiscoveryResponse } from './search.contract';

/** Coarse age bands. Deliberately bands, not an age: the guide asks who this is for, not for a date of birth it has no reason to hold. */
export const GUIDED_AGE_BANDS = ['child', 'teen', 'adult', 'senior'] as const;
export type GuidedAgeBand = (typeof GUIDED_AGE_BANDS)[number];

/** What kind of help the patient thinks they want. A PREFERENCE, never a clinical filter — see the note in this file's doc comment. */
export const GUIDED_SUPPORT_PREFERENCES = ['talking', 'medical', 'not_sure'] as const;
export type GuidedSupportPreference = (typeof GUIDED_SUPPORT_PREFERENCES)[number];

export interface GuidedIntakeFacets {
  /** Concern ids the patient tapped. */
  concernIds?: readonly string[];
  forSelf: boolean;
  ageBand?: GuidedAgeBand;
  supportPreference?: GuidedSupportPreference;
  /** FR-4.4 filters, identical to the free-text path's. */
  languages?: readonly string[];
  maxFeeInr?: string;
  availableWithinDays?: number;
  limit?: number;
}

/**
 * FR-5.5: "An optional concern guide handles the 'unsure whom to consult'
 * flow USING THE SAME ENGINE. It is never forced before booking."
 *
 * That phrase is honoured literally here. This service does NOT score, rank,
 * map or filter anything. It synthesises the patient's taps into a query
 * string plus a set of preselected concern ids, and hands both to
 * `SearchService.discover` — the identical six-stage pipeline the free-text
 * search runs, including the crisis gate and the AI/deterministic branch.
 * There is no parallel scoring path to drift out of step, and the response
 * is byte-for-byte the same SHAPE as a free-text discovery, which is what
 * lets one UI render both.
 *
 * ---------------------------------------------------------------------------
 * HOW EACH FACET REACHES THE ENGINE — all of it through existing inputs:
 *
 *   concernIds        become `preselectedConcernIds`, which the matcher
 *                     already floors at a base score. A deliberate tap
 *                     therefore survives ranking, and competes on the same
 *                     scale as a text match.
 *   ageBand           becomes WORDS in the synthesised query ("child",
 *                     "teenager", "elderly"), so the ordinary matcher picks
 *                     up the age-related concerns through their own curated
 *                     `matchPhrases`. Adding "young adult" to a concern's
 *                     phrases in the admin panel therefore changes the
 *                     guide's behaviour too, with no code change — which is
 *                     exactly what "the same engine" has to mean.
 *   supportPreference likewise becomes words ("counselling and talking
 *                     therapy" / "medical help"). Deliberately NOT a hard
 *                     filter on `specialties.can_prescribe`: whether someone
 *                     needs medication is a clinical judgement, and SRS §2.4
 *                     forbids this module from making or influencing one. It
 *                     nudges wording; it never withholds a professional.
 *   forSelf           carried into the query text only ("for someone I care
 *                     about"), so phrasing curated for third-party concern
 *                     can match. It changes no score.
 *
 * The synthesised text is what gets written to `search_queries`, which is
 * correct: FR-5.7's admin loop should see the guide's real queries and their
 * result counts alongside the typed ones.
 */
@Injectable()
export class GuidedIntakeService {
  constructor(
    private readonly search: SearchService,
    private readonly catalogue: CatalogueFacade,
  ) {}

  async discover(patientId: string | null, source: SearchSource, facets: GuidedIntakeFacets): Promise<DiscoveryResponse> {
    // Only ACTIVE concerns are honoured: a patient cannot resurrect a
    // retired taxonomy entry by holding on to its id, which is the same rule
    // stage 3 applies to model-supplied codes.
    const selected =
      facets.concernIds && facets.concernIds.length > 0
        ? (await this.catalogue.getConcernsByIds(facets.concernIds)).filter((concern) => concern.isActive)
        : [];

    return this.search.discover({
      patientId,
      source,
      queryText: buildGuidedQueryText(selected, facets),
      isVoiceInput: false,
      languages: facets.languages,
      maxFeeInr: facets.maxFeeInr,
      availableWithinDays: facets.availableWithinDays,
      preselectedConcernIds: selected.map((concern) => concern.id),
      limit: facets.limit,
    });
  }
}

/** Words each age band contributes to the synthesised query — matched against curated `matchPhrases` like any other text. */
const AGE_BAND_PHRASES: Record<GuidedAgeBand, string> = {
  child: 'for a child',
  teen: 'for a teenager adolescent',
  adult: '',
  senior: 'for an elderly older person',
};

const SUPPORT_PREFERENCE_PHRASES: Record<GuidedSupportPreference, string> = {
  talking: 'counselling talking therapy',
  medical: 'medical help from a doctor',
  not_sure: '',
};

/**
 * PURE, and exported so the synthesis can be asserted directly. Builds one
 * ordinary-looking query string from the facets — the pipeline downstream
 * cannot tell it from something a patient typed, which is the point.
 */
export function buildGuidedQueryText(concerns: readonly PublicConcern[], facets: GuidedIntakeFacets): string {
  const parts: string[] = [];

  if (concerns.length > 0) {
    parts.push(concerns.map((concern) => concern.name).join(', '));
  }
  if (!facets.forSelf) {
    parts.push('for someone I care about');
  }
  if (facets.ageBand) {
    const phrase = AGE_BAND_PHRASES[facets.ageBand];
    if (phrase) parts.push(phrase);
  }
  if (facets.supportPreference) {
    const phrase = SUPPORT_PREFERENCE_PHRASES[facets.supportPreference];
    if (phrase) parts.push(phrase);
  }

  // A guide submitted with nothing chosen still has to produce a valid,
  // non-empty query — the pipeline logs it, and an empty string would be a
  // useless row in the FR-5.7 admin view.
  const text = parts.join(' ').trim();
  return text.length > 0 ? text : 'not sure whom to consult';
}
