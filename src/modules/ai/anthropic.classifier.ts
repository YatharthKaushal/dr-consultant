import type { LlmFailure, ProviderErrorClassifier } from './llm-provider.types';
import {
  asRecord,
  isConnectionLike,
  isContextOverflow,
  isTimeoutLike,
  looksLikeContentFiltered,
  looksLikeContextLength,
  looksLikeQuotaExhausted,
  readLcErrorCode,
  readMessage,
  readRetryAfterMs,
  readStatus,
  toDetail,
  LC_ERROR_CODES,
} from './llm-error.util';

/**
 * The nine `error.type` literals `@anthropic-ai/sdk@0.120.0` declares for the
 * Messages API error body (`resources/shared.d.ts` — `ErrorType`). Kept here
 * as a local const rather than imported from the SDK so the classifier stays
 * a pure function over plain objects and its spec needs no SDK client.
 *
 * Note what this version does NOT have, contrary to what one might expect
 * from older Anthropic docs: there is no `request_too_large` member. An
 * oversized request arrives as `invalid_request_error` (413), which the
 * context-length message patterns catch.
 */
const ANTHROPIC_ERROR_TYPES = {
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found_error',
  RATE_LIMIT: 'rate_limit_error',
  TIMEOUT: 'timeout_error',
  OVERLOADED: 'overloaded_error',
  API: 'api_error',
  BILLING: 'billing_error',
} as const;

/**
 * Normalises `@anthropic-ai/sdk@0.120.0` errors.
 *
 * Anthropic's error object differs from OpenAI's in two ways that would each
 * silently break a classifier written against the OpenAI shape:
 *
 *   1. **`err.error` is NOT unwrapped.** It is the whole response body,
 *      `{ type: "error", error: { type, message }, request_id }`, so the
 *      discriminator lives at `err.error.error.type`, one level deeper than
 *      OpenAI's. The SDK does also lift it to `err.type`, which is what this
 *      classifier prefers — but it reads the nested path as a fallback so a
 *      raw body (a fixture, a gateway that returns the JSON without the SDK
 *      wrapping it) classifies identically.
 *   2. **`err.message` is the serialised JSON body**, not a sentence —
 *      `makeMessage` looks for a top-level `message` field that Anthropic's
 *      body does not have, and falls through to `JSON.stringify`. So message
 *      matching is a last resort here, and the typed `error.type` is the real
 *      signal.
 *
 * One more trap: HTTP 529 ("overloaded") is mapped by the SDK to
 * `InternalServerError`, not to any overload-specific class. Classifying on
 * `error.type === "overloaded_error"` (or the status) is correct; classifying
 * on the error class would silently mislabel it.
 */
