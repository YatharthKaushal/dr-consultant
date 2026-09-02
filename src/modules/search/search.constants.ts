/** `audit_log.entity_type` values this module writes. */
export const SEARCH_AUDIT_ENTITY_TYPES = {
  /** One `search.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'search_config',
} as const;

export const SEARCH_ERROR_CODES = {
  /** The per-patient AI-path throttle (`search.rate_limit_per_hour`). Carries `retryAfterSeconds`, like identity's OTP throttle. */
  RATE_LIMITED: 'SEARCH_RATE_LIMITED',
  /** A `PUT /admin/search/config` body whose value fails this module's own shape check for that key. */
  CONFIG_INVALID: 'SEARCH_CONFIG_INVALID',
  /** A `PUT /admin/search/config` naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'SEARCH_CONFIG_KEY_NOT_OWNED',
} as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[keyof typeof SEARCH_ERROR_CODES];

/**
 * The `app_config` keys M-09 OWNS. `docs/MODULES.md` §7 assigns them here
 * explicitly ("Configuration lives with its owning module... mapping and
 * crisis keywords in M-09"), which is what makes `search-config.service.ts`
 * the one place allowed to WRITE `app_config` — and only for these keys.
 */
export const SEARCH_CONFIG_KEYS = {
  /** Admin-edited crisis phrase list, FR-5.6/FR-5.7. `string[]`. */
  CRISIS_KEYWORDS: 'search.crisis_keywords',
  /**
   * The emergency guidance SHOWN when a keyword fires — message plus
   * helplines. Not on the brief's original key list; added because SRS 5.2
   * requires configuration values "including... crisis keywords" to live in
   * data not code, and SRS §8 puts "emergency guidance wording" under the
   * client's clinician. Keywords that are admin-editable but whose response
   * is hard-coded would only satisfy half of each.
   */
  CRISIS_GUIDANCE: 'search.crisis_guidance',
  /** Admin-edited popular searches, FR-5.11. `Array<{ label, query }>` (bare strings are accepted and coerced). */
  POPULAR_SEARCHES: 'search.popular_searches',
  /** THE KILL SWITCH. `false` skips the model entirely and serves the deterministic matcher — same response shape either way. */
  AI_ENABLED: 'search.ai_enabled',
  /** Upper bound on ranked doctors returned by one discovery. */
  MAX_RESULTS: 'search.max_results',
  /** Per-patient AI-path throttle. SRS is silent on this; AI usage is billed to the client at actuals, so an unmetered LLM endpoint is a real cost and abuse risk. */
  RATE_LIMIT_PER_HOUR: 'search.rate_limit_per_hour',
} as const;
export type SearchConfigKey = (typeof SEARCH_CONFIG_KEYS)[keyof typeof SEARCH_CONFIG_KEYS];

export const SEARCH_CONFIG_KEY_LIST: readonly SearchConfigKey[] = Object.values(SEARCH_CONFIG_KEYS);

/**
 * *** CLINICIAN SIGN-OFF REQUIRED BEFORE LAUNCH (SRS §8). ***
 *
 * `CRISIS_KEYWORDS` below is a STARTER list written by the developer so the
 * mechanism is testable end to end. SRS §8 puts "emergency guidance wording
 * and the symptom-to-specialty mapping" under the client's qualified
 * clinician, not the developer. Ship the mechanism; the client owns the
 * wording. The list is editable from the admin panel with no release
 * (FR-5.7), which is the whole point of it living in `app_config`.
 *
 * Everything else here is the compiled-in fallback every
 * `AppConfigService.getJson`/`getNumber` read in this module passes, so a
 * missing or not-yet-seeded row degrades to a sane default rather than
 * breaking search — same discipline as `AVAILABILITY_CONFIG_FALLBACKS` and
 * `IDENTITY_APP_CONFIG_DEFAULTS`.
 */
export const SEARCH_CONFIG_FALLBACKS = {
  CRISIS_KEYWORDS: [
    // English.
    'suicide',
    'suicidal',
    'kill myself',
    'killing myself',
    'end my life',
    'ending my life',
    'take my life',
    'want to die',
    'wanna die',
    'better off dead',
    'self harm',
    'self-harm',
    'harm myself',
    'hurt myself',
    'cutting myself',
    'overdose',
    'no reason to live',
    'cant go on',
    'end it all',
    // Hindi (Devanagari).
    'आत्महत्या',
    'खुदकुशी',
    'मरना चाहता',
    'मरना चाहती',
    'जान देना',
    'जान दे दूं',
    'खुद को नुकसान',
    'जीना नहीं चाहता',
    'जीना नहीं चाहती',
    'ज़िंदगी खत्म',
    'जिंदगी खत्म',
    // Hinglish / romanised.
    'khudkushi',
    'aatmahatya',
    'atmahatya',
    'marna chahta hun',
    'marna chahti hun',
    'marna chahta hoon',
    'mar jana chahta',
    'jaan dena',
    'jaan de dunga',
    'khud ko marna',
    'jeena nahi chahta',
    'jeena nahi chahti',
    'zindagi khatam',
  ] as string[],
  /**
   * *** CLINICIAN SIGN-OFF REQUIRED BEFORE LAUNCH (SRS §8), AND THE
   * HELPLINE NUMBERS MUST BE VERIFIED CURRENT BY THE CLIENT. *** These are
   * the publicly-published Indian national services at the time of writing;
   * a stale number on a crisis screen is the single worst defect this
   * feature can ship. Editable from the admin panel with no release.
   */
  CRISIS_GUIDANCE: {
    message:
      'It sounds like you may be going through something very difficult right now. This app cannot help in an emergency, but people who can are available immediately, free, and around the clock. Please reach out to one of the services below, or ask someone you trust to stay with you.',
    helplines: [
      { name: 'Tele-MANAS (Government of India mental health helpline)', phone: '14416', availability: '24x7' },
      { name: 'KIRAN mental health helpline', phone: '1800-599-0019', availability: '24x7' },
      { name: 'National emergency number', phone: '112', availability: '24x7' },
    ],
  } as { message: string; helplines: Array<{ name: string; phone: string; availability?: string }> },
  POPULAR_SEARCHES: [
    { label: 'Trouble sleeping', query: 'i cannot sleep at night' },
    { label: 'Feeling anxious', query: 'i feel anxious and restless' },
    { label: 'Low mood', query: 'i feel low and sad all the time' },
    { label: 'Stress at work', query: 'work stress and pressure' },
    { label: 'Quitting alcohol', query: 'i want to stop drinking alcohol' },
    { label: 'Child not coping', query: 'my child is not coping at school' },
  ] as Array<{ label: string; query: string }>,
  AI_ENABLED: true,
  MAX_RESULTS: 20,
  RATE_LIMIT_PER_HOUR: 30,
} as const;

/**
 * What `search.seed.ts` inserts into `app_config` on first run
 * (`ON CONFLICT DO NOTHING` — never overwrites an admin-tuned value), keyed
 * exactly as `IDENTITY_APP_CONFIG_DEFAULTS` is.
 */
export const SEARCH_APP_CONFIG_DEFAULTS: Record<SearchConfigKey, unknown> = {
  [SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS]: SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS,
  [SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE]: SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE,
  [SEARCH_CONFIG_KEYS.POPULAR_SEARCHES]: SEARCH_CONFIG_FALLBACKS.POPULAR_SEARCHES,
  [SEARCH_CONFIG_KEYS.AI_ENABLED]: SEARCH_CONFIG_FALLBACKS.AI_ENABLED,
  [SEARCH_CONFIG_KEYS.MAX_RESULTS]: SEARCH_CONFIG_FALLBACKS.MAX_RESULTS,
  [SEARCH_CONFIG_KEYS.RATE_LIMIT_PER_HOUR]: SEARCH_CONFIG_FALLBACKS.RATE_LIMIT_PER_HOUR,
};

/**
 * DI token for the `SearchAiPort` implementation, bound in
 * `search.module.ts` — mirrors `availability.constants.ts`'s
 * `BUSY_INTERVAL_PROVIDER` and `shared/auth`'s `AUTH_CONTEXT_RESOLVER`.
 *
 * *** POST-MERGE WIRING (the coordinator's one job here) ***
 * Today this is bound to `SearchAiNullProvider` — a null-object that reports
 * unavailable, so the whole module runs deterministically with no AI module
 * present. Once `modules/ai` is merged, change ONE entry in
 * `search.module.ts`:
 *
 *   imports:   [..., AiModule]
 *   providers: [..., { provide: SEARCH_AI_PORT, useExisting: AiFacade }]
 *
 * and delete the `SearchAiNullProvider` binding. `AiFacade` already satisfies
 * `SearchAiPort` structurally (see `search-ai.contract.ts`). Nothing else in
 * this module, and none of its tests, changes.
 */
export const SEARCH_AI_PORT = Symbol('SEARCH_AI_PORT');

/**
 * How far ahead ranking looks for a doctor's earliest bookable slot. Not
 * admin-configurable: it is a ranking-signal horizon, not a booking policy —
 * how far a patient may actually book is `scheduling.booking_horizon_days`,
 * owned by M-07, and `getEarliestBookableSlots` is bounded by that anyway.
 */
export const SEARCH_AVAILABILITY_LOOKAHEAD_DAYS = 14;

/** Ceiling on the candidate pool ranking pulls before filtering — bounds the availability batch and the ranking sort. */
export const SEARCH_CANDIDATE_POOL_LIMIT = 60;

/** Hard cap on `GET /search/recent`, and its default. FR-5.11 gives no number; this is a chip row, not a history screen. */
export const SEARCH_RECENT_LIMIT = 10;

/**
 * FR-5.8: "The interface states plainly that the module recommends whom to
 * consult and does not screen, diagnose or make clinical decisions."
 *
 * Returned on EVERY discovery response — crisis, zero-result and ordinary
 * alike — so no client can render a result set without it, and all three of
 * the competing UI concepts show the same words. Compiled in rather than
 * admin-editable ON PURPOSE: this is the sentence SRS §2.4 obliges the
 * product to say, not a piece of copy to tune. If the client's counsel wants
 * different wording, that is a code change with a review, which is the
 * correct amount of friction for it.
 */
export const SEARCH_DISCLAIMER =
  'This helps you find the right kind of professional to talk to. It does not screen, diagnose, or make any clinical decision, and it is not a substitute for advice from a qualified doctor.';

/** Used whenever model prose is unavailable or rejected. Navigation only, no clinical language, tokens resolved from live catalogue data. */
export const SEARCH_TEMPLATE_GUIDANCE = {
  /** `{{...}}` tokens are appended by `search-discovery.engine.ts` from the actually-matched specialties. */
  withMatches: 'Based on what you described, these professionals are the closest fit:',
  noMatches:
    'We could not match that to a concern yet. You can browse by concern or by the kind of professional you would like to talk to.',
} as const;
