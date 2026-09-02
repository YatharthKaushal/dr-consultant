/**
 * Shared duck-typing helpers every `ProviderErrorClassifier` reads vendor
 * errors through.
 *
 * DUCK-TYPED, NOT `instanceof`, on purpose — the same reasoning
 * `shared/errors/postgres-error.util.ts` already applies to `pg`'s
 * `DatabaseError`, plus two reasons specific to this module:
 *
 *   1. A second copy of `openai`/`@anthropic-ai/sdk` anywhere in the tree
 *      (a transitive dependency pinning a different minor) gives `instanceof`
 *      a different class object and it silently returns false. A classifier
 *      that quietly stops recognising 401s is exactly the bug this module
 *      cannot afford.
 *   2. LangChain does not always hand back the vendor's instance. It REPLACES
 *      it in three cases we care about (all verified against the installed
 *      `@langchain/core@1.2.9`, `@langchain/openai@1.5.11`,
 *      `@langchain/anthropic@1.5.9`):
 *        - a context-window overflow becomes `ContextOverflowError`, with the
 *          original moved to `.cause` and `.status` LOST;
 *        - an OpenAI timeout becomes a plain `Error` with `name =
 *          "TimeoutError"` and no `.status`, so `instanceof
 *          APIConnectionTimeoutError` is false;
 *        - an abort becomes a plain `Error` with `name = "AbortError"`.
 *      It also MUTATES the errors it does pass through: `.message` gains a
 *      "Troubleshooting URL" suffix, `.lc_error_code` is added, and on a 429
 *      `.name` is OVERWRITTEN (`InsufficientQuotaError` /
 *      `RateLimitQuotaExhaustedError` / `RateLimitCapacityError`). Nothing
 *      here classifies on `.name` except for the two cases above, where it is
 *      the only signal left.
 *
 * Reading loose fields off `unknown` is also what makes the classifier specs
 * meaningful: a fixture is a plain object shaped like the real thing, so a
 * test can cover nine failure kinds without constructing an SDK client.
 */

/** LangChain stamps this on errors it recognises. Stable across vendors, so it is checked before any message regex. */
export const LC_ERROR_CODES = {
  AUTHENTICATION: 'MODEL_AUTHENTICATION',
  NOT_FOUND: 'MODEL_NOT_FOUND',
  RATE_LIMIT: 'MODEL_RATE_LIMIT',
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
} as const;

/** How much vendor text a `LlmFailure.detail` carries. Enough to diagnose, short enough not to bloat a log line or an admin panel row. */
const MAX_DETAIL_LENGTH = 300;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The HTTP status, wherever the vendor put it. Absent on connection errors and on LangChain's replacement errors. */
export function readStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  for (const value of [record.status, record.statusCode, asRecord(record.response).status]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  if (typeof record.message === 'string') return record.message;
  return typeof error === 'string' ? error : String(error);
}

/** `error.name`, used ONLY where LangChain has replaced the instance and left nothing else (timeout/abort). Never for a 429 — LangChain overwrites `.name` there. */
export function readName(error: unknown): string {
  if (error instanceof Error) return error.name;
  const value = asRecord(error).name;
  return typeof value === 'string' ? value : '';
}

export function readLcErrorCode(error: unknown): string | undefined {
  const value = asRecord(error).lc_error_code;
  return typeof value === 'string' ? value : undefined;
}

/**
 * One header, from either a real WHATWG `Headers` (what both the OpenAI and
 * Anthropic SDKs attach) or a plain object (what a test fixture and some
 * gateways produce). Case-insensitive both ways.
 */
export function readHeader(headers: unknown, name: string): string | undefined {
  if (headers == null) return undefined;

  const getter = asRecord(headers).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }

  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(asRecord(headers))) {
    if (key.toLowerCase() === lower && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * The vendor's own "come back in N" hint, in milliseconds, or `undefined`.
 *
 * Checked in order of trustworthiness:
 *   1. `error.retryAfterMs` — LangChain has already normalised a header or a
 *      "try again in 20s" message into milliseconds for us.
 *   2. `retry-after-ms` — OpenAI's non-standard millisecond header, which its
 *      own client prefers over the standard one.
 *   3. `retry-after` — seconds, or an HTTP date. Both spellings are legal per
 *      RFC 9110 and real gateways send both.
 *
 * A negative or absurd value is discarded rather than trusted: the caller
 * caps cooldowns at `ai.max_cooldown_seconds` anyway, but a `Retry-After` of
 * `-1` would otherwise become a cooldown in the past and defeat the point.
 */
export function readRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);

  const normalised = record.retryAfterMs;
  if (typeof normalised === 'number' && Number.isFinite(normalised) && normalised > 0) {
    return Math.round(normalised);
  }

  const headers = record.headers ?? asRecord(record.response).headers;

  const millis = readHeader(headers, 'retry-after-ms');
  if (millis !== undefined) {
    const parsed = Number(millis);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }

  const seconds = readHeader(headers, 'retry-after');
  if (seconds !== undefined) {
    const parsed = Number(seconds);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 1_000);

    // RFC 9110 also allows an HTTP-date.
    const at = Date.parse(seconds);
    if (Number.isFinite(at)) {
      const delta = at - Date.now();
      if (delta > 0) return delta;
    }
  }

  return undefined;
}

/**
 * True when LangChain converted a context-window overflow into its own
 * `ContextOverflowError`. Worth checking first in every classifier: the
 * conversion DROPS `.status` and `.code`, so by the time the vendor-specific
 * branches run there is nothing left to recognise it by.
 */
