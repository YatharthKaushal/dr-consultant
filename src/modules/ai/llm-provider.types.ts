import type { ZodSchema } from 'zod';
import type { LlmFailureKind, ProviderCode } from './ai.constants';

/**
 * Everything an adapter needs for one call, already resolved. Nothing here is
 * a row, an id or a DTO: the adapter layer knows about providers and prompts
 * and nothing about this module's tables, so an adapter is unit-testable
 * without a database and a new provider cannot accidentally grow a dependency
 * on our schema.
 *
 * `apiKey` is plaintext and lives only for the duration of one call —
 * decrypted by `ai-rotation.service.ts` immediately before the attempt and
 * never stored, logged or returned. See `ai-crypto.service.ts`.
 */
export interface LlmCompletionParams<T> {
  system: string;
  user: string;
  /** The shape the caller demands back. The adapter must return a value that has already passed this schema. */
  schema: ZodSchema<T>;
  /** Vendor model id, verbatim from `agent_profiles.model`. */
  model: string;
  /** Plaintext, in memory, for this call only. */
  apiKey: string;
  /** `agent_profiles.base_url` — NULL means the SDK's own default endpoint. Only `openai_compatible` uses it. */
  baseUrl: string | null;
  temperature?: number;
  maxTokens?: number;
  /** Resolved from `agent_profiles.config.timeoutMs` or `ai.request_timeout_ms`. Always set — an unbounded LLM call would pin a request thread indefinitely. */
  timeoutMs: number;
}

/**
 * One classified failure. This is the ONLY thing rotation ever sees of a
 * vendor error — the vendor's own error object never escapes its adapter's
 * classifier, exactly as `identity-otp.service.ts` keeps `Slide*Error` from
 * escaping the OTP service.
 */
export interface LlmFailure {
  kind: LlmFailureKind;
  /**
   * The vendor's own retry hint in milliseconds, when it gave one (an HTTP
   * `Retry-After` header, or a value inside the error body). Rotation prefers
   * this over the configured default cooldown — the vendor knows when its own
   * limit clears and we do not — but still caps it at
   * `ai.max_cooldown_seconds`.
   */
  retryAfterMs?: number;
  /**
   * A short human-readable summary, for the admin panel's credential-test
   * result and for server-side logs.
   *
   * MAY contain vendor text, and vendor text is not trusted to be free of key
   * material — Google's REST API puts the API key in a query parameter, so an
   * error echoing a request URL would echo the key with it. Every consumer
   * runs this through `redactSecret()` (`ai-redaction.util.ts`) with the key
   * that was actually used before logging it, returning it, or putting it
   * anywhere near an `audit_log` row.
   */
  detail: string;
}

/**
 * Normalises one vendor's error shapes to one `LlmFailureKind`. A separate
 * object rather than a method on the adapter so it can be unit-tested against
 * realistic error fixtures without constructing an SDK client, which is where
 * the subtle bugs in this module live.
 *
 * `classify` must never throw and must never return `undefined`: an error
 * shape nobody anticipated is `unknown`, which rotation treats as rotate-and-
 * cool-down. Silence is not an option — an unclassifiable error that returned
 * "fine" would loop.
 */
export interface ProviderErrorClassifier {
  classify(error: unknown): LlmFailure;
}

/**
 * What every provider integration implements. Four exist
 * (`openai-compatible`, `anthropic`, `google-genai`, `bedrock`) and
 * `LlmProviderRegistry` maps `ProviderCode` -> instance.
 *
 * Deliberately one method. Anything a provider can do beyond "given a system
 * prompt, a user message and a schema, return a value of that shape" is not
 * something this module exposes, so it is not something an adapter needs to
 * offer. That is what keeps adding a provider to one class and one registry
 * line.
 */
export interface LlmProviderAdapter {
  readonly provider: ProviderCode;
  /** This vendor's error normaliser. Held by the adapter so rotation can classify a failure without knowing which provider produced it. */
  readonly classifier: ProviderErrorClassifier;
  /**
   * Runs one completion and returns a value that has ALREADY been validated
   * against `params.schema`. Throws on any failure — the vendor's own error,
   * unwrapped, so `classifier.classify` can see the real shape.
   */
  complete<T>(params: LlmCompletionParams<T>): Promise<T>;
}

export type { LlmFailureKind, ProviderCode };
