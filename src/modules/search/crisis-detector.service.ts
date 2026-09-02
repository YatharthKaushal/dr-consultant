import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { SEARCH_CONFIG_FALLBACKS, SEARCH_CONFIG_KEYS } from './search.constants';
import { containsDevanagari, containsLeftAnchored, containsPhrase, toPaddedNormalized } from './search-text.util';

/**
 * *** STAGE 1. RUNS FIRST, ALWAYS, BEFORE ANY MODEL CALL, AND CANNOT BE
 * SKIPPED. *** FR-5.6 and SRS 6.3: "If a query contains self-harm or crisis
 * language, the system interrupts the booking flow and shows emergency
 * guidance instead of search results." `docs/MODULES.md` §7 makes it a
 * cross-module rule: "a crisis query in M-09 ... interrupt[s] whatever is in
 * progress."
 *
 * Ordering is not a detail here. The gate runs before the language model,
 * before the rate limiter and before any doctor read, so that:
 *   - a crisis phrase can never be spent on, or reworded by, a model;
 *   - a rate-limited patient still gets the guardrail (a throttle must never
 *     be able to swallow a safety response);
 *   - the guardrail behaves identically whether the AI is on, off, or down.
 * `search.service.ts` enforces that order and `crisis-detector.service.spec.ts`
 * asserts the AI port was never called.
 *
 * ---------------------------------------------------------------------------
 * THE MATCHING RULE (documented because it is a safety decision, not a
 * formatting one)
 *
 * Both the query and each curated keyword go through `normalizeText`
 * (`search-text.util.ts`): NFKC, lower case, ZWJ/ZWNJ and nukta dropped,
 * Latin accents folded, punctuation to spaces. Then:
 *
 *   - A keyword written in LATIN script must match with a word boundary on
 *     BOTH sides. `harm` therefore does NOT fire on `harmony`, and `die`
 *     does not fire on `diet`. This is the strict rule, and it is the right
 *     one for English/Hinglish because Latin-script false positives here are
 *     cheap to avoid: the admin list simply carries the inflected forms it
 *     cares about ("marna chahta hun", "marna chahti hun"), which is what a
 *     curated list is for.
 *
 *   - A keyword containing DEVANAGARI must match with a word boundary on the
 *     LEFT only; the right side may continue. Hindi inflects by suffix —
 *     मरना / मरने / मरूंगा / मरूंगी are all the same verb — so a both-sides
 *     rule would miss the majority of real phrasings while a left-anchored
 *     one catches them and still cannot fire from inside a word.
 *
 *     The cost is a narrower class of false positive: a SHORT Devanagari
 *     keyword could prefix an unrelated word (मर- also begins मरम्मत,
 *     "repair"). So suffix tolerance is granted only to keywords of at least
 *     `MIN_DEVANAGARI_PREFIX_LENGTH` characters; shorter ones fall back to
 *     the strict both-sides rule.
 *
 * The asymmetry is deliberate and points in the safe direction. For THIS
 * gate a false negative (missing a person in crisis) is incomparably worse
 * than a false positive (showing emergency guidance to someone who did not
 * need it). Every other matcher in this module — the concern matcher, the
 * ranker — is tuned the opposite way, because there the costs invert.
 *
 * *** CLINICIAN SIGN-OFF REQUIRED BEFORE LAUNCH (SRS §8). *** The starter
 * keyword list in `SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS` and this matching
 * rule are the developer's mechanism; the wording and coverage are the
 * client's qualified clinician's call. The list is admin-editable with no
 * release (FR-5.7).
 */

/** Below this length a Devanagari keyword is matched strictly, not as a prefix — see the matching rule above. */
const MIN_DEVANAGARI_PREFIX_LENGTH = 3;

export interface CrisisScreening {
  fired: boolean;
  /**
   * The curated keyword that matched, for server-side logging and for
   * M-16/M-18 to reason about. NEVER returned to the patient: echoing a
   * person's own crisis wording back at them in an API response is not
   * something to do by accident.
   */
  matchedKeyword: string | null;
}

const NO_CRISIS: CrisisScreening = { fired: false, matchedKeyword: null };

/**
 * PURE. The whole rule, with the keyword list handed in — which is why
 * almost every test for this gate needs no mocking at all. `CrisisDetector
 * Service` below is the thin `app_config` wrapper around it.
 */
export function screenTextForCrisis(text: string, keywords: readonly string[]): CrisisScreening {
  const padded = toPaddedNormalized(text);
  if (padded.trim().length === 0) return NO_CRISIS;

  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue;

    const suffixTolerant = containsDevanagari(keyword) && keyword.trim().length >= MIN_DEVANAGARI_PREFIX_LENGTH;
    const matched = suffixTolerant ? containsLeftAnchored(padded, keyword) : containsPhrase(padded, keyword);

    if (matched) {
      return { fired: true, matchedKeyword: keyword };
    }
  }

  return NO_CRISIS;
}

@Injectable()
export class CrisisDetectorService {
  constructor(private readonly appConfig: AppConfigService) {}

  /** Loads the admin-edited keyword list and applies `screenTextForCrisis`. A missing or malformed `app_config` row degrades to the compiled-in starter list — this gate must never fail open. */
  async screen(text: string): Promise<CrisisScreening> {
    const keywords = await this.loadKeywords();
    return screenTextForCrisis(text, keywords);
  }

  private async loadKeywords(): Promise<readonly string[]> {
    const configured = await this.appConfig.getJson<unknown>(
      SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS,
      SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS,
    );
    // Defensive: `app_config.value` is untyped jsonb, and this is the one
    // read in the module where degrading to "no keywords" would be a safety
    // failure rather than a cosmetic one.
    if (!Array.isArray(configured) || configured.length === 0) {
      return SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS;
    }
    const strings = configured.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return strings.length > 0 ? strings : SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS;
  }
}
