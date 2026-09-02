/**
 * Every provider this build can actually talk to. The single runtime source
 * of truth: `agent_profiles.provider` is validated against it at the DTO
 * layer, and `LlmProviderRegistry` is typed `Record<ProviderCode, ...>` so
 * TypeScript refuses to compile a build that adds a code here without also
 * registering an adapter for it.
 *
 * `openai_compatible` is not "OpenAI" — it is the whole OpenAI-wire-format
 * family. OpenRouter, Groq, Together, DeepSeek, xAI, Fireworks and
 * Alibaba/DashScope are all reached by pointing `agent_profiles.base_url` at
 * them, not by adding a code here. Add a code only for a provider with a
 * genuinely different wire protocol.
 *
 * Adding one is three edits and no migration (see
 * `agent-profiles.schema.ts`): an entry here, an adapter class, a line in
 * `llm-provider.registry.ts`.
 */
export const PROVIDER_CODES = ['openai_compatible', 'anthropic', 'google_genai', 'bedrock'] as const;
export type ProviderCode = (typeof PROVIDER_CODES)[number];

/**
 * The normalised failure taxonomy every `ProviderErrorClassifier` maps its
 * vendor's error shape onto. The whole point of the module is that
 * `ai-rotation.service.ts` never sees a vendor error — it sees one of these,
 * and its policy table (rotate / retry / fail fast) is written against them
 * alone.
 *
 * The distinctions here are the ones that change what rotation DOES, and no
 * others:
 *   - `invalid_key`        — this key is wrong or revoked. Rotate; a long
 *                            cooldown, because it will not fix itself.
 *   - `insufficient_quota` — the account behind this key is out of credit or
 *                            over its hard cap. Rotate; a long cooldown.
 *                            Deliberately NOT merged with `rate_limited`:
 *                            both arrive as HTTP 429 from OpenAI-compatible
 *                            hosts, but a per-minute limit clears in seconds
 *                            and an exhausted balance does not. Treating them
 *                            alike would either hammer a dead account or
 *                            park a healthy key for an hour.
 *   - `rate_limited`       — slow down. Rotate; cooldown from the vendor's own
 *                            `Retry-After` when it gives one.
 *   - `context_length`     — the prompt does not fit. Do NOT rotate: it will
 *                            not fit on the next provider either.
 *   - `model_unavailable`  — this model/deployment is not reachable through
 *                            this credential (404, decommissioned, no access).
 *                            Rotate.
 *   - `content_filtered`   — the vendor's safety layer refused. Do NOT
 *                            rotate: every mainstream provider would refuse
 *                            the same input, and retrying it across an
 *                            account the client pays for buys nothing.
 *   - `timeout`            — no answer in time. One retry on the SAME key
 *                            (it is probably fine), then rotate.
 *   - `transient`          — 5xx, connection reset, overloaded. Same as
 *                            `timeout`.
 *   - `unknown`            — unrecognised. Treated as `transient`'s sibling:
 *                            rotate, short cooldown. Never assumed benign.
 */
export const LLM_FAILURE_KINDS = [
  'invalid_key',
  'insufficient_quota',
  'rate_limited',
  'context_length',
  'model_unavailable',
  'content_filtered',
  'timeout',
  'transient',
  'unknown',
] as const;
export type LlmFailureKind = (typeof LLM_FAILURE_KINDS)[number];

/** `audit_log.entity_type` values this module writes. */
export const AI_AUDIT_ENTITY_TYPES = {
  AGENT_PROFILE: 'agent_profile',
  AGENT_CREDENTIAL: 'agent_credential',
} as const;

