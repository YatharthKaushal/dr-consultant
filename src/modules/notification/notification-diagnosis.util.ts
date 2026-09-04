/**
 * *** FR-16.2: "NOTIFICATION TEXT NEVER NAMES A DIAGNOSIS." ***
 *
 * SRS 6.2 repeats it under Privacy, and `notifications.body`'s own schema
 * comment repeats it a third time: "the copy AS SENT ... MUST NOT name a
 * diagnosis, FR-16.2." A push notification renders on a LOCK SCREEN, in
 * front of whoever is holding the phone. That is the harm being prevented,
 * and it is why this is a rule enforced in the service rather than a style
 * note in a template guide.
 *
 * ===========================================================================
 * HOW THE RULE IS ENFORCED, AND WHAT EACH LAYER ACTUALLY GUARANTEES
 * ===========================================================================
 *
 * Three layers, in decreasing order of strength. Be clear about which is
 * which: only the first two are guarantees. The third is a heuristic, and
 * pretending otherwise would be the dangerous part.
 *
 * LAYER 1 — STRUCTURAL: THERE IS NO PROSE CHANNEL. `NotificationRequest`
 *   (`notification.contract.ts`) has no `title` and no `body`. A calling
 *   module physically cannot hand this module a sentence. Copy comes only
 *   from the admin-editable template set. This is a GUARANTEE, enforced by
 *   the type system and by the frozen port M-13 is built against: no caller
 *   can write "Your diabetes review is due" because there is no argument to
 *   write it into.
 *
 * LAYER 2 — STRUCTURAL: DECLARED PLACEHOLDERS ONLY. The only caller-supplied
 *   text that can reach a body is a `variables` value, and a value is
 *   substituted ONLY where its name appears as a `{{placeholder}}` in that
 *   template's own copy (`notification-template.util.ts#renderTemplate`).
 *   Passing `{ diagnosis: 'type 2 diabetes' }` to `booking_confirmed` is a
 *   no-op, because `booking_confirmed` has no `{{diagnosis}}`. This too is a
 *   GUARANTEE: an undeclared variable is dropped, not screened.
 *
 *   Together, layers 1 and 2 mean a diagnosis can only reach a notification
 *   through one of exactly two doors: an ADMIN wrote it into template copy,
 *   or a caller put it in a variable a template already declares (today only
 *   `document_rejected`'s `{{reason}}` is genuinely free-form).
 *
 * LAYER 3 — HEURISTIC: THIS FILE. Both doors are screened, at both ends:
 *   - on admin WRITE (`notification-template.service.ts`), where a rejection
 *     is a 409 naming the offending construction, so a human sees it and
 *     re-words. This is where over-blocking is cheap.
 *   - on SEND (`notification.service.ts`), against the FULLY RENDERED title
 *     and body — the exact bytes that would be stored in `notifications.body`
 *     and pushed. A hit suppresses the notification entirely (no row, no
 *     push) and logs. This catches template copy that predates a rule change
 *     and variable values, which no write-time check can see.
 *
 * ===========================================================================
 * *** WHAT THIS DENY-LIST CANNOT DO. ***
 * ===========================================================================
 *
 * It is a curated list of English constructions and condition names. It is
 * NOT a guarantee and must never be described as one:
 *
 *   - A condition nobody listed passes. There are tens of thousands of
 *     diagnoses and this file names on the order of sixty.
 *   - Hindi and Devanagari condition names are NOT covered. `normalize()`
 *     below preserves Devanagari so such entries would match if added, but
 *     none are listed — the clinical vocabulary is the client's clinician's
 *     to author (SRS §8), not the developer's to guess.
 *   - A misspelling, a transliteration ("sugar" for diabetes, "BP" for
 *     hypertension — both everyday Indian usage) or a euphemism passes.
 *   - A description without a name passes: "your recent test result" names
 *     no diagnosis by this list's reckoning but can still be revealing.
 *
 * The honest summary is: LAYERS 1 AND 2 GUARANTEE THAT NO CALLING MODULE CAN
 * INJECT PROSE. Layer 3 reduces, but does not eliminate, the chance that an
 * admin or a declared variable smuggles a condition name through. The
 * durable control on layer 3 is the SRS §8 rule that clinical wording is
 * reviewed by the client's clinician before launch — this list makes the
 * common cases fail loudly in the meantime.
 *
 * *** THE LIST IS COMPILED IN, AND DELIBERATELY NOT ADMIN-EDITABLE. ***
 * Every other piece of copy in this module lives in `app_config` so it can
 * change without a release. This does not, because FR-16.2 is a hard rule
 * and a rule an admin can edit is a rule an admin can switch off. The one
 * `app_config` key M-08 owns is `notifications.templates`; there is no
 * `notifications.diagnosis_terms`.
 */

