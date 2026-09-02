import { Injectable } from '@nestjs/common';
import type { PublicConcern } from '../catalogue/catalogue.contract';
import { SEARCH_STOP_WORDS, containsPhrase, normalizeText, tokenize } from './search-text.util';

/**
 * *** STAGE 2-FALLBACK. THE DETERMINISTIC MATCHER. ***
 *
 * Scores a free-text query against the curated corpus — `concerns.match
 * Phrases` (the admin-edited synonym/trigger list, FR-5.7) weighted by
 * `concerns.matchWeight`. PURE FUNCTIONS: the concern corpus is fetched by
 * the caller through `CatalogueFacade` and handed in, so every test here
 * needs no mocking, exactly like `availability-slot.engine.ts`.
 *
 * This is NOT a stub or a degraded mode. It is on the critical path three
 * different ways, and has to be genuinely useful alone in all of them:
 *   1. the `search.ai_enabled` kill switch (FR-5.7's "an admin edit changes
 *      behaviour with no release" taken to its conclusion — the client can
 *      turn the model off entirely);
 *   2. every AI failure, timeout or malformed response;
 *   3. today, before `modules/ai` merges, it is the ONLY path.
 *
 * ---------------------------------------------------------------------------
 * SCORING, per concern:
 *
 *   phraseScore(phrase) =
 *     1.0                    when the whole phrase appears in the query at
 *                            word boundaries ("cant sleep" in "i cant sleep
 *                            at night");
 *     overlapRatio * 0.6     when at least MIN_OVERLAP_RATIO of the phrase's
 *                            CONTENT tokens appear in the query;
 *     0                      otherwise.
 *
 *   raw   = max(phraseScores) + CORROBORATION_BONUS * min(3, matches - 1)
 *   score = raw * matchWeight
 *
 * Three decisions worth their justification:
 *
 *   - `max` plus a small capped corroboration bonus, rather than a sum. A
 *     sum lets a concern with thirty seeded phrases beat a concern with three
 *     on breadth of curation rather than fit to the query, which would make
 *     the ranking a function of who edited the admin panel last.
 *
 *   - Content tokens only. Stop words ("i", "hai", "में") are removed from
 *     the PHRASE before the ratio is computed, so "neend nahi aati" is not
 *     half-matched by a query containing only "nahi". The query is never
 *     edited — only the denominator changes.
 *
 *   - MIN_OVERLAP_RATIO is 0.6, above the 0.5 that a single token of a
 *     two-token phrase would score. A two-token phrase therefore needs both
 *     tokens (at which point the exact-phrase rule usually catches it
 *     anyway), and a three-token phrase needs two. Partial credit is real
 *     but never cheap.
 *
 * Ordering is total and stable: score desc, then matchWeight desc, then
 * `code` ascending. Identical requests can never return differently-ordered
 * results.
 *
 * A zero-match query is NOT an error — it returns an empty list, and
 * `search-discovery.engine.ts` turns that into browse suggestions (FR-5.3).
 */

/** Fraction of a phrase's content tokens a query must cover to earn partial credit. See the scoring note above. */
const MIN_OVERLAP_RATIO = 0.6;
/** Weight applied to a partial (token-overlap) match, so it can never outrank a whole-phrase hit. */
const PARTIAL_MATCH_WEIGHT = 0.6;
/** Added per ADDITIONAL matching phrase beyond the best one, capped — corroboration is worth something, breadth of curation is not. */
const CORROBORATION_BONUS = 0.15;
const MAX_CORROBORATION_MATCHES = 3;

export interface ConcernMatch {
  concern: PublicConcern;
  /** `raw * matchWeight`. Comparable across concerns; not a probability and never shown to a patient as one. */
  score: number;
  /** The curated phrases that actually fired, in corpus order — the audit trail for "why did this concern match". */
  matchedPhrases: string[];
}

/** Everything the matcher can be tuned by, so a caller (guided intake) can bias without a second scoring path. */
export interface ConcernMatchOptions {
  /**
   * Concern ids the patient chose explicitly (FR-5.5's concern guide). They
   * are floored at `PRESELECTED_BASE_SCORE * matchWeight` so a deliberate
   * selection always survives ranking, then compete on the SAME scale as
   * text matches — which is what "using the same engine" has to mean if it
   * means anything.
   */
  preselectedConcernIds?: readonly string[];
  /** Cap on returned matches. Undefined means no cap. */
  limit?: number;
}

/** Base score a deliberately-selected concern is floored at, before `matchWeight`. Comfortably above a partial text match, below a whole-phrase one. */
const PRESELECTED_BASE_SCORE = 0.8;

function contentTokens(phrase: string): string[] {
  const tokens = tokenize(phrase);
  const content = tokens.filter((token) => !SEARCH_STOP_WORDS.has(token));
  // An all-stop-word phrase ("i am") keeps its own tokens rather than
  // becoming an empty denominator that divides by zero and matches
  // everything.
  return content.length > 0 ? content : tokens;
}