export const AI_ERROR_CODES = {
  /** 404. No `agent_profiles` row with that id. */
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  /** 409. `agent_profiles.name` is unique — the admin panel lists profiles by name, so two identical ones would be unusable. */
  PROFILE_NAME_TAKEN: 'PROFILE_NAME_TAKEN',
  /** 409. Deleting a profile that still has credentials, without `confirmDeleteCredentials: true`. See `agent-profile.service.ts#adminDelete`. */
  PROFILE_HAS_CREDENTIALS: 'PROFILE_HAS_CREDENTIALS',
  /** 404. */
  CREDENTIAL_NOT_FOUND: 'CREDENTIAL_NOT_FOUND',
  /** 409. `(profile_id, label)` is unique — the label is the ONLY way an admin can tell two keys apart, since they can never see the keys themselves. */
  CREDENTIAL_LABEL_TAKEN: 'CREDENTIAL_LABEL_TAKEN',
  /**
   * 503. Every candidate credential was tried and every one failed (or there
   * were none to try). 503 rather than 500: nothing is broken in OUR service,
   * a third party we depend on is unusable right now, and the condition is
   * expected to clear on its own once a cooldown lapses or the client tops up
   * their provider account. 503 is also what tells the caller (the symptom-
   * search module) to degrade gracefully rather than surface a crash.
   */
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  /**
   * 400. The REQUEST cannot be served by any provider — the prompt exceeds the
   * model's context window (`context_length`), or the vendor's safety layer
   * refused it (`content_filtered`). Distinct from `AI_UNAVAILABLE` and
   * deliberately 4xx: rotating would fail identically everywhere, so this is
   * the caller's input to fix, not our availability to wait out.
   */
  AI_REQUEST_INVALID: 'AI_REQUEST_INVALID',
  /**
   * 503. An adapter exists for the provider but this build cannot construct a
   * working client for it — today only `BedrockAdapter`, which is a
   * deliberate stub (see its file). Distinct from `AI_UNAVAILABLE`: we never
   * even attempted a call, so there is nothing to wait out and no key to
   * blame; an operator has to change the deployment.
   */
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  /**
   * 400. The stored `agent_profiles.provider` is not in `PROVIDER_CODES`.
   * Unreachable through the API (the DTO validates it) — reachable through a
   * hand-written INSERT or a dump restored from a build that knew a provider
   * this one does not. 4xx because it is a fix-the-data problem the caller
   * can act on, not a transient outage. Rotation does not throw this: it
   * skips such a profile and carries on with the rest.
   */
  UNSUPPORTED_PROVIDER: 'UNSUPPORTED_PROVIDER',
} as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

/**
 * `app_config` keys this module reads (`AppConfigService.getNumber(key,
 * fallback)`), same three-level pattern as
 * `AVAILABILITY_CONFIG_FALLBACKS`. All four are genuinely new keys —
 * `docs/erd.sql`'s example key list does not anticipate an LLM gateway.
 *
 * These are in `app_config` rather than env because they are operational
 * dials an admin should be able to turn during an incident ("provider X is
 * flapping, lengthen the cooldown") without a release — SRS 6.6. The
 * encryption key is the opposite kind of value and correctly lives in env.
 */
export const AI_CONFIG_KEYS = {
  /** Cooldown applied when the vendor gives us no `Retry-After` of its own. */
  DEFAULT_COOLDOWN_SECONDS: 'ai.default_cooldown_seconds',
  /** Ceiling on ANY cooldown, including a vendor-supplied one — a buggy or hostile `Retry-After` must not park a working key for a week. */
  MAX_COOLDOWN_SECONDS: 'ai.max_cooldown_seconds',
  /** Cooldown for `invalid_key`/`insufficient_quota` — failures that will not fix themselves on a per-minute timescale. */
  HARD_FAILURE_COOLDOWN_SECONDS: 'ai.hard_failure_cooldown_seconds',
  /** Per-call timeout when `agent_profiles.config.timeoutMs` does not set one. */
  REQUEST_TIMEOUT_MS: 'ai.request_timeout_ms',
} as const;

/** Compiled-in fallbacks, used when the `app_config` row is missing or malformed (`AppConfigService`'s own contract). */
export const AI_CONFIG_FALLBACKS = {
  DEFAULT_COOLDOWN_SECONDS: 60,
  MAX_COOLDOWN_SECONDS: 3_600,
  HARD_FAILURE_COOLDOWN_SECONDS: 900,
  REQUEST_TIMEOUT_MS: 30_000,
} as const;

/**
 * Base delay for the ONE same-credential retry a `transient`/`timeout`
 * failure earns, jittered in `ai-rotation.service.ts`. Compiled in rather
 * than an `app_config` key on purpose: it is a sub-second implementation
 * detail of the retry loop, not an operational dial anyone would sensibly
 * turn from an admin panel, and every value in `app_config` costs a
 * (memoized) query and a row to explain.
 */
export const AI_TRANSIENT_RETRY_BASE_MS = 250;

/** Upper bound on the jittered retry delay, so a request can never stall on backoff. */
export const AI_TRANSIENT_RETRY_MAX_MS = 1_000;

/**
 * Hard ceiling on how many credentials one `completeStructured` call will
 * attempt, however many are configured. Without it, a client with fifty
 * dead keys turns one search request into fifty upstream calls and a
 * multi-minute hang; the caller gets `AI_UNAVAILABLE` far sooner and the
 * client is not billed for the tail. Cooldowns mean the skipped ones are
 * tried on subsequent requests anyway.
 */
export const AI_MAX_ATTEMPTS_PER_REQUEST = 6;
