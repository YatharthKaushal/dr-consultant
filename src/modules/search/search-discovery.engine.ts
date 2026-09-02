import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import type { ListedDoctorFilter, ListedDoctorSummary } from '../doctor/doctor.contract';
import type { ConcernMatch, ConcernMatchOptions } from './concern-matcher.service';
import type { CrisisScreening } from './crisis-detector.service';
import type { RankDoctorsInput, RankedDoctor, SpecialtyMatch } from './doctor-ranker.service';
import type { InterpretationOutcome } from './query-interpreter.service';
import { extractReferenceTokens, type ProseValidation, type ResolvedReference } from './response-validator.service';
import type {
  BrowseSuggestions,
  DiscoveryRequest,
  DiscoveryResponse,
  DoctorResultView,
  MatchedConcernView,
  MatchedSpecialtyView,
  SearchGuidance,
} from './search.contract';
import { SEARCH_DISCLAIMER, SEARCH_TEMPLATE_GUIDANCE } from './search.constants';

/**
 * *** THE SIX-STAGE DISCOVERY PIPELINE. ***
 *
 *   1 CRISIS GATE   keyword match over app_config, PRE-LLM, cannot be skipped
 *       │ hit ──▶ emergency guidance + ZERO doctor results + log + END
 *       ▼ miss
 *   2 INTERPRET     the ONLY model call; degrades to the deterministic matcher
 *       ▼
 *   3 VALIDATE      every code and token must resolve to an ACTIVE row
 *       ▼
 *   4 MAP           concerns ──▶ specialties (the curated, authoritative step)
 *       ▼
 *   5 RANK          deterministic: specialty fit, concern weight, availability,
 *                   language, fee
 *       ▼
 *   6 ASSEMBLE      results + resolved references + disclaimer
 *
 * Stages 1, 3, 4 and 6 in this file are PURE FUNCTIONS over data handed in.
 * Stages 2 and 5 need I/O, so they take a `DiscoveryPorts` bag of narrow
 * interfaces — which is what lets every test here run against plain object
 * fakes with no Nest, no database and no model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A LANGGRAPH STATE GRAPH
 *
 * The brief allowed either, and asked for the honest answer. LangGraph earns
 * its ceremony on cyclic graphs, checkpointed long-running state,
 * human-in-the-loop interrupts, streaming intermediate state and multi-agent
 * handoff. This pipeline has none of those: it is a single-turn straight line
 * with two early exits, it completes inside one HTTP request, and it holds no
 * state between turns. What LangGraph would add here is 23 transitive
 * packages (measured), a checkpointer/SDK/protocol surface nothing calls, and
 * a `package.json` change in a repo three worktrees are editing at once —
 * in exchange for expressing a sequence that TypeScript already expresses.
 *
 * The brief's own hard requirement was that node bodies be plain exported
 * functions testable without constructing the graph. They are — every stage
 * below is exported and independently callable, and `runDiscoveryPipeline` is
 * the wiring, readable top to bottom in one screen. A graph object would have
 * hidden that sequence behind edge registrations without making it any more
 * testable. (For the record: the zod-version conflict one might expect is not
 * real — `@langchain/langgraph@1.4.13` peers `zod ^3.25.32 || ^4.2.0`, which
 * this repo's `zod ^4.4.3` satisfies. The case against is weight and fit, not
 * compatibility.)
 */

/* -------------------------------------------------------------------------- */
/* Ports — the narrow I/O surface the pipeline depends on                      */
/* -------------------------------------------------------------------------- */

export interface DiscoveryPorts {
  crisis: { screen(text: string): Promise<CrisisScreening> };
  interpreter: {
    isAiEnabled(): Promise<boolean>;
    interpret(
      queryText: string,
      specialties: readonly PublicSpecialty[],
      concerns: readonly PublicConcern[],
      beforeModelCall?: () => Promise<void>,
    ): Promise<InterpretationOutcome>;
  };
  matcher: {
    match(query: string, corpus: readonly PublicConcern[], options?: ConcernMatchOptions): ConcernMatch[];
    resolveCodes(codes: readonly string[], corpus: readonly PublicConcern[]): ConcernMatch[];
  };
  doctors: { listListedDoctors(filter: ListedDoctorFilter): Promise<ListedDoctorSummary[]> };
  availability: {
    getEarliestBookableSlots(
      doctorIds: readonly string[],
      fromUtc: Date,
      toUtc: Date,
    ): Promise<Array<{ doctorId: string; earliestStartsAt: Date | null }>>;
  };
  ranker: { rank(input: RankDoctorsInput): RankedDoctor[] };
  validator: { validate(text: string, resolvedTokens: ReadonlySet<string>): ProseValidation };
  /**
   * Throws (429) when the caller has exhausted `search.rate_limit_per_hour`,
   * and records the attempt when it has not. Called ONLY on the AI path, and
   * ONLY after the crisis gate — a throttle must never be able to swallow a
   * safety response.
   */
  rateLimiter: { consumeAiBudget(patientId: string | null, source: DiscoveryRequest['source']): Promise<void> };
}