export class AnthropicClassifier implements ProviderErrorClassifier {
  classify(error: unknown): LlmFailure {
    const record = asRecord(error);
    const status = readStatus(error);
    const message = readMessage(error);
    const detail = toDetail(message);

    // `err.type` (lifted by the SDK), else the nested body path, else a bare
    // body object that never went through the SDK at all.
    //
    // Every candidate is filtered through `pickErrorType`, which accepts ONLY
    // the nine declared `ErrorType` literals. That is load-bearing, not
    // defensive: the response envelope carries its own `type: "error"` marker
    // at the SAME level the SDK lifts the real type to, so a plain
    // string-truthiness check picks up the literal `"error"` from a raw body
    // and shadows the real discriminator one level down.
    const body = asRecord(record.error);
    const vendorType =
      pickErrorType(record.type) ?? pickErrorType(asRecord(body.error).type) ?? pickErrorType(body.type) ?? '';
    const vendorMessage = pickString(asRecord(body.error).message) ?? pickString(body.message) ?? '';
    const haystack = `${vendorType} ${vendorMessage} ${message}`;

    // Context overflow first — LangChain converts Anthropic's "prompt is too
    // long" 400 into `ContextOverflowError` and drops the status with it.
    if (isContextOverflow(error) || looksLikeContextLength(haystack)) {
      return { kind: 'context_length', detail };
    }

    // Anthropic has no content-filter error TYPE — a refusal comes back as a
    // successful response with `stop_reason: "refusal"`, which the adapter
    // surfaces as an error carrying that word. Message matching is the only
    // signal available.
    if (looksLikeContentFiltered(haystack)) {
      return { kind: 'content_filtered', detail };
    }

    if (isTimeoutLike(error) || vendorType === ANTHROPIC_ERROR_TYPES.TIMEOUT) {
      return { kind: 'timeout', detail };
    }

    // `billing_error` is Anthropic's explicit "this account cannot be
    // charged" — distinct from a rate limit, and the reason the taxonomy
    // splits `insufficient_quota` out. A low-credit-balance 400 says so in
    // the message instead.
    if (vendorType === ANTHROPIC_ERROR_TYPES.BILLING || looksLikeQuotaExhausted(haystack)) {
      return { kind: 'insufficient_quota', detail };
    }

    switch (vendorType) {
      case ANTHROPIC_ERROR_TYPES.AUTHENTICATION:
        return { kind: 'invalid_key', detail };
      case ANTHROPIC_ERROR_TYPES.PERMISSION:
      case ANTHROPIC_ERROR_TYPES.NOT_FOUND:
        return { kind: 'model_unavailable', detail };
      case ANTHROPIC_ERROR_TYPES.RATE_LIMIT: {
        const retryAfterMs = readRetryAfterMs(error);
        return retryAfterMs === undefined
          ? { kind: 'rate_limited', detail }
          : { kind: 'rate_limited', retryAfterMs, detail };
      }
      case ANTHROPIC_ERROR_TYPES.OVERLOADED:
      case ANTHROPIC_ERROR_TYPES.API:
        return { kind: 'transient', detail };
      case ANTHROPIC_ERROR_TYPES.INVALID_REQUEST:
        // Falls through to `unknown` (rotate, short cooldown) rather than to
        // a fail-fast kind. The two `invalid_request_error` cases that must
        // NOT rotate — an oversized prompt and a refusal — were already
        // caught above by message shape. What is left is most often a
        // schema/tool-translation problem specific to THIS vendor's wire
        // format, and the next candidate may well be a different provider
        // that translates the same zod schema differently. Rotating is a real
        // chance of success, not a wasted call.
        break;
      default:
        break;
    }

    switch (status) {
      case 401:
        return { kind: 'invalid_key', detail };
      case 403:
      case 404:
        return { kind: 'model_unavailable', detail };
      case 429: {
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

    switch (readLcErrorCode(error)) {
      case LC_ERROR_CODES.AUTHENTICATION:
        return { kind: 'invalid_key', detail };
      case LC_ERROR_CODES.NOT_FOUND:
        return { kind: 'model_unavailable', detail };
      case LC_ERROR_CODES.RATE_LIMIT: {
        const retryAfterMs = readRetryAfterMs(error);
        return retryAfterMs === undefined
          ? { kind: 'rate_limited', detail }
          : { kind: 'rate_limited', retryAfterMs, detail };
      }
      default:
        break;
    }

    // 529 lands here as well as 500-508 — the SDK maps it to
    // `InternalServerError`, so the status range is the reliable signal.
    if (status !== undefined && status >= 500) {
      return { kind: 'transient', detail };
    }

    if (isConnectionLike(error)) {
      return { kind: 'transient', detail };
    }

    return { kind: 'unknown', detail };
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const ANTHROPIC_ERROR_TYPE_VALUES: readonly string[] = Object.values(ANTHROPIC_ERROR_TYPES);

/** Accepts only a declared `ErrorType` literal — see the note at the call site about the envelope's own `type: "error"`. */
function pickErrorType(value: unknown): string | undefined {
  return typeof value === 'string' && ANTHROPIC_ERROR_TYPE_VALUES.includes(value) ? value : undefined;
}
