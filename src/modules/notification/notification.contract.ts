/**
 * M-08's public surface. Every other module raises a notification through
 * this and nothing else — never `notifications`, never the FCM adapter, never
 * a template (`backend/README.md` §2). That is what M-08's done-when asks
 * for: "other modules raise notifications without knowing the delivery
 * channel."
 *
 * *** THE THREE INTERFACES BELOW ARE FROZEN. ***
 *
 * M-13 (presence/instant consult) is being built in a parallel worktree
 * against a LOCAL MIRROR of this file, bound to its own `NOTIFICATION_PORT`
 * token with a null object standing in until both merge. `NotificationFacade`
 * satisfies that mirror STRUCTURALLY — no adapter, no cast — which is the
 * whole point: a field renamed or an argument added here surfaces at M-13's
 * `{ provide: NOTIFICATION_PORT, useExisting: NotificationFacade }` as a
 * `tsc` error rather than as a runtime surprise after the merge. The same
 * discipline `SearchAiPort`/`AiFacade` and `PaymentContract`/`BookingModule`
 * already use.
 *
 * Do not add a required argument, rename a field, or narrow a type here
 * without changing M-13 in the same commit. M-13 cannot see this code.
 */

/**
 * One notification to raise.
 *
 * Note what is NOT here: there is no `title` and no `body`. A caller cannot
 * hand this module prose. That is the FIRST and strongest half of FR-16.2's
 * enforcement — see `notification-diagnosis.util.ts` for the full argument —
 * because the copy is always resolved from the admin-editable template set,
 * never supplied by the calling module.
 */
export interface NotificationRequest {
  /** e.g. 'instant_request'. Resolved against the admin-editable template set. */
  templateCode: string;
  audience: { kind: 'patient' | 'doctor' | 'admin'; id: string };
  /** Substituted into the template. MUST NOT carry a diagnosis (FR-16.2). */
  variables?: Record<string, string | number>;
  consultationId?: string;
  deepLinkData?: Record<string, unknown>;
}

export interface NotificationResult {
  queued: boolean;
  /** `notifications.id` is bigserial. Null when nothing was queued. */
  notificationId: number | null;
  /** Why not: 'no_device_token' | 'template_missing' | 'provider_unavailable' | 'suppressed'. */
  reason?: string;
}

export interface NotificationContract {
  /** Best-effort. MUST NOT throw into the caller's flow — a failed notification never fails a consult. */
  notify(request: NotificationRequest): Promise<NotificationResult>;
}

/* -------------------------------------------------------------------------- */
/* Reading the two fields above precisely — the semantics M-13 depends on.     */
/* -------------------------------------------------------------------------- */

/**
 * `queued` means A `notifications` ROW WAS WRITTEN, not "a push went out".
 *
 * The two are deliberately separate because the row IS the in-app
 * notification: `notifications` rows read back are what FR-16.1's "in-app
 * reminders" are, and `read_at` (not a status value) is what makes one read.
 * So a notification whose push could not be delivered is still a real,
 * useful, visible notification, and reporting `queued: false` for it would be
 * a lie to the caller.
 *
 * `reason` therefore answers "why was there no push delivery", and only
 * incidentally "why was nothing queued":
 *
 *   template_missing     — nothing written. The code resolves to no template,
 *                          so there is no copy to store or send.
 *   suppressed           — nothing written. The rendered copy tripped the
 *                          FR-16.2 screen. Deliberately no row: a row whose
 *                          `body` names a diagnosis is precisely what the
 *                          rule forbids, and half-redacting it would leave a
 *                          diagnosis with a hole in it.
 *   no_device_token      — ROW WRITTEN, status `failed`. The patient/doctor
 *                          has not registered an FCM token (or the one they
 *                          had was rejected as unregistered and cleared).
 *   provider_unavailable — ROW WRITTEN, status `failed`. FCM is not
 *                          configured for that app, or the send failed. This
 *                          is the "queued but not delivered" degradation an
 *                          unconfigured credential must produce.
 *
 * An `admin` audience returns NO reason and status `sent`: `notifications.
 * admin_id`'s own schema comment says admins are "read in the panel — admins
 * have no push token", so for an admin the row's existence IS the delivery.
 */
export const NOTIFICATION_RESULT_REASONS = {
  NO_DEVICE_TOKEN: 'no_device_token',
  TEMPLATE_MISSING: 'template_missing',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  SUPPRESSED: 'suppressed',
} as const;
export type NotificationResultReason =
  (typeof NOTIFICATION_RESULT_REASONS)[keyof typeof NOTIFICATION_RESULT_REASONS];

/** `NotificationRequest['audience']`, named — structurally identical, so it does not affect M-13's mirror. */
export type NotificationAudience = NotificationRequest['audience'];
export type NotificationAudienceKind = NotificationAudience['kind'];