/** Everything the pipeline reads from `app_config`, resolved once per request by the caller. */
export interface DiscoveryRuntimeConfig {
  maxResults: number;
  availabilityLookaheadDays: number;
  candidatePoolLimit: number;
  crisisGuidance: { message: string; helplines: Array<{ name: string; phone: string; availability?: string }> };
  popularSearches: Array<{ label: string; query: string }>;
}

export interface DiscoveryTaxonomy {
  specialties: readonly PublicSpecialty[];
  concerns: readonly PublicConcern[];
}

/** The state threaded through the stages. Each stage returns a new object rather than mutating, so a test can assert on any intermediate. */
export interface DiscoveryState {
  request: DiscoveryRequest;
  now: Date;
  config: DiscoveryRuntimeConfig;
  taxonomy: DiscoveryTaxonomy;
  crisis: CrisisScreening;
  interpretation: InterpretationOutcome | null;
  concernMatches: ConcernMatch[];
  specialtyMatches: SpecialtyMatch[];
  guidance: SearchGuidance | null;
  ranked: RankedDoctor[];
}

export function createInitialState(
  request: DiscoveryRequest,
  config: DiscoveryRuntimeConfig,
  taxonomy: DiscoveryTaxonomy,
  now: Date,
): DiscoveryState {
  return {
    request,
    now,
    config,
    taxonomy,
    crisis: { fired: false, matchedKeyword: null },
    interpretation: null,
    concernMatches: [],
    specialtyMatches: [],
    guidance: null,
    ranked: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — CRISIS GATE                                                       */
/* -------------------------------------------------------------------------- */

/**
 * FR-5.6. Runs FIRST, always, on the raw query, before the model, before the
 * rate limiter and before any doctor read. A hit short-circuits the entire
 * pipeline (see `runDiscoveryPipeline`) — no model call is made, no doctors
 * are fetched, and the response carries ZERO results.
 */
export async function stageCrisisGate(state: DiscoveryState, ports: DiscoveryPorts): Promise<DiscoveryState> {
  const crisis = await ports.crisis.screen(state.request.queryText);
  return { ...state, crisis };
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — INTERPRET                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The only stage that touches a model, and only when the kill switch is on.
 *
 * AI budget is spent through a CALLBACK the interpreter invokes at the last
 * moment before it actually calls the model — after the kill switch and the
 * availability probe have both passed. Consuming it here instead, before
 * `interpret`, was the original shape and it was wrong: it charged every
 * request whose model call was never attempted, so an AI outage would have
 * throttled patients on top of degrading them, and (before `modules/ai`
 * merges at all) every single search would burn budget against a port that
 * always reports unavailable. Live testing is what surfaced it.
 *
 * The callback can throw 429, and that throw propagates rather than falling
 * back — but only ever AFTER the crisis gate has run, so a throttled patient
 * has already received the guardrail.
 */
export async function stageInterpret(state: DiscoveryState, ports: DiscoveryPorts): Promise<DiscoveryState> {
  const aiEnabled = await ports.interpreter.isAiEnabled();
  if (!aiEnabled) {
    return { ...state, interpretation: { source: 'deterministic', reason: 'kill_switch' } };
  }

  const interpretation = await ports.interpreter.interpret(
    state.request.queryText,
    state.taxonomy.specialties,
    state.taxonomy.concerns,
    async () => ports.rateLimiter.consumeAiBudget(state.request.patientId, state.request.source),
  );
  return { ...state, interpretation };
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — VALIDATE                                                          */
/* -------------------------------------------------------------------------- */

/** Every `{{...}}` token the live taxonomy can currently justify. Anything outside this set was invented by the model. */
export function buildResolvableReferences(taxonomy: DiscoveryTaxonomy): Map<string, ResolvedReference> {
  const references = new Map<string, ResolvedReference>();

  for (const specialty of taxonomy.specialties) {
    if (!specialty.isActive) continue;
    const token = `{{specialty:${specialty.code}}}`;
    references.set(token, {
      token,
      type: 'specialty',
      id: specialty.id,
      code: specialty.code,
      label: specialty.name,
      deepLink: `/search/doctors?specialtyId=${specialty.id}`,
    });
  }

  for (const concern of taxonomy.concerns) {
    if (!concern.isActive) continue;
    const token = `{{concern:${concern.code}}}`;
    references.set(token, {
      token,
      type: 'concern',
      id: concern.id,
      code: concern.code,
      label: concern.name,
      // A concern is not itself bookable; its deep link is the doctors of
      // the specialty it belongs to, so every chip lands somewhere real.
      deepLink: `/search/doctors?specialtyId=${concern.specialtyId}`,
    });
  }

  return references;
}

/**
 * PURE. Stage 3 for the AI path: resolve the model's concern codes against
 * ACTIVE concerns, then validate its prose. Anything unresolvable — an
 * invented code, or a token naming a concern an admin has DEACTIVATED —
 * fails, and the whole prose is discarded for the template.
 *
 * Deactivation counts as unresolvable on purpose: an admin who retires a
 * concern has said it must stop being offered, and "the model still knows
 * about it" is not an exception to that.
 */
export function stageValidate(
  state: DiscoveryState,
  ports: DiscoveryPorts,
): { concernMatches: ConcernMatch[]; guidance: SearchGuidance | null } {
  const interpretation = state.interpretation;
  const options: ConcernMatchOptions = { preselectedConcernIds: state.request.preselectedConcernIds };

  if (!interpretation || interpretation.source !== 'ai') {
    // Deterministic path: the matcher IS stages 2 and 3 at once — it can
    // only ever return concerns that are in the live corpus, so there is
    // nothing to invalidate.
    return { concernMatches: ports.matcher.match(state.request.queryText, state.taxonomy.concerns, options), guidance: null };
  }

  let concernMatches = ports.matcher.resolveCodes(interpretation.value.concernCodes, state.taxonomy.concerns);

  // Every code the model returned was unresolvable: it did not map the query
  // onto our taxonomy at all, so the deterministic matcher gets the query
  // instead of the patient getting nothing.
  if (concernMatches.length === 0) {
    concernMatches = ports.matcher.match(state.request.queryText, state.taxonomy.concerns, options);
  } else if (state.request.preselectedConcernIds && state.request.preselectedConcernIds.length > 0) {
    // FR-5.5: an explicitly chosen concern survives even when the model did
    // not return it — the same floor the matcher applies, applied here so
    // both paths honour the guide identically.
    concernMatches = mergePreselected(concernMatches, state.taxonomy.concerns, state.request.preselectedConcernIds);
  }

  const resolvable = buildResolvableReferences(state.taxonomy);
  const validation = ports.validator.validate(interpretation.value.guidance, new Set(resolvable.keys()));
  if (!validation.accepted) {
    return { concernMatches, guidance: null };
  }

  const references = extractReferenceTokens(interpretation.value.guidance)
    .map(({ token }) => resolvable.get(token))
    .filter((reference): reference is ResolvedReference => reference !== undefined);

  return {
    concernMatches,
    guidance: { text: interpretation.value.guidance, references: dedupeReferences(references), source: 'model' },
  };
}

function mergePreselected(
  matches: ConcernMatch[],
  corpus: readonly PublicConcern[],
  preselectedIds: readonly string[],
): ConcernMatch[] {
  const present = new Set(matches.map((match) => match.concern.id));
  const additions = corpus
    .filter((concern) => concern.isActive && preselectedIds.includes(concern.id) && !present.has(concern.id))
    .map((concern) => ({ concern, score: 0.8 * concern.matchWeight, matchedPhrases: [] }));
  return [...matches, ...additions].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.concern.code.localeCompare(b.concern.code),
  );
}

function dedupeReferences(references: readonly ResolvedReference[]): ResolvedReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => (seen.has(reference.token) ? false : (seen.add(reference.token), true)));
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — MAP (concerns ──▶ specialties)                                     */
/* -------------------------------------------------------------------------- */

/**
 * PURE. THE CURATED, AUTHORITATIVE STEP. A concern belongs to exactly one
 * specialty (`concerns.specialty_id`), so this is a lookup, not a judgement —
 * which is precisely the point. Whatever the model did upstream, the specialty
 * a patient is routed to is decided by a row an admin owns.
 *
 * Specialty score is the SUM of its concerns' scores: a query matching two
 * concerns of one specialty is a stronger signal for that specialty than a
 * query matching one. Concern names are kept in match order for FR-5.4's
 * "matched to: sleep, anxiety".
 *
 * Specialties are ordered by score desc then code asc — total and stable.
 */
export function stageMapConcernsToSpecialties(
  concernMatches: readonly ConcernMatch[],
  taxonomy: DiscoveryTaxonomy,
): SpecialtyMatch[] {
  const specialtyById = new Map(taxonomy.specialties.filter((specialty) => specialty.isActive).map((s) => [s.id, s]));
  const bySpecialty = new Map<string, SpecialtyMatch>();

  for (const match of concernMatches) {
    const specialty = specialtyById.get(match.concern.specialtyId);
    // A concern whose specialty has been deactivated maps nowhere — the
    // same "an admin retired this" rule stage 3 applies to concerns.
    if (!specialty) continue;

    const existing = bySpecialty.get(specialty.id);
    if (existing) {
      existing.score += match.score;
      existing.concernIds.push(match.concern.id);
      existing.concernNames.push(match.concern.name);
      continue;
    }
    bySpecialty.set(specialty.id, {
      specialtyId: specialty.id,
      specialtyCode: specialty.code,
      specialtyName: specialty.name,
      score: match.score,
      concernIds: [match.concern.id],
      concernNames: [match.concern.name],
    });
  }

  return [...bySpecialty.values()].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.specialtyCode.localeCompare(b.specialtyCode),
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 5 — RANK                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fetches the candidate pool for the matched specialties, resolves each
 * doctor's earliest bookable slot in ONE batched availability call, and hands
 * both to the deterministic ranker.
 *
 * A query that matched no specialty returns NO doctors rather than a generic
 * list: FR-5.4 requires every result to carry a reason, and "no reason" is
 * not one. The browse suggestions assembled in stage 6 are the answer to that
 * case (FR-5.3), which is why a zero-match query is a 200 with somewhere to
 * go, never an error.
 */
export async function stageRank(state: DiscoveryState, ports: DiscoveryPorts): Promise<RankedDoctor[]> {
  if (state.specialtyMatches.length === 0) return [];

  const candidates = await ports.doctors.listListedDoctors({
    specialtyIds: state.specialtyMatches.map((match) => match.specialtyId),
    languages: state.request.languages,
    maxFeeInr: state.request.maxFeeInr,
    limit: state.config.candidatePoolLimit,
    offset: 0,
  });
  if (candidates.length === 0) return [];

  const lookaheadDays = state.config.availabilityLookaheadDays;
  const toUtc = new Date(state.now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const earliest = await ports.availability.getEarliestBookableSlots(
    candidates.map((doctor) => doctor.id),
    state.now,
    toUtc,
  );

  return ports.ranker.rank({
    candidates,
    specialtyMatches: state.specialtyMatches,
    earliestSlotByDoctorId: new Map(earliest.map((entry) => [entry.doctorId, entry.earliestStartsAt])),
    filters: {
      languages: state.request.languages,
      maxFeeInr: state.request.maxFeeInr,
      availableWithinDays: state.request.availableWithinDays,
    },
    now: state.now,
    lookaheadDays,
    limit: state.request.limit ?? state.config.maxResults,
  });
}

/* -------------------------------------------------------------------------- */
/* Stage 6 — ASSEMBLE                                                          */
/* -------------------------------------------------------------------------- */

/** PURE. Builds the single payload all three UI concepts render from — see `search.contract.ts`. */
export function stageAssemble(state: DiscoveryState): DiscoveryResponse {
  const resolvable = buildResolvableReferences(state.taxonomy);

  if (state.crisis.fired) {
    const { message, helplines } = state.config.crisisGuidance;
    return {
      crisis: { message, helplines },
      // The crisis message is ALSO the guidance text, so a client that
      // renders only `guidance.text` (the floating-bubble concept) still
      // shows it. A safety response must not depend on which UI won.
      guidance: { text: message, references: [], source: 'template' },
      matchedConcerns: [],
      matchedSpecialties: [],
      // FR-5.6: emergency guidance INSTEAD OF search results.
      results: [],
      suggestions: buildSuggestions(state),
      meta: { interpretation: 'deterministic', aiEnabled: false, crisisGuardrailFired: true, resultCount: 0 },
      disclaimer: SEARCH_DISCLAIMER,
    };
  }

  const guidance = state.guidance ?? buildTemplateGuidance(state, resolvable);
  const results = state.ranked.map(toDoctorResultView);

  return {
    crisis: null,
    guidance,
    matchedConcerns: state.concernMatches.map((match) => ({
      id: match.concern.id,
      code: match.concern.code,
      name: match.concern.name,
      specialtyId: match.concern.specialtyId,
    })),
    matchedSpecialties: state.specialtyMatches.map(
      (match): MatchedSpecialtyView => ({
        id: match.specialtyId,
        code: match.specialtyCode,
        name: match.specialtyName,
        concernNames: match.concernNames,
      }),
    ),
    results,
    suggestions: buildSuggestions(state),
    meta: {
      interpretation: state.interpretation?.source === 'ai' ? 'ai' : 'deterministic',
      aiEnabled: state.interpretation?.source === 'ai' || state.interpretation?.reason !== 'kill_switch',
      crisisGuardrailFired: false,
      resultCount: results.length,
    },
    disclaimer: SEARCH_DISCLAIMER,
  };
}

/** The template used whenever model prose is unavailable or was rejected. Tokens come from the specialties that actually matched, so its references always resolve. */
function buildTemplateGuidance(state: DiscoveryState, resolvable: ReadonlyMap<string, ResolvedReference>): SearchGuidance {
  if (state.specialtyMatches.length === 0) {
    return { text: SEARCH_TEMPLATE_GUIDANCE.noMatches, references: [], source: 'template' };
  }

  const tokens = state.specialtyMatches.map((match) => `{{specialty:${match.specialtyCode}}}`);
  const references = tokens
    .map((token) => resolvable.get(token))
    .filter((reference): reference is ResolvedReference => reference !== undefined);

  return { text: `${SEARCH_TEMPLATE_GUIDANCE.withMatches} ${tokens.join(', ')}`, references, source: 'template' };
}

/** FR-5.3. Always populated, so a zero-match query still has somewhere to go. */
function buildSuggestions(state: DiscoveryState): BrowseSuggestions {
  return {
    concerns: state.taxonomy.concerns
      .filter((concern) => concern.isActive)
      .map(
        (concern): MatchedConcernView => ({
          id: concern.id,
          code: concern.code,
          name: concern.name,
          specialtyId: concern.specialtyId,
        }),
      ),
    specialties: state.taxonomy.specialties
      .filter((specialty) => specialty.isActive)
      .map((specialty) => ({ id: specialty.id, code: specialty.code, name: specialty.name })),
    popular: state.config.popularSearches,
  };
}

function toDoctorResultView(ranked: RankedDoctor): DoctorResultView {
  return {
    doctorId: ranked.doctor.id,
    fullName: ranked.doctor.fullName,
    qualification: ranked.doctor.qualification,
    registrationNumber: ranked.doctor.registrationNumber,
    yearsOfExperience: ranked.doctor.yearsOfExperience,
    languages: ranked.doctor.languages,
    consultationFeeInr: ranked.doctor.consultationFeeInr,
    consultationDurationMinutes: ranked.doctor.consultationDurationMinutes,
    specialties: ranked.doctor.specialties.map((specialty) => ({
      id: specialty.id,
      code: specialty.code,
      name: specialty.name,
      isPrimary: specialty.isPrimary,
    })),
    earliestSlotAt: ranked.earliestSlotAt ? ranked.earliestSlotAt.toISOString() : null,
    reason: ranked.reason,
    matchedConcernNames: ranked.matchedConcernNames,
    score: Number(ranked.score.toFixed(4)),
  };
}

/* -------------------------------------------------------------------------- */
/* The pipeline                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Runs the six stages in order, with the two conditional edges the
 * architecture calls for:
 *
 *   - CRISIS SHORT-CIRCUIT (stage 1 -> stage 6). Nothing between them runs:
 *     no model call, no rate-limit consumption, no doctor read.
 *   - AI-FAILURE FALLBACK (inside stages 2/3). The interpreter never throws;
 *     it reports a named `deterministic` reason and stage 3 runs the matcher
 *     on the original query instead. From stage 4 on, the two paths are
 *     indistinguishable — which is what makes the kill switch safe to flip.
 */
export async function runDiscoveryPipeline(
  request: DiscoveryRequest,
  ports: DiscoveryPorts,
  config: DiscoveryRuntimeConfig,
  taxonomy: DiscoveryTaxonomy,
  now: Date = new Date(),
): Promise<{ state: DiscoveryState; response: DiscoveryResponse }> {
  let state = createInitialState(request, config, taxonomy, now);

  state = await stageCrisisGate(state, ports);
  if (state.crisis.fired) {
    return { state, response: stageAssemble(state) };
  }

  state = await stageInterpret(state, ports);

  const validated = stageValidate(state, ports);
  state = { ...state, concernMatches: validated.concernMatches, guidance: validated.guidance };

  state = { ...state, specialtyMatches: stageMapConcernsToSpecialties(state.concernMatches, state.taxonomy) };

  state = { ...state, ranked: await stageRank(state, ports) };

  return { state, response: stageAssemble(state) };
}
