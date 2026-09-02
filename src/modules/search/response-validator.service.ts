import { Injectable, Logger } from '@nestjs/common';
import { containsLeftAnchored, containsPhrase, toLogExcerpt, toPaddedNormalized } from './search-text.util';

/**
 * *** THE COMPLIANCE GUARDRAIL. ***
 *
 * SRS §2.4 and §8 are not style guidance, they are the contract: "The AI
 * module assists navigation only. It must not screen, diagnose, triage
 * clinical severity or influence treatment, and the interface must state
 * this." FR-5.8 repeats it patient-side. This service is the enforcement
 * point — the last thing between a hosted language model and a patient's
 * screen.
 *
 * It rejects on two independent grounds, either of which discards the WHOLE
 * prose (never a partial edit — a redacted diagnosis is still a diagnosis
 * with a hole in it):
 *
 *   1. DENY-LIST language. Categories and their justification are below.
 *   2. An UNRESOLVABLE reference token. The model may only name entities as
 *      `{{specialty:code}}` / `{{concern:code}}`, resolved against live
 *      catalogue data by stage 3. A token that does not resolve means the
 *      model invented a specialty or a concern, which is the exact failure
 *      the token scheme exists to catch.
 *
 * Every rejection is LOGGED with the offending construction and a bounded
 * excerpt. That log line is the drift signal: a model, a prompt or a provider
 * change that starts producing clinical language shows up here as a rising
 * count rather than as a complaint from a patient.
 *
 * *** THE CRISIS PATH NEVER REACHES THIS SERVICE. *** Emergency guidance is
 * a fixed admin-authored template rendered by stage 1, with no model
 * involved. That matters here because the deny-list deliberately blocks
 * "emergency", "urgent" and "at risk" — words the crisis template must be
 * free to use, and would be broken by if it were validated as model prose.
 */

/**
 * Each entry is either an exact phrase (word-bounded on both sides) or a
 * `stem*` prefix (word-bounded on the left only, matching any continuation).
 *
 * The six categories, and why each is here rather than merely discouraged:
 *
 *   ATTRIBUTION — "you may have", "sounds like you have". The single
 *     highest-risk construction: it converts navigation into a provisional
 *     diagnosis addressed to the patient. SRS §8 reserves diagnosis to the
 *     treating doctor, full stop.
 *
 *   DIAGNOSIS — `diagnos*`, "prognosis", "differential", "your condition".
 *     Naming the ACT is as much a breach as performing it: a patient told
 *     the app "cannot diagnose you, but..." has still been given a clinical
 *     frame. The stem covers diagnose/diagnosis/diagnostic/diagnosed in one
 *     entry.
 *
 *   SEVERITY / TRIAGE — "mild", "moderate", "severe", "acute", "chronic",
 *     "high risk", "life threatening". SRS §2.4 names triage of clinical
 *     severity explicitly and separately from diagnosis, because grading how
 *     bad something is changes what a patient does next just as decisively.
 *
 *   PROBABILITY — "likely", "probably", "chances are", "most likely".
 *     Hedged clinical claims are still clinical claims, and are harder to
 *     challenge precisely because they sound careful.
 *
 *   TREATMENT — "medication", "prescribe", "dose", "treatment plan", "cure".
 *     SRS §2.4's "influence treatment". Navigation prose has no business
 *     naming a therapy; that is the consultation's job.
 *
 *   SCREENING / ASSESSMENT — "screening", "assessment shows", "test
 *     result", "based on your symptoms". SRS §2.4 names screening
 *     separately from diagnosis, and this category is what a well-meaning
 *     model reaches for when told not to diagnose.
 *
 * Concern and specialty NAMES are unaffected by any of this: the model only
 * ever emits them as `{{...}}` tokens, so a clinical word inside a curated
 * name never appears as bare prose for the deny-list to catch.
 */
