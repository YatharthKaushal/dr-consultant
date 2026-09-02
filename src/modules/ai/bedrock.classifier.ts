import { AI_ERROR_CODES } from './ai.constants';
import type { LlmFailure, ProviderErrorClassifier } from './llm-provider.types';
import {
  asRecord,
  isConnectionLike,
  isContextOverflow,
  isProviderNotConfiguredError,
  isTimeoutLike,
  looksLikeContentFiltered,
  looksLikeContextLength,
  looksLikeQuotaExhausted,
  readMessage,
  readName,
  readRetryAfterMs,
  readStatus,
  toDetail,
} from './llm-error.util';

/**
 * AWS SDK v3 error `name`s the Bedrock Runtime `InvokeModel`/`Converse`
 * operations can raise, plus the credential-resolution errors that surface
 * before a request is ever signed.
 */
const BEDROCK_ERROR_NAMES = {
  THROTTLING: 'ThrottlingException',
  SERVICE_QUOTA_EXCEEDED: 'ServiceQuotaExceededException',
  ACCESS_DENIED: 'AccessDeniedException',
  UNRECOGNIZED_CLIENT: 'UnrecognizedClientException',
  INCOMPLETE_SIGNATURE: 'IncompleteSignatureException',
  INVALID_SIGNATURE: 'InvalidSignatureException',
  EXPIRED_TOKEN: 'ExpiredTokenException',
  CREDENTIALS_PROVIDER: 'CredentialsProviderError',
  VALIDATION: 'ValidationException',
  RESOURCE_NOT_FOUND: 'ResourceNotFoundException',
  MODEL_NOT_READY: 'ModelNotReadyException',
  MODEL_TIMEOUT: 'ModelTimeoutException',
  MODEL_ERROR: 'ModelErrorException',
  MODEL_STREAM_ERROR: 'ModelStreamErrorException',
  INTERNAL_SERVER: 'InternalServerException',
  SERVICE_UNAVAILABLE: 'ServiceUnavailableException',
} as const;

/**
 * Normalises AWS Bedrock Runtime errors.
 *
 * `BedrockAdapter` is currently a stub (see its file for why
 * `@langchain/aws` is not installed), so the only error this classifier sees
 * in practice today is the adapter's own `PROVIDER_NOT_CONFIGURED` — which it
 * reports as `model_unavailable` so rotation treats a Bedrock profile as "not
 * serving right now" and moves on to the next candidate, exactly as it would
 * for a decommissioned model.
 *
 * The rest of this class is written against the real AWS shapes anyway, and
 * tested against them, because the whole point of the design is that swapping
 * the stub for a real adapter is one file. A classifier written at the same
 * time as that adapter would be a classifier written under time pressure
 * against a live integration; this one can be got right calmly.
 *
 * AWS SDK v3 errors carry:
 *   - `name`               — the modelled exception, e.g. `ThrottlingException`.
 *   - `$metadata.httpStatusCode` — the HTTP status.
 *   - `$fault`             — `"client"` or `"server"`.
 *   - `$retryable`         — `{ throttling: boolean }` on retryable faults.
 *
 * TRAP: `name` is the primary discriminator here, which is the opposite of
 * the advice for the other three providers — and it is only safe because
 * `readStatus` is checked alongside it. If `@langchain/aws` is ever wired in,
 * LangChain's `AsyncCaller` OVERWRITES `.name` on HTTP 429 responses (to
 * `RateLimitCapacityError` and friends), and `ThrottlingException` IS a 429.
 * That is why the 429 status branch below stands on its own rather than
 * relying on the name check above it.
 */
