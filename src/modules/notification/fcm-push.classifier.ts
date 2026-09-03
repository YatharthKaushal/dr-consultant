import type { PushErrorClassifier, PushFailure, PushFailureKind } from './notification-push.types';

/**
 * Normalises errors from `firebase-admin@14.3.0`'s messaging API.
 *
 * `FirebaseMessagingError` carries a `.code` of the form
 * `messaging/<reason>`, and app/credential failures surface as
 * `FirebaseAppError` with `app/<reason>`. Classification is DUCK-TYPED on
 * `.code` rather than `instanceof`, for the same reason `s3-storage.
 * classifier.ts` and `llm-error.util.ts` are: the credential and transport
 * layers below the messaging API throw plain errors and `GoogleError`s that
 * never reach a modelled Firebase class, and an `instanceof` chain would
 * silently drop them into `unknown`.
 *
 * The codes below are the documented FCM v1 error set. Two of them matter
 * more than the rest:
 *
 *   `messaging/registration-token-not-registered` — THE TOKEN IS DEAD. The
 *     app was uninstalled or the token rotated. Google's own guidance is to
 *     remove it from storage, and `notification.service.ts` does exactly
 *     that. Without it, every later notification to that account fails
 *     forever against a token FCM has already disowned.
 *
 *   `messaging/third-party-auth-error` — APNs, not FCM. FCM delivers to iOS
 *     THROUGH APNs, so one SDK covers both platforms, but an APNs
 *     certificate/key problem surfaces here rather than as an FCM auth error.
 *     Classified as `invalid_credentials` because that is what it is, just
 *     one hop further down.
 */
const CODE_TO_KIND: Readonly<Record<string, PushFailureKind>> = {
  // Dead token — the caller clears it.
  'messaging/registration-token-not-registered': 'unregistered_token',
  // Malformed or wrong-project token. NOT cleared: a token rejected because
  // it belongs to the other app's Firebase project is still a valid token,
  // and deleting it would hide a misconfiguration rather than surface it.
  'messaging/invalid-registration-token': 'invalid_token',
  'messaging/invalid-recipient': 'invalid_token',
  'messaging/mismatched-credential': 'invalid_token',
  // Credentials.
  'messaging/authentication-error': 'invalid_credentials',
  'messaging/third-party-auth-error': 'invalid_credentials',
  'messaging/invalid-apns-credentials': 'invalid_credentials',
  'app/invalid-credential': 'invalid_credentials',
  'app/invalid-app-options': 'invalid_credentials',
  // Throttling.
  'messaging/message-rate-exceeded': 'rate_limited',
  'messaging/device-message-rate-exceeded': 'rate_limited',
  'messaging/topics-message-rate-exceeded': 'rate_limited',
  'messaging/quota-exceeded': 'rate_limited',
  // Transient.
  'messaging/server-unavailable': 'unavailable',
  'messaging/internal-error': 'unavailable',
  'messaging/unknown-error': 'unavailable',
};

/** Node/undici transport failures, which never reach a Firebase error code. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** `notifications.failure_reason` is `varchar(200)`; this leaves room for the `kind:` prefix the service adds. */
const MAX_DETAIL_LENGTH = 140;

/** Whitespace-collapsed, bounded vendor text. Never returned to an HTTP caller. */
export function toDetail(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'no detail';
  return collapsed.length <= MAX_DETAIL_LENGTH ? collapsed : `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…`;
}

function readCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/**
 * `String(error)` is deliberately the LAST resort and not the first, because
 * it is the one line here that can throw: an object with a null prototype
 * (`Object.create(null)`) has no `toString`, and `String()` on it raises
 * "Cannot convert object to primitive value". Every earlier branch handles
 * the shapes that actually occur, and the fallback is guarded so an exotic
 * one cannot break the rule this classifier exists to keep.
 */
function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  try {
    return String(error);
  } catch {
    return '';
  }
}

export class FcmPushClassifier implements PushErrorClassifier {
  /**
   * *** NEVER THROWS, AND NEVER RETURNS `undefined`. ***
   *
   * `PushErrorClassifier` states that contract and this is where it is kept.
   * It matters more here than the wording suggests: this method runs on the
   * failure path of a `notify` call that is itself documented as never
   * throwing into a caller's flow, so a classifier that threw would convert a
   * push failure into a booking failure. The whole body is therefore wrapped
   * — reading `.code` off a hostile object is enough to raise, and an
   * unclassifiable error is still just an unclassified push failure.
   */
  classify(error: unknown): PushFailure {
    try {
      const code = readCode(error);
      const detail = toDetail(readMessage(error));

      const mapped = CODE_TO_KIND[code];
      if (mapped !== undefined) return { kind: mapped, detail };

      if (CONNECTION_ERROR_CODES.has(code)) return { kind: 'unavailable', detail };

      // An unrecognised shape is `unknown`, never benign — the same rule
      // `StorageErrorClassifier` states. `unknown` still records a failed row
      // with the vendor detail, so an unclassified error is visible rather
      // than swallowed.
      return { kind: 'unknown', detail };
    } catch {
      return { kind: 'unknown', detail: 'unreadable error' };
    }
  }
}
