import type { StorageErrorClassifier, StorageFailure } from './storage-provider.types';
import { isConnectionOrTimeoutLike, readMessage, readName, readStatus, toDetail } from './storage-error.util';

/**
 * Normalises errors from `@aws-sdk/client-s3` (and, transitively,
 * `@aws-sdk/s3-request-presigner`, which throws the SDK's own error types
 * for a malformed input rather than making a network call — see
 * `s3-storage.adapter.ts`'s note on `getSignedUrl`).
 *
 * AWS SDK v3's modelled S3 exceptions (`NoSuchBucket`, `NoSuchKey`,
 * `AccessDenied`, ...) set `.name` to the AWS error code and carry
 * `.$metadata.httpStatusCode`. Verified against the installed
 * `@aws-sdk/client-s3@3.1124.0`: `NoSuchBucket`/`NoSuchKey`/`AccessDenied`
 * are real exported, modelled exception classes, but authentication failures
 * (`InvalidAccessKeyId`, `SignatureDoesNotMatch`, `ExpiredToken`) are NOT —
 * they happen at the SigV4 request-signing/auth layer, before S3's own
 * per-operation error modelling applies, so they surface as a generic error
 * object with `.name` still set to the right string but no dedicated class.
 * This is exactly why classification here is duck-typed on `.name`
 * (mirroring `llm-error.util.ts`'s reasoning), not `instanceof`.
 *
 * `.name` is checked before falling back to `.$metadata.httpStatusCode`
 * because S3 uses 403 for BOTH "these credentials are wrong"
 * (`InvalidAccessKeyId`/`SignatureDoesNotMatch`) and "these credentials are
 * valid but lack permission" (`AccessDenied`) — the status code alone cannot
 * tell them apart, and rotation's cooldown reasoning treats them the same
 * way regardless, but the classifier keeps them distinguishable in
 * `lastFailureKind` for whoever reads the admin panel.
 */
const INVALID_CREDENTIALS_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidClientTokenId',
  'ExpiredToken',
  'UnrecognizedClientException',
  'CredentialsError',
  'InvalidToken',
]);

const ACCESS_DENIED_NAMES = new Set(['AccessDenied', 'AccessDeniedException', 'Forbidden']);

const NOT_FOUND_NAMES = new Set(['NoSuchBucket', 'NoSuchKey', 'NotFound']);

export class S3Classifier implements StorageErrorClassifier {
  classify(error: unknown): StorageFailure {
    const name = readName(error);
    const status = readStatus(error);
    const detail = toDetail(readMessage(error));

    if (INVALID_CREDENTIALS_NAMES.has(name)) {
      return { kind: 'invalid_credentials', detail };
    }
    if (ACCESS_DENIED_NAMES.has(name)) {
      return { kind: 'access_denied', detail };
    }
    if (NOT_FOUND_NAMES.has(name)) {
      return { kind: 'not_found', detail };
    }

    if (isConnectionOrTimeoutLike(error)) {
      return { kind: 'network_or_timeout', detail };
    }

    switch (status) {
      case 401:
        return { kind: 'invalid_credentials', detail };
      case 403:
        return { kind: 'access_denied', detail };
      case 404:
        return { kind: 'not_found', detail };
      default:
        break;
    }

    if (status !== undefined && status >= 500) {
      return { kind: 'network_or_timeout', detail };
    }

    // A shape we have no rule for is NOT assumed benign: it still rotates,
    // it still earns a cooldown. Landing here means S3 (or an S3-compatible
    // host behind a custom endpoint) grew a failure mode worth a branch.
    return { kind: 'unknown', detail };
  }
}