export class BedrockClassifier implements ProviderErrorClassifier {
  classify(error: unknown): LlmFailure {
    const record = asRecord(error);
    const message = readMessage(error);
    const detail = toDetail(message);
    const status = readStatus(error) ?? readAwsStatus(record);
    const name = readName(error);
    const haystack = `${name} ${message}`;

    // The stub's own signal. Checked first: it is an `HttpException`, so it
    // carries neither an AWS name nor an AWS status, and every branch below
    // would miss it.
    if (isProviderNotConfiguredError(error, AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED)) {
      return { kind: 'model_unavailable', detail };
    }

    if (isContextOverflow(error) || looksLikeContextLength(haystack)) {
      return { kind: 'context_length', detail };
    }

    // Bedrock Guardrails refusals arrive as a `ValidationException` whose
    // message names the guardrail, or as a `content_filtered` stop reason the
    // adapter converts into an error.
    if (looksLikeContentFiltered(haystack)) {
      return { kind: 'content_filtered', detail };
    }

    if (name === BEDROCK_ERROR_NAMES.MODEL_TIMEOUT || isTimeoutLike(error)) {
      return { kind: 'timeout', detail };
    }

    if (name === BEDROCK_ERROR_NAMES.SERVICE_QUOTA_EXCEEDED || looksLikeQuotaExhausted(haystack)) {
      return { kind: 'insufficient_quota', detail };
    }

    switch (name) {
      case BEDROCK_ERROR_NAMES.ACCESS_DENIED:
        // On Bedrock this genuinely is ambiguous between "bad credentials"
        // and "this account has not requested access to this model". Both
        // rotate; `invalid_key` is chosen because it earns the longer
        // cooldown, and neither variant fixes itself in sixty seconds.
        return { kind: 'invalid_key', detail };
      case BEDROCK_ERROR_NAMES.UNRECOGNIZED_CLIENT:
      case BEDROCK_ERROR_NAMES.INCOMPLETE_SIGNATURE:
      case BEDROCK_ERROR_NAMES.INVALID_SIGNATURE:
      case BEDROCK_ERROR_NAMES.EXPIRED_TOKEN:
      case BEDROCK_ERROR_NAMES.CREDENTIALS_PROVIDER:
        return { kind: 'invalid_key', detail };
      case BEDROCK_ERROR_NAMES.RESOURCE_NOT_FOUND:
      case BEDROCK_ERROR_NAMES.MODEL_NOT_READY:
        return { kind: 'model_unavailable', detail };
      case BEDROCK_ERROR_NAMES.THROTTLING: {
        const retryAfterMs = readRetryAfterMs(error);
        return retryAfterMs === undefined
          ? { kind: 'rate_limited', detail }
          : { kind: 'rate_limited', retryAfterMs, detail };
      }
      case BEDROCK_ERROR_NAMES.INTERNAL_SERVER:
      case BEDROCK_ERROR_NAMES.SERVICE_UNAVAILABLE:
      case BEDROCK_ERROR_NAMES.MODEL_ERROR:
      case BEDROCK_ERROR_NAMES.MODEL_STREAM_ERROR:
        return { kind: 'transient', detail };
      case BEDROCK_ERROR_NAMES.VALIDATION:
        // Anything a `ValidationException` means beyond the two fail-fast
        // cases already caught above is a request-shape problem another
        // provider may well accept. Falls through to `unknown` — rotate.
        break;
      default:
        break;
    }

    switch (status) {
      case 400:
        return { kind: 'unknown', detail };
      case 401:
      case 403:
        return { kind: 'invalid_key', detail };
      case 404:
        return { kind: 'model_unavailable', detail };
      case 429: {
        // Stands alone rather than relying on the `ThrottlingException` name
        // check above — see the TRAP note in this class's doc comment.
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
      return { kind: 'transient', detail };
    }

    // `$fault: "server"` is AWS's own "this was our fault, retrying is
    // reasonable" marker, for a modelled exception this classifier does not
    // otherwise know.
    if (record.$fault === 'server' || isConnectionLike(error)) {
      return { kind: 'transient', detail };
    }

    return { kind: 'unknown', detail };
  }
}

/** `$metadata.httpStatusCode` — where AWS SDK v3 puts the status, rather than on the error itself. */
function readAwsStatus(record: Record<string, unknown>): number | undefined {
  const value = asRecord(record.$metadata).httpStatusCode;
  return typeof value === 'number' ? value : undefined;
}
