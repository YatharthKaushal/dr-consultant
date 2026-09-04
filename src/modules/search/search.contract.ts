import type { SearchSource } from '../../schema/enums.schema';
import type { ResolvedReference } from './response-validator.service';

/**
 * Search's public surface, and the SHAPE OF EVERY DISCOVERY RESPONSE.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESPONSE IS SHAPED LIKE THIS
 *
 * The client has not settled its UI: three Figma concepts are live — a
 * floating assistant bubble, a home-screen section, and a unified search bar
 * (FR-5.9 already requires two of those entry points to be "the same engine,
 * mapping and crisis guardrail"). All three must render from THIS payload
 * with no backend change, so the response is a superset of what any one of
 * them needs rather than a shape tailored to whichever wins:
 *
 *   - the bubble renders `guidance.text` (substituting `references` inline)
 *     and the first few `results`;
 *   - the home-screen section renders `suggestions` (browse chips, popular
 *     searches) and ignores `guidance`;
 *   - the search bar renders `results` with `references` as tappable chips.
 *
 * That is also why `guidance.text` keeps its `{{...}}` tokens AND ships a
 * resolved `references` array beside it. A client that wants a sentence
 * substitutes `label` inline; a client that wants chips renders the array and
 * strips the tokens. Neither needs the backend to pick.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 *
 * No condition name, no severity, no probability, no confidence percentage,
 * no "next step" clinical advice — SRS §2.4/§8. `score` is a ranking number
 * for ordering and admin explainability; it is not a clinical measure and no
 * client should render it as one. `disclaimer` is on EVERY response,
 * including crisis and zero-result ones, because FR-5.8 requires the
 * interface to state plainly what this feature is not.
 */

export interface DiscoveryRequest {
  /** `null` for an unattributed source (MCP/WhatsApp) — logged, but never surfaced in anyone's recent searches. */
  patientId: string | null;
  source: SearchSource;
  queryText: string;
  /** FR-5.10 — spoken input, already transcribed by the time it reaches here. */
  isVoiceInput?: boolean;
  /** FR-4.4 filters, applied by the ranker before scoring. */
  languages?: readonly string[];
  maxFeeInr?: string;
  availableWithinDays?: number;
  /** FR-5.5's concern guide: concerns the patient chose explicitly. Fed into the SAME matcher as a floor, not a separate path. */
  preselectedConcernIds?: readonly string[];
  /** Caps returned doctors. Defaults to `search.max_results`. */
  limit?: number;
}

/** A concern the query mapped onto, as shown to a patient. `matchWeight`/`matchPhrases` stay internal — they are admin tuning data, not patient content. */
export interface MatchedConcernView {
  id: string;
  code: string;
  name: string;
  specialtyId: string;
}

export interface MatchedSpecialtyView {
  id: string;
  code: string;
  name: string;
  /** Curated names of the concerns that mapped onto this specialty — FR-5.4's "matched to: sleep, anxiety". */
  concernNames: string[];
}