export function isContextOverflow(error: unknown): boolean {
  return readLcErrorCode(error) === LC_ERROR_CODES.CONTEXT_OVERFLOW || readName(error) === 'ContextOverflowError';
}

/**
 * True for the two errors LangChain replaces with a bare `Error`, leaving
 * `.name` as the only signal. `APIConnectionTimeoutError` is included for the
 * case where a raw SDK error reaches us without passing through LangChain
 * (the credential-test probe path, or a future direct call).
 */
export function isTimeoutLike(error: unknown): boolean {
  // Matched by SUFFIX rather than by an exact list, because each vendor
  // prefixes its own: `TimeoutError` and `AbortError` (LangChain's
  // replacements), `APIConnectionTimeoutError` (raw OpenAI/Anthropic),
  // `GoogleGenerativeAIAbortError` (Gemini). An exact list silently stops
  // recognising the next one.
  if (/(?:Timeout|Abort)Error$/.test(readName(error))) {
    return true;
  }
  if (readStatus(error) === 408) return true;

  const message = readMessage(error).toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('aborted')
  );
}

/** A transport failure that never reached the vendor — DNS, TLS, connection reset, socket hang-up. Always worth trying the next candidate. */
export function isConnectionLike(error: unknown): boolean {
  const name = readName(error);
  if (name === 'APIConnectionError' || name === 'FetchError' || name === 'TypeError') {
    // A bare `TypeError` is what `fetch` throws for a network failure in Node.
    if (name !== 'TypeError' || readMessage(error).toLowerCase().includes('fetch')) {
      return true;
    }
  }

  const code = asRecord(error).code;
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR)/.test(code)) {
    return true;
  }

  const message = readMessage(error).toLowerCase();
  return (
    message.includes('connection error') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('econnreset')
  );
}

/**
 * Message shapes that mean "the money ran out", as opposed to "you are going
 * too fast". Both arrive as HTTP 429 from most providers, and they need
 * opposite handling — a per-minute limit clears in seconds, an empty balance
 * does not — so this is the predicate that decides between `rate_limited` and
 * `insufficient_quota`.
 *
 * Mirrors the patterns `@langchain/core`'s own `AsyncCaller` uses to decide a
 * 429 is not worth retrying, deliberately: matching its judgement means our
 * classification agrees with the retry behaviour actually happening upstream.
 */
const QUOTA_EXHAUSTED_PATTERNS = [
  /insufficient[_ -]?quota/i,
  /exceeded (?:your|the current|the available).{0,40}quota/i,
  /usage quota/i,
  /quota (?:has been )?exhausted/i,
  /billing/i,
  /credit balance/i,
  /out of credits/i,
  /payment required/i,
  /spending limit/i,
];

export function looksLikeQuotaExhausted(text: string): boolean {
  return QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(text));
}

/** Message shapes that mean the prompt did not fit, for the paths where LangChain did not already convert it. */
const CONTEXT_LENGTH_PATTERNS = [
  // OpenAI-compatible.
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds the context window/i,
  /input tokens exceed/i,
  /reduce the length of the messages/i,
  // Anthropic.
  /prompt is too long/i,
  // Gemini phrases it as a COUNT exceeding a MAXIMUM, with the numbers in
  // between, so none of the contiguous phrases above catch it — an oversized
  // Gemini prompt would otherwise rotate across every provider and fail on
  // each in turn.
  /token count\b[^.]{0,80}exceeds?/i,
  /exceeds the maximum number of tokens/i,
  // Generic / Bedrock.
  /too many (?:input )?tokens/i,
  /input is too long/i,
];

export function looksLikeContextLength(text: string): boolean {
  return CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(text));
}

/** Message shapes that mean a safety layer refused, across all four vendors' wordings. */
const CONTENT_FILTER_PATTERNS = [
  /content[_ ]filter/i,
  /content management policy/i,
  /safety (?:setting|filter|policy)/i,
  /\bPROHIBITED_CONTENT\b/,
  /\bBLOCKLIST\b/,
  /blocked due to safety/i,
  /response was blocked/i,
  /\brefusal\b/i,
  /violat(?:es|ing) (?:our )?(?:usage )?polic/i,
];

export function looksLikeContentFiltered(text: string): boolean {
  return CONTENT_FILTER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True for an adapter's own "this build cannot construct a client for this
 * provider" refusal — today only `BedrockAdapter`'s. It is an `HttpException`
 * carrying this codebase's `{ code, message }` body convention, so it has
 * neither a vendor status nor a vendor error type, and every other predicate
 * here would miss it.
 *
 * Two callers, for two different reasons: `BedrockClassifier` maps it to
 * `model_unavailable` so ROTATION skips the profile and carries on, while
 * `agent-credential.service.ts` reports it to the ADMIN as a 503
 * `PROVIDER_NOT_CONFIGURED` — "we never even attempted a call" is a different
 * answer from "we called and the provider said no", and an admin testing a
 * credential needs to be told which one happened.
 */
export function isProviderNotConfiguredError(error: unknown, code: string): boolean {
  const record = asRecord(error);
  if (record.code === code) return true;
  // Nest keeps a thrown `HttpException`'s body under `response`.
  return asRecord(record.response).code === code;
}

/**
 * Trims vendor text to something loggable.
 *
 * NOTE: this does NOT redact key material — it cannot, because it does not
 * know the key. `ai-rotation.service.ts` runs the result through
 * `redactSecret()` with the key that was actually used before the string
 * goes anywhere. See `ai-redaction.util.ts`.
 */
export function toDetail(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…` : collapsed;
}