export const DIAGNOSTIC_DENY_LIST: readonly string[] = [
  // --- Attribution ---
  'you may have',
  'you might have',
  'you could have',
  'you probably have',
  'you seem to have',
  'you appear to have',
  'sounds like you have',
  'it sounds like you have',
  'suggests possible',
  'suggestive of',
  'indicative of',
  'consistent with',
  'points to',
  'you are experiencing',
  'you are suffering from',
  'you have been experiencing',
  // --- Diagnosis ---
  'diagnos*',
  'prognosis',
  'differential',
  'your condition',
  'likely condition',
  'the condition you',
  'clinical picture',
  'symptoms indicate',
  'symptoms suggest',
  // --- Severity / triage ---
  'mild',
  'moderate',
  'severe',
  'severity',
  'acute',
  'chronic',
  'high risk',
  'at risk of',
  'life threatening',
  'life-threatening',
  'critical',
  'urgent',
  'emergency',
  'immediate medical attention',
  // --- Probability ---
  'likely',
  'unlikely',
  'probably',
  'probability',
  'chances are',
  'most likely',
  'highly suggestive',
  // --- Treatment ---
  'medication',
  'medicine',
  'prescri*',
  'dose',
  'dosage',
  'treatment plan',
  'you need treatment',
  'you should take',
  'will cure',
  'can cure',
  'therapy will fix',
  // --- Screening / assessment ---
  'screening',
  'screen you',
  'assessment shows',
  'assessment indicates',
  'test result',
  'score indicates',
  'based on your symptoms',
];

/** `{{specialty:code}}` / `{{concern:code}}`. Codes mirror `specialties.code`/`concerns.code`: lower-case, up to 60 chars. */
export const REFERENCE_TOKEN_PATTERN = /\{\{(specialty|concern):([a-z0-9_-]{1,60})\}\}/g;

export type ReferenceType = 'specialty' | 'concern';

/** One resolved token, as returned to the client so it can substitute inline or render a chip. */
export interface ResolvedReference {
  /** The literal token as it appears in the text, e.g. `{{concern:sleep}}`. */
  token: string;
  type: ReferenceType;
  id: string;
  code: string;
  /** The curated display name — the ONLY text a client should substitute for the token. */
  label: string;
  /** Where tapping the chip goes. Always a real, resolvable destination. */
  deepLink: string;
}

export type ValidationRejection =
  | { kind: 'denied_language'; construction: string }
  | { kind: 'unresolvable_token'; token: string };

export type ProseValidation =
  | { accepted: true }
  | { accepted: false; rejection: ValidationRejection };

/** Every `{{...}}` token in `text`, in order of appearance, duplicates included. */
export function extractReferenceTokens(text: string): Array<{ token: string; type: ReferenceType; code: string }> {
  const found: Array<{ token: string; type: ReferenceType; code: string }> = [];
  // A fresh regex per call: the shared literal carries the `g` flag, and
  // `lastIndex` on a module-level regex leaks between calls.
  const pattern = new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    found.push({ token: match[0], type: match[1] as ReferenceType, code: match[2] as string });
    match = pattern.exec(text);
  }
  return found;
}

/**
 * PURE. The whole rule, with the resolved-token set handed in. Returns the
 * FIRST reason to reject, so the log line names one specific construction
 * rather than a list.
 */
export function validateProse(text: string, resolvedTokens: ReadonlySet<string>): ProseValidation {
  for (const { token } of extractReferenceTokens(text)) {
    if (!resolvedTokens.has(token)) {
      return { accepted: false, rejection: { kind: 'unresolvable_token', token } };
    }
  }

  // Tokens are stripped before the language check: `{{concern:substance_use}}`
  // must not trip the deny-list on the code inside it, and the label a client
  // substitutes is curated, not model-written.
  const withoutTokens = text.replace(new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g'), ' ');
  const padded = toPaddedNormalized(withoutTokens);

  for (const entry of DIAGNOSTIC_DENY_LIST) {
    const isStem = entry.endsWith('*');
    const matched = isStem ? containsLeftAnchored(padded, entry.slice(0, -1)) : containsPhrase(padded, entry);
    if (matched) {
      return { accepted: false, rejection: { kind: 'denied_language', construction: entry } };
    }
  }

  return { accepted: true };
}

@Injectable()
export class ResponseValidatorService {
  private readonly logger = new Logger(ResponseValidatorService.name);

  /**
   * Validates model prose and LOGS every rejection. The caller substitutes a
   * safe template on `accepted: false` — this service deliberately does not
   * return one, so the decision to fall back stays visible at the call site
   * (`search-discovery.engine.ts`) rather than hidden behind a silent swap.
   */
  validate(text: string, resolvedTokens: ReadonlySet<string>): ProseValidation {
    const result = validateProse(text, resolvedTokens);
    if (!result.accepted) {
      const detail =
        result.rejection.kind === 'denied_language'
          ? `denied construction "${result.rejection.construction}"`
          : `unresolvable reference token "${result.rejection.token}"`;
      // Server-side only. The patient sees the safe template, never this.
      this.logger.warn(`Model prose rejected — ${detail}. Excerpt: ${toLogExcerpt(text)}`);
    }
    return result;
  }
}