export interface DoctorSpecialtyView {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/** One ranked doctor. Carries every field FR-4.2 requires a listing to show. */
export interface DoctorResultView {
  doctorId: string;
  fullName: string;
  qualification: string | null;
  registrationNumber: string | null;
  yearsOfExperience: number | null;
  languages: string[];
  consultationFeeInr: string;
  consultationDurationMinutes: number;
  specialties: DoctorSpecialtyView[];
  /** ISO 8601, or `null` when nothing is bookable inside the ranking lookahead. FR-4.2's "live availability". */
  earliestSlotAt: string | null;
  /** FR-5.4's plain-language reason. Curated text only — never model prose. */
  reason: string;
  matchedConcernNames: string[];
  /** Ranking score, 0..1. For ordering and admin explainability. NOT a clinical measure. */
  score: number;
}

export interface SearchGuidance {
  /** Navigation prose containing `{{specialty:code}}`/`{{concern:code}}` tokens. */
  text: string;
  references: ResolvedReference[];
  /** `model` only when the LLM wrote it AND it survived stage 3 + the response validator. `template` in every other case, including every deterministic run. */
  source: 'model' | 'template';
}

/** FR-5.3's browse affordances. Always populated, so a zero-match query is a dead end for nobody. */
export interface BrowseSuggestions {
  concerns: MatchedConcernView[];
  specialties: Array<{ id: string; code: string; name: string }>;
  popular: Array<{ label: string; query: string }>;
}

/**
 * FR-5.6 / SRS 6.3. Present (non-null) ONLY when the crisis guardrail fired,
 * in which case `results` is EMPTY — "shows emergency guidance INSTEAD OF
 * search results", not alongside them.
 */
export interface CrisisGuidanceView {
  message: string;
  helplines: Array<{ name: string; phone: string; availability?: string }>;
}

export interface DiscoveryResponse {
  crisis: CrisisGuidanceView | null;
  guidance: SearchGuidance;
  matchedConcerns: MatchedConcernView[];
  matchedSpecialties: MatchedSpecialtyView[];
  results: DoctorResultView[];
  suggestions: BrowseSuggestions;
  meta: {
    /** Which stage-2 path produced the mapping. Reported honestly so an admin can see the kill switch and the fallbacks working. */
    interpretation: 'ai' | 'deterministic';
    /** The `search.ai_enabled` kill switch as read for THIS request. */
    aiEnabled: boolean;
    crisisGuardrailFired: boolean;
    resultCount: number;
  };
  /** FR-5.8. On every response, without exception. */
  disclaimer: string;
}

/**
 * Search's public surface — deliberately two methods, both with a named
 * near-term consumer, same restraint as `catalogue.contract.ts` and
 * `availability.contract.ts`:
 *
 *   - discover: the whole pipeline. The MCP tool surface (built in a
 *     separate worktree under `modules/search/tools/`) calls exactly this,
 *     with `patientId: null` and `source: 'mcp'`, which is why the request
 *     takes a patient id rather than reading one from an auth context.
 *   - screenForCrisis: the guardrail ALONE. `docs/MODULES.md` §7 makes crisis
 *     handling a cross-module rule ("a crisis query in M-09 and a red status
 *     in M-16 interrupt whatever is in progress"), and M-16/M-17/M-18 must
 *     screen free text against the SAME admin-edited keyword list rather
 *     than each keeping their own copy of it.
 *
 * Nothing about ranking, config or query logs is exposed: those are this
 * module's internals, reachable only through its own HTTP surface.
 */
export interface SearchContract {
  discover(request: DiscoveryRequest): Promise<DiscoveryResponse>;

  /** `true` when the text matches the admin-edited crisis keyword list. Never throws; a config read failure degrades to the compiled-in starter list. */
  screenForCrisis(text: string): Promise<{ fired: boolean }>;

  /**
   * ADDITIVE (M-21/data rights execution): a READ-ONLY row count for
   * `search_queries` and `search_rate_limits` for this patient, so a
   * data-deletion preview can report both without writing anything.
   */
  countDataRightsRowsForPatient(patientId: string): Promise<{ searchQueries: number; searchRateLimits: number }>;

  /**
   * ADDITIVE (M-21/data rights execution). *** THE ONLY WRITE M-21 MAKES
   * AGAINST THIS TABLE. *** `search_queries.schema.ts`'s own header names this
   * table explicitly: "Must be included in `data_deletion_requests` execution —
   * a free-text symptom query is among the most sensitive strings this
   * platform stores." HARD-DELETES every `search_queries` row for this patient
   * — not an anonymize, a real delete, because a free-text query string has no
   * legitimate retention purpose once the patient who typed it is gone.
   * `search_rate_limits` is untouched — see its own schema comment on why it
   * is designed to survive independent of patient lifecycle.
   *
   * Idempotent: deleting an already-empty set returns `{ deletedCount: 0 }`,
   * never throws.
   */
  deleteSearchQueriesForPatient(patientId: string): Promise<{ deletedCount: number }>;
}