/** U+0900..U+097F, the Devanagari block — preserved by `normalize`, so a future Devanagari entry would work. */
const DEVANAGARI_RANGE = 'ऀ-ॿ';

/** Zero-width joiner/non-joiner and the Devanagari nukta: typing variations, not meaning. */
const INVISIBLE_AND_NUKTA_PATTERN = /[‌‍़]/g;

/** ASCII, typographic and modifier-letter apostrophes — DELETED, not spaced, so "can't" folds onto "cant". */
const APOSTROPHE_PATTERN = /['’ʼ]/g;

/** Latin combining marks only. Devanagari matras are combining marks too and stripping them would fold different Hindi words onto each other. */
const LATIN_COMBINING_MARKS_PATTERN = /[̀-ͯ]/g;

/** Anything that is not a letter, a digit or a Devanagari codepoint becomes a space. */
const NON_WORD_PATTERN = new RegExp(`[^\\p{L}\\p{N}${DEVANAGARI_RANGE}]+`, 'gu');

/**
 * NFKC -> lower case -> drop invisibles/nukta -> delete apostrophes -> strip
 * Latin accents -> non-word to space -> collapse -> trim.
 *
 * Deliberately a LOCAL copy of the same pipeline `modules/search`'s
 * `search-text.util.ts` uses, not an import of it: `backend/README.md` §2
 * forbids deep imports across module folders, and a shared text utility is
 * exactly the kind of thing that turns into an implicit coupling between two
 * modules with different reasons to change. The pipelines agree today
 * because the input problem is the same (English/Hindi/Hinglish typed by
 * phone keyboards); they are free to diverge.
 *
 * The property that matters: punctuation, case, accents and hyphens cannot
 * be used to slip past an entry. "COVID-19", "covid 19" and "Covid‑19" all
 * normalise to `covid 19`.
 */
export function normalize(text: string): string {
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

/** The normalised text wrapped in single spaces, so a space-delimited `includes()` is a word-boundary test. */
function pad(text: string): string {
  return ` ${normalize(text)} `;
}

/**
 * *** THE DENY-LIST. ***
 *
 * An entry ending in `*` is a STEM: word-bounded on the left, open on the
 * right, so one `diagnos*` covers diagnose/diagnosis/diagnosed/diagnostic/
 * diagnoses. Every other entry is word-bounded on BOTH sides, so `aids` does
 * not fire inside "braids" and `cancer` does not fire inside "cancerous"
 * (which is why the stem form is used where inflection matters).
 *
 * Scoped to NAMING A DIAGNOSIS, and nothing wider. This is the significant
 * difference from `modules/search`'s `DIAGNOSTIC_DENY_LIST`, which also
 * blocks severity, urgency, probability and treatment language because it is
 * guarding MODEL PROSE shown instead of search results. Notification copy has
 * legitimate business with most of those words:
 *
 *   - `prescription_ready` must be able to say "prescription".
 *   - `red_flag_alert` is an urgent safety alert to a doctor; "urgent",
 *     "review" and "flagged" are the point of it.
 *   - `checkin_due` may reasonably say "medication".
 *
 * Blocking those would not serve FR-16.2, it would just make the required
 * templates unwritable. FR-16.2 is about naming a DIAGNOSIS.
 */
export const DIAGNOSIS_DENY_LIST: readonly string[] = [
  /* --- The act, and the words for it -------------------------------------
   * Naming the act is as much a breach as performing it: a patient told
   * "your diagnosis is ready" has been given a clinical frame on a lock
   * screen even though no condition was named. */
  'diagnos*',
  'prognos*',
  'clinical impression',
  'provisional impression',
  'icd 10',
  'icd 11',

  /* --- Attribution: a condition attached to a person ----------------------
   * NOT bare "you have": `instant_request`'s own default copy says "You have
   * {{expiresInSeconds}} seconds to accept", and a rule that makes the
   * required templates unwritable is a rule that gets deleted. The hedged
   * forms below carry the clinical claim; the bare verb does not. */
  'you may have',
  'you might have',
  'you could have',
  'you probably have',
  'you seem to have',
  'you appear to have',
  'you are suffering from',
  'suffering from',
  'you have been diagnosed',
  'test came back positive',
  'tested positive',
  'positive for',
  'your condition',
  'his condition',
  'her condition',
  'their condition',
  'the condition you',
  'medical condition',
  'underlying condition',
  'pre existing condition',
  'test results show',
  'your results show',
  'your report shows',

  /* --- Named conditions ---------------------------------------------------
   * A STARTER SET, and the part of this file that is a heuristic rather than
   * a guarantee — see the header. Chosen for what a primary/secondary care
   * platform in India actually sees, weighted towards conditions whose
   * disclosure on a lock screen is most damaging (HIV, TB, cancer, mental
   * health) rather than towards completeness, which is unreachable.
   *
   * *** CLINICIAN SIGN-OFF (SRS §8). *** "All clinical content... must be
   * reviewed and approved by a qualified clinician before launch." That
   * applies to this list as much as to the templates it guards. */
  'diabet*',
  'hypertens*',
  'hypotens*',
  'cancer',
  'cancers',
  'carcinom*',
  'malignan*',
  'tumour',
  'tumours',
  'tumor',
  'tumors',
  'leukaem*',
  'leukem*',
  'lymphom*',
  'hiv',
  'aids',
  'tubercul*',
  'hepatit*',
  'asthma',
  'asthmatic',
  'copd',
  'pneumon*',
  'bronchit*',
  'covid',
  'coronavirus',
  'dengue',
  'malaria',
  'typhoid',
  'chikungunya',
  'cholera',
  'jaundice',
  'anaem*',
  'anem*',
  'thyroid',
  'hypothyroid*',
  'hyperthyroid*',
  'depression',
  'depressive',
  'anxiety disorder',
  'panic disorder',
  'bipolar',
  'schizophren*',
  // NOT `psychos*`: that stem also swallows "psychosocial", which is
  // ordinary, non-clinical Care Hub language a follow-up template may
  // legitimately use. The two inflections are listed instead.
  'psychosis',
  'psychoses',
  'psychotic',
  'dementia',
  'alzheim*',
  'parkinson',
  'parkinsons',
  'epilep*',
  'seizure disorder',
  'migraine',
  'migraines',
  'arthrit*',
  'osteoporos*',
  'psorias*',
  'eczema',
  'dermatit*',
  'pcos',
  'pcod',
  'endometrios*',
  'infertility',
  'stroke',
  'heart attack',
  'myocardial infarction',
  'cardiac arrest',
  'heart failure',
  'kidney failure',
  'renal failure',
  'cirrhos*',
  'gastrit*',
  'peptic ulcer',
  'ulcerative colitis',
  'crohns',
  'obesity',
  'obese',
  // NOT the abbreviations `std`/`sti`: "STD code" is everyday Indian
  // telephony usage and could appear in a support-contact variable, and both
  // are three letters, which is the same initials problem `tb` has below.
  'sexually transmitted',
  'venereal',
  'syphilis',
  'gonorrh*',
  'chlamydia',
  'herpes',
];

/**
 * Entries deliberately CONSIDERED AND LEFT OUT, so the next person does not
 * "fix" the omission and break sending:
 *
 *   'tb'        — two letters, word-bounded, and a `{{doctorName}}` of
 *                 "Dr TB Sharma" normalises to " dr tb sharma " and would
 *                 suppress that patient's every booking confirmation. Covered
 *                 by `tubercul*` instead, at the cost of missing the
 *                 abbreviation.
 *   'ibs'       — same initials problem, far lower disclosure harm.
 *   'bp'        — everyday Indian shorthand for hypertension, and also two
 *                 letters. Unusable for the same reason.
 *   'sugar'     — everyday Indian shorthand for diabetes, and an ordinary
 *                 English noun. Unusable without a context model.
 *   'pregnan*'  — a condition, but not a diagnosis; blocking it would make
 *                 legitimate obstetric care-plan copy unwritable. Noted
 *                 because it IS a lock-screen disclosure risk under SRS 6.2
 *                 even though it is out of FR-16.2's scope.
 *   'anxiety'   — bare, without "disorder", it is ordinary English and also
 *                 a navigation CONCERN name in M-09. The disorder form is
 *                 listed; the bare word is not.
 *
 * Each is a KNOWN, ACCEPTED false negative. There is no clever fix at this
 * layer — the fix is layers 1 and 2, which is why the header spends its
 * length on them rather than on this list.
 */

/** What tripped the screen. `construction` is the deny-list entry, for a server-side log — never returned to any client. */
export interface DiagnosisScreening {
  clean: boolean;
  construction: string | null;
}

const CLEAN: DiagnosisScreening = { clean: true, construction: null };

/**
 * PURE. Screens one piece of text and returns the FIRST entry it trips, so a
 * log line names one specific construction rather than a list.
 *
 * Never throws, never mutates, and has no I/O — which is why almost every
 * test for FR-16.2 needs no mocking at all.
 */
export function screenForDiagnosis(text: string): DiagnosisScreening {
  const padded = pad(text);
  if (padded.trim().length === 0) return CLEAN;

  for (const entry of DIAGNOSIS_DENY_LIST) {
    const isStem = entry.endsWith('*');
    const needle = normalize(isStem ? entry.slice(0, -1) : entry);
    if (needle.length === 0) continue;

    // Stem: word boundary on the LEFT only, so the word may continue.
    // Exact: word boundary on BOTH sides.
    const matched = isStem ? padded.includes(` ${needle}`) : padded.includes(` ${needle} `);
    if (matched) return { clean: false, construction: entry };
  }

  return CLEAN;
}

/**
 * Screens several pieces at once — the title and body of a rendered
 * notification, plus every string reachable in its deep-link payload.
 *
 * Each piece is screened SEPARATELY rather than concatenated: joining them
 * could manufacture a phrase that spans a boundary ("...your" + "condition
 * is stable") and report a construction that appears in neither. Screening
 * separately never invents a hit, only ever misses a cross-boundary one —
 * and a cross-boundary hit is not text anyone reads as one sentence anyway.
 */
export function screenAllForDiagnosis(pieces: readonly string[]): DiagnosisScreening {
  for (const piece of pieces) {
    const result = screenForDiagnosis(piece);
    if (!result.clean) return result;
  }
  return CLEAN;
}

/**
 * Work cap for `collectStrings`, counted in NODES VISITED rather than in
 * depth.
 *
 * *** A DEPTH CAP WAS A HOLE, NOT A BOUND. *** This was `depth > 6 -> return
 * []`, on the reasoning that "deep-link payloads are flat by nature". They
 * are — right up until someone makes one that is not: a payload of
 * `{a:{b:{c:{d:{e:{f:{g:'you have diabetes'}}}}}}}` returned NO strings, so
 * the screen passed it, and the phrase was written to `deep_link_data`,
 * projected back to the client by `notification.mapper.ts` and put in the FCM
 * `data` block. Nesting was a one-line way around the send-time screen.
 *
 * A node budget bounds the same denial-of-service shape without making
 * depth the thing that hides text, and the walk below is ITERATIVE, so deep
 * nesting cannot overflow the stack either. Cycles are handled by identity
 * (`seen`) rather than by running out of depth — the old walk terminated on a
 * self-referential object only by re-collecting the same strings six times
 * over.
 */
const MAX_DEEP_LINK_NODES = 10_000;

/**
 * Every string value reachable in a deep-link payload, so the screen covers
 * it too.
 *
 * `deepLinkData` is stored on the row and handed to the client, and the FCM
 * `data` block is readable by the app before the user unlocks anything. A
 * payload is normally ids and screen names, so screening it is nearly
 * free — but "nearly free" is the wrong reason. The right one is that
 * FR-16.2 says a NOTIFICATION must not name a diagnosis, and the deep-link
 * payload is part of the notification.
 *
 * Object KEYS are collected as well as values: `{ diabetes: true }` names a
 * diagnosis just as surely as `{ tag: 'diabetes' }` does.
 */
export function collectStrings(value: unknown): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  let budget = MAX_DEEP_LINK_NODES;

  while (pending.length > 0 && budget > 0) {
    budget -= 1;
    const current = pending.pop();

    if (typeof current === 'string') {
      found.push(current);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    // A structure that points back at itself is walked once, not six times.
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      found.push(key);
      pending.push(entry);
    }
  }

  return found;
}
