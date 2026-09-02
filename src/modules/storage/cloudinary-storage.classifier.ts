import type { StorageErrorClassifier, StorageFailure } from './storage-provider.types';
import { isConnectionOrTimeoutLike, readMessage, readStatus, toDetail } from './storage-error.util';

/**
 * Normalises errors from the `cloudinary` Node SDK — `uploader.upload_stream`,
 * `uploader.destroy`, and `utils.private_download_url` (which signs locally
 * and essentially cannot fail at runtime except on a construction-time
 * problem; see `cloudinary-storage.adapter.ts`'s note).
 *
 * Verified against the installed `cloudinary@2.11.0`'s own type declarations
 * (`node_modules/cloudinary/types/index.d.ts`): the SDK's own
 * `UploadApiErrorResponse` shape is `{ message: string; name: string;
 * http_code: number; request_id?: string }` — a plain object, not a custom
 * `Error` subclass, and `http_code` is the ONLY status-like signal it
 * carries (no separate error-code enum the way S3's `.name` is one). This is
 * why classification here leans on `http_code` first rather than a name
 * list: Cloudinary does not give us the AWS-style granularity of "which
 * named condition" beyond the HTTP status and the message text.
 */
export class CloudinaryClassifier implements StorageErrorClassifier {
  classify(error: unknown): StorageFailure {
    const status = readStatus(error);
    const message = readMessage(error);
    const detail = toDetail(message);

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

    // Cloudinary's own wording is fairly stable across its API surface for
    // these two cases, and worth catching even without a status (some SDK
    // call paths, e.g. a config problem caught before any HTTP request, throw
    // a plain Error with no http_code at all).
    const lower = message.toLowerCase();
    if (lower.includes('invalid api_key') || lower.includes('invalid signature') || lower.includes('unknown api_key')) {
      return { kind: 'invalid_credentials', detail };
    }
    if (lower.includes('not found')) {
      return { kind: 'not_found', detail };
    }

    return { kind: 'unknown', detail };
  }
}
