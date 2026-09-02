import type { LlmFailure, ProviderErrorClassifier } from './llm-provider.types';
import {
  asRecord,
  isConnectionLike,
  isContextOverflow,
  isTimeoutLike,
  looksLikeContentFiltered,
  looksLikeContextLength,
  looksLikeQuotaExhausted,
  readMessage,
  readRetryAfterMs,
  readStatus,
  toDetail,
} from './llm-error.util';

/**
 * `google.rpc.ErrorInfo.reason` values the Generative Language API sends in
 * `error.details`. Unlike `error.status`, these DO survive the SDK (see the
 * class comment), which makes them the most reliable structured signal
 * available for Gemini.
 */
const GOOGLE_REASONS = {
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_SERVICE_BLOCKED: 'API_KEY_SERVICE_BLOCKED',
  API_KEY_HTTP_REFERRER_BLOCKED: 'API_KEY_HTTP_REFERRER_BLOCKED',
  API_KEY_IP_ADDRESS_BLOCKED: 'API_KEY_IP_ADDRESS_BLOCKED',
  SERVICE_DISABLED: 'SERVICE_DISABLED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  BILLING_DISABLED: 'BILLING_DISABLED',
} as const;

/**
 * Normalises errors from `@langchain/google-genai@2.3.0`, which wraps
 * `@google/generative-ai@0.24.1` (the legacy SDK — not `@google/genai`).
 *
 * IMPORTANT — this provider is materially harder to classify than the other
 * two, and not for the reason one would expect. The Gemini REST API does
 * return the canonical gRPC status strings (`RESOURCE_EXHAUSTED`,
 * `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `UNAVAILABLE`), but the installed
 * SDK **throws them away**: `handleResponseNotOk` reads the body, keeps
 * `error.message` and `error.details`, and never surfaces `error.status` or
 * `error.code` on the thrown object. Nothing downstream can read them.
 *
 * What DOES reach us, on `GoogleGenerativeAIFetchError`:
 *   - `status`      — the numeric HTTP status. Reliable.
 *   - `statusText`  — e.g. "Bad Request".
 *   - `errorDetails`— the `google.rpc` details array, including
 *                     `{ "@type": ".../ErrorInfo", reason: "API_KEY_INVALID" }`.
 *                     Structured, and the best signal there is.
 *   - `message`     — a fixed template:
 *                     `[GoogleGenerativeAI Error]: Error fetching from <url>:
 *                      [<status> <statusText>] <message> <details JSON>`
 *
 * And what does NOT: there are **no headers on the error object at all**, so
 * `Retry-After` is unreadable for this provider. A Gemini `rate_limited`
 * therefore never carries `retryAfterMs` and always falls back to the
 * configured cooldown. That is a real limitation of the installed SDK, not an
 * oversight here.
 *
 * Two more Gemini-specific traps this classifier handles:
 *   - An **invalid API key is a 400, not a 401** ("API key not valid. Please
 *     pass a valid API key.", reason `API_KEY_INVALID`). A classifier written
 *     against the other two providers' 401 convention would call it
 *     `unknown` and cool the key down for a minute instead of the fifteen a
 *     dead key deserves.
 *   - The message embeds the **full request URL, which carries the API key as
 *     a `?key=` query parameter**. `LlmFailure.detail` therefore genuinely
 *     can contain a live credential here, which is exactly why every consumer
 *     runs it through `redactSecret()`. See `ai-redaction.util.ts`.
 */
