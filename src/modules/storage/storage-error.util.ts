/**
 * Shared duck-typing helpers `S3Classifier`/`CloudinaryClassifier` read
 * vendor errors through. Mirrors `llm-error.util.ts`'s approach and its
 * reasoning: DUCK-TYPED, NOT `instanceof`, because a second copy of
 * `@aws-sdk/client-s3` or `cloudinary` anywhere in the dependency tree (a
 * transitive dependency pinning a different minor) gives `instanceof` a
 * different class object and it silently returns false. A classifier that
 * quietly stops recognising an auth failure is exactly the bug this module
 * cannot afford.
 *
 * Kept smaller than `llm-error.util.ts` on purpose — two adapters, not four,
 * and neither AWS SDK v3 nor the Cloudinary SDK sits behind a normalising
 * layer like LangChain that mutates or replaces errors on the way out, so
 * there is no equivalent of that file's LangChain-specific caveats to guard
 * against here.
 */

/** How much vendor text a `StorageFailure.detail` carries. Enough to diagnose, short enough not to bloat a log line. */
const MAX_DETAIL_LENGTH = 300;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  if (typeof record.message === 'string') return record.message;
  return typeof error === 'string' ? error : String(error);
}

/** `error.name` — how both the AWS SDK v3 (`NoSuchBucket`, `AccessDenied`, ...) and the Cloudinary SDK (`Error`, with `.http_code` carrying the real signal) shape a recognisable error. */
export function readName(error: unknown): string {
  if (error instanceof Error) return error.name;
  const value = asRecord(error).name;
  return typeof value === 'string' ? value : '';
}

/**
 * The HTTP status, wherever the SDK put it:
 *   - AWS SDK v3 (`@smithy/core`'s `ServiceException`): `$metadata.httpStatusCode`.
 *   - Cloudinary SDK (`UploadApiErrorResponse` and the same shape from
 *     `uploader.destroy`/`utils.private_download_url`'s failures): `http_code`.
 *   - A generic Node/HTTP error a test fixture or a future provider might
 *     carry: `status`/`statusCode`, checked as a fallback.
 */
export function readStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const metadata = asRecord(record.$metadata);

  for (const value of [record.http_code, metadata.httpStatusCode, record.status, record.statusCode]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** A transport failure that never reached the provider — DNS, TLS, connection reset, socket hang-up — or a request that never got an answer in time. Grouped together (`STORAGE_FAILURE_KINDS.network_or_timeout`): both say nothing about this provider's credentials or config, and both earn the same one-retry-then-rotate-with-no-cooldown handling. */
export function isConnectionOrTimeoutLike(error: unknown): boolean {
  if (/(?:Timeout|Abort)Error$/.test(readName(error))) {
    return true;
  }
  if (readStatus(error) === 408) return true;

  const code = asRecord(error).code;
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR)/.test(code)) {
    return true;
  }

  const message = readMessage(error).toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('connection error')
  );
}

/**
 * Trims vendor text to something loggable. Unlike `llm-error.util.ts`'s
 * `toDetail`, the result never needs `redactSecret()` afterwards: nothing
 * this module hands to a provider SDK is a secret an error could echo back
 * (S3/Cloudinary error bodies do not include the access key/secret used to
 * make the request), so there is no `ai-redaction.util.ts` analog here.
 */
export function toDetail(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…` : collapsed;
}
