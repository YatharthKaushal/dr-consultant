/**
 * Text normalisation shared by the crisis gate, the deterministic concern
 * matcher and the response validator — PURE FUNCTIONS, no I/O, no config,
 * no DI. Everything downstream of the model is explainable because it starts
 * here: the same input always normalises to the same string.
 *
 * FR-5.1 accepts "English, Hindi or mixed Hindi-English, including common
 * synonyms and informal phrasing", so normalisation has to survive three
 * scripts-worth of typing habits at once.
 *
 * THE NORMALISATION PIPELINE, in order:
 *   1. NFKC — folds compatibility forms (full-width Latin, ligatures) onto
 *      their canonical equivalents.
 *   2. Lower case — a no-op for Devanagari, which is unicameral.
 *   3. Drop ZWJ/ZWNJ (U+200C/U+200D) and the Devanagari nukta (U+093C).
 *      These are typing variations, not meaning: "ज़िंदगी" and "जिंदगी" are
 *      the same word to every Hindi keyboard's user, and a crisis list that
 *      only matched one spelling would be a safety hole.
 *   4. DELETE apostrophes rather than splitting on them, so a contraction
 *      folds onto its unapostrophised spelling: "can't" -> "cant", "I'm" ->
 *      "im". Both spellings are typed constantly, and a curated list can
 *      only reasonably carry one of them. All three forms are handled —
 *      ASCII ' (U+0027), the right single quote ' (U+2019) that phone
 *      keyboards autocorrect to, and the modifier letter apostrophe ʼ
 *      (U+02BC) — because which one arrives depends on the keyboard, not on
 *      the person. Without this, the crisis keyword "cant go on" would never
 *      fire on "I can't go on", which is how it was found.
 *   5. Strip Latin combining diacritics ONLY — the U+0300..U+036F block,
 *      after an NFD decomposition. Deliberately scoped: Devanagari matras
 *      (U+0900..U+097F) are combining marks too, and stripping them would
 *      turn "आत्महत्या" into "आतमहतया" — a lossy fold that collapses
 *      genuinely different Hindi words onto each other. Latin accents carry
 *      no such load in this corpus, so folding them is free.
 *   6. Every character that is not a letter, digit or Devanagari codepoint
 *      becomes a space; runs of whitespace collapse to one; trim.
 *
 * Steps 4 and 6 together are what make matching punctuation-proof: "I can't
 * sleep!!" and "i cant sleep" normalise identically.
 */

/** U+0900..U+097F, the Devanagari block. */
const DEVANAGARI_PATTERN = /[ऀ-ॿ]/;

/** Zero-width joiner/non-joiner and the Devanagari nukta — typing variations, dropped before anything else looks at the string. */
const INVISIBLE_AND_NUKTA_PATTERN = /[‌‍़]/g;

/** ASCII, typographic and modifier-letter apostrophes — DELETED, not spaced, so "can't" folds onto "cant". See step 4 above. */
const APOSTROPHE_PATTERN = /['’ʼ]/g;

/** Combining Diacritical Marks (Latin). Deliberately NOT the Devanagari combining range — see the pipeline note above. */
const LATIN_COMBINING_MARKS_PATTERN = /[̀-ͯ]/g;

/** Anything that is not a Unicode letter, a digit or a Devanagari codepoint. */
const NON_WORD_PATTERN = /[^\p{L}\p{N}ऀ-ॿ]+/gu;

/**
 * Function words that carry no matching signal in any of the three input
 * forms. Used ONLY to decide how much of a curated match phrase a query has
 * to cover (`concern-matcher.service.ts`) — never to edit the query itself,
 * and never by the crisis gate, where every word of a curated phrase counts.
 */
export const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  // English.
  'a', 'an', 'and', 'am', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'get', 'getting', 'had', 'has', 'have', 'i', 'im', 'in', 'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on',
  'or', 'so', 'that', 'the', 'they', 'this', 'to', 'too', 'very', 'was', 'we', 'with', 'you', 'your',
  // Hinglish / romanised Hindi function words.
  'aur', 'bahut', 'bhi', 'ho', 'hoon', 'hu', 'hun', 'hai', 'hain', 'ka', 'ke', 'ki', 'ko', 'kuch', 'lag',
  'lagta', 'lagti', 'main', 'mein', 'mera', 'meri', 'nahi', 'nahin', 'par', 'raha', 'rahi', 'se', 'wo', 'ye',
  // Hindi (Devanagari) function words.
  'और', 'का', 'के', 'की', 'को', 'कुछ', 'है', 'हैं', 'हूँ', 'हूं', 'में', 'मेरा', 'मेरी', 'मुझे', 'नहीं', 'पर', 'से', 'ये', 'वो',
]);

/** True when `text` contains at least one Devanagari codepoint. */
export function containsDevanagari(text: string): boolean {
  return DEVANAGARI_PATTERN.test(text);
}

/** The full pipeline described in this file's doc comment. Returns a space-separated, punctuation-free, lower-cased string. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(INVISIBLE_AND_NUKTA_PATTERN, '')
    .replace(APOSTROPHE_PATTERN, '')
    .normalize('NFD')
    .replace(LATIN_COMBINING_MARKS_PATTERN, '')
    .normalize('NFC')
    .replace(NON_WORD_PATTERN, ' ')
    .trim();
}

/** `normalizeText` split on spaces. Empty input yields an empty array, never `['']`. */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * The normalised text wrapped in single spaces, so a space-delimited
 * `includes()` is a word-boundary test: `" harmony "` does not contain
 * `" harm "`, while `" i want to die "` does contain `" die "`. Every
 * boundary-sensitive match in this module goes through this.
 */
export function toPaddedNormalized(text: string): string {
  return ` ${normalizeText(text)} `;
}

/**
 * Word-boundary phrase match on both sides. `phrase` may be multi-word; both
 * sides are normalised first, so the caller can pass raw admin-entered text.
 * Returns false for an empty phrase rather than matching everything.
 */
export function containsPhrase(paddedHaystack: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (normalizedPhrase.length === 0) return false;
  return paddedHaystack.includes(` ${normalizedPhrase} `);
}

/**
 * Word-boundary on the LEFT, open on the right: `phrase` must begin at a word
 * boundary but may be followed by more letters of the same word. It can never
 * fire from INSIDE a word, which is the property that matters.
 *
 * Two callers, same operation, different reasons:
 *   - the crisis gate, for Devanagari only. Hindi inflects by SUFFIX
 *     ("मरना" / "मरने" / "मरूं"), so a both-sides match would miss the very
 *     phrasings a crisis list most needs to catch. See
 *     `crisis-detector.service.ts` for the full argument.
 *   - the response validator's `stem*` deny-list entries, so one `diagnos*`
 *     entry covers diagnose/diagnosis/diagnostic/diagnosed.
 */
export function containsLeftAnchored(paddedHaystack: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (normalizedPhrase.length === 0) return false;
  return paddedHaystack.includes(` ${normalizedPhrase}`);
}

/** Collapses a query to a bounded excerpt safe to put in a server-side log line. Never returned to a client. */
export function toLogExcerpt(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}
