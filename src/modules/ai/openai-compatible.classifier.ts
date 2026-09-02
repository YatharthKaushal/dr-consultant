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
 * Normalises errors from the OpenAI wire format — OpenAI itself and every
 * host that speaks it (Groq, OpenRouter, Together, DeepSeek, xAI, Fireworks,
 * Alibaba/DashScope).
 *
 * The `openai@7.9.0` SDK lifts the vendor body's three interesting fields to
 * the top of the error object, so `status` + `code` are almost always enough:
 *
 *     err.status  // 401
 *     err.code    // "invalid_api_key"   <- from body.error.code
 *     err.type    // "invalid_request_error"  <- from body.error.type
 *     err.error   // the UNWRAPPED body.error object
 *     err.headers // a WHATWG Headers instance
 *
 * Two things make this harder than it looks, and both are why the order of
 * the checks below matters:
 *
 *   1. **401 and 429 are not the whole story.** A 429 is either "you are
 *      going too fast" (clears in seconds) or "your balance is empty" (does
 *      not clear at all). OpenAI distinguishes them with
 *      `code: "insufficient_quota"`, but the compatible hosts vary wildly:
 *      Groq and Together send plain 429s, DeepSeek sends 402 for an empty
 *      balance, OpenRouter sends 402 with a "credits" message. So quota is
 *      detected from `code`, `type`, status 402, AND the message — anything
 *      less mislabels a dead account as a rate limit and hammers it.
 *   2. **A context overflow may not look like an HTTP error at all.**
 *      LangChain converts it into its own `ContextOverflowError` and drops
 *      `.status` in the process, so that check has to come before anything
 *      that reads a status.
 */
export class OpenAiCompatibleClassifier implements ProviderErrorClassifier {
  classify(error: unknown): LlmFailure {
    const record = asRecord(error);
    const status = readStatus(error);
    const message = readMessage(error);
    const code = typeof record.code === 'string' ? record.code : '';
    const type = typeof record.type === 'string' ? record.type : '';
    const detail = toDetail(message);
    const haystack = `${code} ${type} ${message}`;

    // 1. Context overflow FIRST — LangChain's replacement error has no status
    // and no code left to recognise it by.
    if (isContextOverflow(error) || code === 'context_length_exceeded' || looksLikeContextLength(haystack)) {
      return { kind: 'context_length', detail };
    }

    // 2. A safety refusal. Azure's OpenAI-compatible endpoint uses
    // `code: "content_filter"` on a 400; OpenAI's own SDK has a distinct
    // `ContentFilterFinishReasonError` whose message carries the phrase.
    if (code === 'content_filter' || looksLikeContentFiltered(haystack)) {
      return { kind: 'content_filtered', detail };
    }

    // 3. Timeout/abort before status checks: LangChain replaces an OpenAI
    // timeout with a bare `Error` (name "TimeoutError") that has no status.
    if (isTimeoutLike(error)) {
      return { kind: 'timeout', detail };
    }

    // 4. Quota exhaustion before the generic 429 branch — this is the
    // distinction that decides whether the key gets a 15-minute cooldown or a
    // 60-second one.
    if (code === 'insufficient_quota' || type === 'insufficient_quota' || looksLikeQuotaExhausted(haystack)) {
      return { kind: 'insufficient_quota', detail };
    }

    switch (status) {
      case 401:
        return { kind: 'invalid_key', detail };
      case 403:
        // "This key cannot use this model/endpoint/region." Rotating to
        // another key is exactly right, and it is not an auth failure of the
        // key itself, so it earns the shorter model_unavailable cooldown.
        return { kind: 'model_unavailable', detail };
      case 404:
        return { kind: 'model_unavailable', detail };
      // 402 Payment Required — DeepSeek and OpenRouter's empty-balance
      // response. Reached only if the message did not already say so.
      case 402:
        return { kind: 'insufficient_quota', detail };
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

    // 5. LangChain's own stamps, as a fallback for the paths where it replaced
    // the error and lost the status.
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

    if (status !== undefined && status >= 500) {
      return { kind: 'transient', detail };
    }

    if (isConnectionLike(error)) {
      return { kind: 'transient', detail };
    }

    // A 4xx we have no rule for is NOT assumed benign: it still rotates, it
    // still earns a cooldown. Landing here means a vendor grew a failure mode
    // worth adding a branch for.
    return { kind: 'unknown', detail };
  }
}