function scorePhrase(paddedQuery: string, queryTokens: ReadonlySet<string>, phrase: string): number {
  if (containsPhrase(paddedQuery, phrase)) return 1;

  const tokens = contentTokens(phrase);
  if (tokens.length === 0) return 0;

  const hits = tokens.filter((token) => queryTokens.has(token)).length;
  const ratio = hits / tokens.length;
  return ratio >= MIN_OVERLAP_RATIO ? ratio * PARTIAL_MATCH_WEIGHT : 0;
}

/**
 * PURE. Scores every active concern in `corpus` against `query` and returns
 * the ones that matched, best first.
 */
export function matchConcerns(
  query: string,
  corpus: readonly PublicConcern[],
  options: ConcernMatchOptions = {},
): ConcernMatch[] {
  const paddedQuery = ` ${normalizeText(query)} `;
  const queryTokens = new Set(tokenize(query));
  const preselected = new Set(options.preselectedConcernIds ?? []);

  const matches: ConcernMatch[] = [];

  for (const concern of corpus) {
    // Belt and braces: the caller asks catalogue for ACTIVE concerns, but an
    // inactive one reaching the scorer would silently resurrect a taxonomy
    // entry an admin deliberately retired.
    if (!concern.isActive) continue;

    const phraseScores: Array<{ phrase: string; score: number }> = [];
    for (const phrase of concern.matchPhrases) {
      if (typeof phrase !== 'string') continue;
      const score = scorePhrase(paddedQuery, queryTokens, phrase);
      if (score > 0) phraseScores.push({ phrase, score });
    }

    // The concern's own name is an implicit match phrase — a patient typing
    // "anxiety" should match the Anxiety concern whether or not an admin
    // remembered to seed its own name as a phrase.
    const nameScore = scorePhrase(paddedQuery, queryTokens, concern.name);
    if (nameScore > 0) phraseScores.push({ phrase: concern.name, score: nameScore });

    const best = phraseScores.reduce((max, entry) => Math.max(max, entry.score), 0);
    const corroboration = CORROBORATION_BONUS * Math.min(MAX_CORROBORATION_MATCHES, Math.max(0, phraseScores.length - 1));
    const textRaw = best > 0 ? best + corroboration : 0;

    const raw = preselected.has(concern.id) ? Math.max(textRaw, PRESELECTED_BASE_SCORE) : textRaw;
    if (raw <= 0) continue;

    matches.push({
      concern,
      score: raw * concern.matchWeight,
      matchedPhrases: phraseScores.map((entry) => entry.phrase),
    });
  }

  matches.sort(compareMatches);
  return options.limit === undefined ? matches : matches.slice(0, options.limit);
}

/** Total, stable ordering — score desc, then `matchWeight` desc, then `code` asc so identical requests never shuffle. */
function compareMatches(a: ConcernMatch, b: ConcernMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.concern.matchWeight !== a.concern.matchWeight) return b.concern.matchWeight - a.concern.matchWeight;
  return a.concern.code.localeCompare(b.concern.code);
}

/**
 * PURE. Resolves model-returned concern CODES onto the live corpus — stage 3
 * for the AI path. A code that does not resolve to an ACTIVE concern is
 * dropped, which is how an invented taxonomy entry is prevented from
 * reaching a patient. Ordering follows the model's own ranking, and each
 * survivor is scored on the same scale a preselected concern is, so stages
 * 4-6 cannot tell the two paths apart.
 */
export function resolveConcernCodes(codes: readonly string[], corpus: readonly PublicConcern[]): ConcernMatch[] {
  const byCode = new Map(corpus.filter((concern) => concern.isActive).map((concern) => [concern.code, concern]));
  const seen = new Set<string>();
  const resolved: ConcernMatch[] = [];

  for (const code of codes) {
    if (typeof code !== 'string') continue;
    const concern = byCode.get(code.trim().toLowerCase());
    if (!concern || seen.has(concern.id)) continue;
    seen.add(concern.id);
    resolved.push({ concern, score: PRESELECTED_BASE_SCORE * concern.matchWeight, matchedPhrases: [] });
  }

  return resolved;
}

/**
 * The injectable wrapper. Holds no state and does no I/O — it exists so
 * `search.service.ts` composes services rather than reaching for module-level
 * functions, and so the matcher can be swapped at the DI layer if the client
 * ever wants a different deterministic strategy.
 */
@Injectable()
export class ConcernMatcherService {
  match(query: string, corpus: readonly PublicConcern[], options?: ConcernMatchOptions): ConcernMatch[] {
    return matchConcerns(query, corpus, options);
  }

  resolveCodes(codes: readonly string[], corpus: readonly PublicConcern[]): ConcernMatch[] {
    return resolveConcernCodes(codes, corpus);
  }
}