export class GoogleGenAiClassifier implements ProviderErrorClassifier {
  classify(error: unknown): LlmFailure {
    const record = asRecord(error);
    const status = readStatus(error);
    const message = readMessage(error);
    const detail = toDetail(message);
    const reasons = readReasons(record.errorDetails);
    const haystack = `${reasons.join(' ')} ${message}`;

    if (isContextOverflow(error) || looksLikeContextLength(haystack)) {
      return { kind: 'context_length', detail };
    }

    // Gemini's safety layer. A blocked prompt surfaces either as a thrown
    // `GoogleGenerativeAIResponseError` ("Response was blocked due to
    // SAFETY") or, for a blocked candidate, as a finish reason the adapter
    // turns into an error carrying the same words.
    if (looksLikeContentFiltered(haystack)) {
      return { kind: 'content_filtered', detail };
    }

    if (isTimeoutLike(error)) {
      return { kind: 'timeout', detail };
    }

    // Structured reasons before status: a 400 means five different things
    // here and the reason is what separates them.
    if (
      reasons.includes(GOOGLE_REASONS.API_KEY_INVALID) ||
      reasons.includes(GOOGLE_REASONS.API_KEY_SERVICE_BLOCKED) ||
      reasons.includes(GOOGLE_REASONS.API_KEY_HTTP_REFERRER_BLOCKED) ||
      reasons.includes(GOOGLE_REASONS.API_KEY_IP_ADDRESS_BLOCKED) ||
      /api[ _]key not valid/i.test(message) ||
      /invalid api key/i.test(message)
    ) {
      return { kind: 'invalid_key', detail };
    }

    if (reasons.includes(GOOGLE_REASONS.BILLING_DISABLED) || looksLikeQuotaExhausted(haystack)) {
      return { kind: 'insufficient_quota', detail };
    }

    if (reasons.includes(GOOGLE_REASONS.SERVICE_DISABLED)) {
      return { kind: 'model_unavailable', detail };
    }

    switch (status) {
      case 400:
        // A 400 that is not a bad key, not a quota problem and not an
        // oversized prompt is a malformed request. Rotating may still help —
        // a different provider translates the same zod schema differently —
        // so this is `unknown`, not a fail-fast kind.
        return { kind: 'unknown', detail };
      case 401:
        return { kind: 'invalid_key', detail };
      case 403:
        // PERMISSION_DENIED: the key exists but cannot use this model, or the
        // API is not enabled on the project.
        return { kind: 'model_unavailable', detail };
      case 404:
        return { kind: 'model_unavailable', detail };
      case 429: {
        // Free-tier daily exhaustion and per-minute throttling BOTH arrive as
        // 429 RESOURCE_EXHAUSTED. The quota-message check above has already
        // caught the exhausted case; what is left is a genuine rate limit.
        //
        // `readRetryAfterMs` is called even though a Gemini fetch error
        // carries no headers, because LangChain may have parsed a "try again
        // in Ns" out of the message and stamped `retryAfterMs` itself. It
        // usually has not, and the caller falls back to the configured
        // cooldown.
        const retryAfterMs = readRetryAfterMs(error);
        return retryAfterMs === undefined
          ? { kind: 'rate_limited', detail }
          : { kind: 'rate_limited', retryAfterMs, detail };
      }
      case 408:
        return { kind: 'timeout', detail };
      default:
        break;
    }

    if (status !== undefined && status >= 500) {
      // 500 INTERNAL / 503 UNAVAILABLE — Gemini's most common failure under
      // load, and the one most worth retrying.
      return { kind: 'transient', detail };
    }

    // A connection failure never becomes `GoogleGenerativeAIFetchError` — the
    // SDK throws a bare `GoogleGenerativeAIError` with no status at all, so
    // this branch is genuinely load-bearing for Gemini, not defensive.
    if (isConnectionLike(error) || /error fetching from/i.test(message)) {
      return { kind: 'transient', detail };
    }

    return { kind: 'unknown', detail };
  }
}

/** Every `reason` in a `google.rpc` `errorDetails` array. Tolerates the field being absent, a non-array, or full of unexpected members. */
function readReasons(errorDetails: unknown): string[] {
  if (!Array.isArray(errorDetails)) return [];
  const reasons: string[] = [];
  for (const entry of errorDetails) {
    const reason = asRecord(entry).reason;
    if (typeof reason === 'string') reasons.push(reason);
  }
  return reasons;
}
