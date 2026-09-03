/**
 * The push-delivery seam. `notification.service.ts` depends on `PushProvider`
 * and never on `firebase-admin`, so the module's rules can be unit-tested
 * with a hand-rolled `jest.fn()` and no vendor SDK anywhere near them.
 *
 * Mirrors `StorageProviderAdapter`/`StorageErrorClassifier`
 * (`storage-provider.types.ts`) and `LlmProviderAdapter`
 * (`llm-provider.types.ts`): an adapter that owns the vendor, a classifier
 * that owns the vendor's error shapes, and a caller that sees neither.
 */

/**
 * WHICH APP a push goes to.
 *
 * `docs/MODULES.md` M-08: "Separate push credentials per app, since the
 * patient and doctor apps are separate store listings." They are two Firebase
 * projects with two service accounts, so `firebase-admin` is initialised
 * TWICE, under two names — see `fcm-push.adapter.ts`.
 *
 * There is no `'admin'` key, deliberately. `notifications.admin_id`'s schema
 * comment says admins are "read in the panel — admins have no push token";
 * the panel is a web app with no store listing and no FCM project. An admin
 * notification is complete when its row exists.
 */
export const PUSH_APP_KEYS = ['patient', 'doctor'] as const;
export type PushAppKey = (typeof PUSH_APP_KEYS)[number];

export interface PushMessage {
  /** The account's registered FCM registration token (`patients.push_token` / `doctors.push_token`). */
  token: string;
  title: string;
  body: string;
  /** FCM's `data` block. Every value must already be a string — FCM rejects anything else. */
  data?: Record<string, string>;
}

/**
 * One classified push failure. The vendor's own error object never escapes
 * its classifier, exactly as in `modules/storage` and `modules/ai`.
 *
 * `unregistered_token` is the one kind with a side effect attached: FCM is
 * telling us the token is dead (the app was uninstalled, or the token was
 * rotated), so `notification.service.ts` CLEARS it from the account row. Not
 * doing so leaves every future notification to that account failing forever
 * against a token FCM has already disowned.
 */
export type PushFailureKind =
  | 'not_configured'
  | 'invalid_token'
  | 'unregistered_token'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

export interface PushFailure {
  kind: PushFailureKind;
  /** Short vendor text, whitespace-collapsed and bounded. Server-side logs and `notifications.failure_reason` only — never returned to an HTTP caller. */
  detail: string;
}

export type PushSendResult =
  | { delivered: true; messageId: string }
  | { delivered: false; failure: PushFailure };

/** Normalises one vendor's error shapes to one `PushFailureKind`. Must never throw and never return `undefined` — an unrecognised shape is `unknown`. */
export interface PushErrorClassifier {
  classify(error: unknown): PushFailure;
}

export interface PushProvider {
  /**
   * True when this app's REQUIRED ENVIRONMENT credentials are present and
   * usable. Synchronous, side-effect free, and a capability check rather than
   * a live probe — it does not confirm the credentials are ACCEPTED by
   * Google, only that they are configured. Same contract as
   * `StorageProviderAdapter.isConfigured`.
   */
  isConfigured(app: PushAppKey): boolean;

  /**
   * *** NEVER THROWS. *** Every failure, including an unconfigured app, comes
   * back as `{ delivered: false, failure }`. `NotificationContract.notify` is
   * documented as never throwing into a caller's flow, and the cheapest way
   * to make that true is for the layer that talks to the network to not throw
   * either.
   */
  send(app: PushAppKey, message: PushMessage): Promise<PushSendResult>;
}
