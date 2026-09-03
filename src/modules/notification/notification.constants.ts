import type { NotificationTemplate, NotificationTemplateSet } from './notification-template.util';

/**
 * M-08's constants: the one `app_config` key it OWNS, the compiled-in default
 * copy behind that key, its error-code vocabulary and its `audit_log.
 * entity_type` values.
 *
 * Structure copied from `search.constants.ts` and `payment.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the
 * read fallbacks and `notification.seed.ts` can never drift apart.
 */

/** `audit_log.entity_type` values this module writes. */
export const NOTIFICATION_AUDIT_ENTITY_TYPES = {
  /**
   * The `notifications.templates` `app_config` key, edited from the admin
   * panel. `entity_id` is the key itself — the same convention
   * `search_config`/`payment_config` use, so an auditor asking who changed
   * notification copy does not have to know a uuid.
   *
   * WHICH template changed is `metadata.templateCode`, and `metadata.before`
   * /`metadata.after` carry THAT ONE template rather than the whole map: a
   * diff of nine templates to show a one-word edit is a diff nobody reads.
   */
  CONFIG: 'notification_config',
} as const;

/** Error codes this module returns in `{ code, message }` bodies. */
export const NOTIFICATION_ERROR_CODES = {
  /**
   * *** FR-16.2. *** An admin tried to save copy that names a diagnosis. A
   * `ConflictException` rather than a validation error because it is not a
   * malformed body — it is a well-formed body the platform's rules refuse.
   * The offending construction is named in the message so the admin can
   * re-word rather than guess.
   */
  TEMPLATE_NAMES_DIAGNOSIS: 'NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS',
  /** A `PUT /admin/notifications/templates/:code` body that is not usable copy (empty, over-long, wrong type). */
  TEMPLATE_INVALID: 'NOTIFICATION_TEMPLATE_INVALID',
  /** A `DELETE` naming a code that is neither stored nor compiled in. */
  TEMPLATE_NOT_FOUND: 'NOTIFICATION_TEMPLATE_NOT_FOUND',
  /** A `template_code` outside `TEMPLATE_CODE_PATTERN`, or longer than `notifications.template_code`'s `varchar(80)`. */
  TEMPLATE_CODE_INVALID: 'NOTIFICATION_TEMPLATE_CODE_INVALID',
  /** A write naming an `app_config` key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'NOTIFICATION_CONFIG_KEY_NOT_OWNED',
  /** A `notifications` row that does not exist, or does not belong to the caller. One code for both — see `notification.service.ts#markRead`. */
  NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  /** A device-token registration from an account type that has no push channel (admin), per `notifications.admin_id`'s schema comment. */
  DEVICE_TOKEN_NOT_SUPPORTED: 'NOTIFICATION_DEVICE_TOKEN_NOT_SUPPORTED',
} as const;
export type NotificationErrorCode =
  (typeof NOTIFICATION_ERROR_CODES)[keyof typeof NOTIFICATION_ERROR_CODES];

/**
 * The `app_config` keys M-08 OWNS — one of them.
 *
 * `docs/erd.sql`'s `app_config` table comment lists `notifications.templates`
 * by name in its inventory of "everything the admin can change without a
 * release". There is deliberately no templates TABLE: copy is configuration,
 * not an entity, and `docs/MODULES.md` §7's rule is "configuration lives with
 * its owning module and is edited from the admin panel".
 */
export const NOTIFICATION_CONFIG_KEYS = {
  /** `Record<template_code, { title, body }>`. See `notification-template.util.ts`. */
  TEMPLATES: 'notifications.templates',
} as const;
export type NotificationConfigKey =
  (typeof NOTIFICATION_CONFIG_KEYS)[keyof typeof NOTIFICATION_CONFIG_KEYS];

export const NOTIFICATION_CONFIG_KEY_LIST: readonly NotificationConfigKey[] =
  Object.values(NOTIFICATION_CONFIG_KEYS);

/**
 * The nine template codes `notifications.template_code`'s own schema comment
 * names. Not an exhaustive list of what may ever exist — the admin surface
 * accepts any code matching `TEMPLATE_CODE_PATTERN`, so M-16's follow-up
 * copy and M-18's Care Hub copy can be added with no release, which is the
 * entire point of FR-16.3. These nine are the ones the schema already
 * commits to, so these nine ship with default copy.
 */
export const NOTIFICATION_TEMPLATE_CODES = {
  /** Patient, FR-16.1. */
  BOOKING_CONFIRMED: 'booking_confirmed',
  CONSULT_REMINDER: 'consult_reminder',
  DOCTOR_JOINED: 'doctor_joined',
  PRESCRIPTION_READY: 'prescription_ready',
  CHECKIN_DUE: 'checkin_due',
  /** Doctor, FR-16.4. */
  INSTANT_REQUEST: 'instant_request',
  RED_FLAG_ALERT: 'red_flag_alert',
  DOCUMENT_REJECTED: 'document_rejected',
  DOCTOR_APPROVED: 'doctor_approved',
} as const;
export type NotificationTemplateCode =
  (typeof NOTIFICATION_TEMPLATE_CODES)[keyof typeof NOTIFICATION_TEMPLATE_CODES];

/**
 * *** THE COMPILED-IN DEFAULT COPY. ***
 *
 * Every read of `notifications.templates` falls back to this per code, so a
 * fresh install sends correct notifications before `db:seed:notifications`
 * has ever run and a hand-deleted row degrades to the default rather than
 * silencing a booking confirmation. Same discipline as
 * `SEARCH_CONFIG_FALLBACKS` and `PAYMENT_CONFIG_FALLBACKS`.
 *
 * ===========================================================================
 * *** CLINICIAN AND CLIENT SIGN-OFF BEFORE LAUNCH (SRS §8). ***
 * "All clinical content ... must be reviewed and approved by a qualified
 * clinician before launch", and `docs/MODULES.md` §7: "modules provide the
 * tools, not the wording." Every string below is a DEVELOPER STARTER SET so
 * the mechanism is demonstrable end to end on day one. All of it is editable
 * from the admin panel with no app release (FR-16.3), which is the whole
 * reason it lives in `app_config`.
 * ===========================================================================
 *
 * Every one of these passes `screenForDiagnosis` — asserted by a test that
 * walks this object, so a future edit that names a condition fails CI rather
 * than reaching a lock screen.
 *
 * The copy is deliberately EVENT-SHAPED, never clinical: it says something
 * happened and where to tap. None of it describes why a consultation was
 * booked, what a check-in is about, or what a red flag was raised for —
 * which is how FR-16.2 is met by construction rather than by screening.
 */
export const NOTIFICATION_TEMPLATE_DEFAULTS: Readonly<Record<NotificationTemplateCode, NotificationTemplate>> = {
  [NOTIFICATION_TEMPLATE_CODES.BOOKING_CONFIRMED]: {
    title: 'Appointment confirmed',
    body: 'Your consultation with {{doctorName}} is confirmed for {{scheduledAt}}. Tap to see the details.',
  },
  [NOTIFICATION_TEMPLATE_CODES.CONSULT_REMINDER]: {
    title: 'Your consultation starts soon',
    body: 'Your consultation with {{doctorName}} starts at {{scheduledAt}}. Tap to be ready to join.',
  },
  [NOTIFICATION_TEMPLATE_CODES.DOCTOR_JOINED]: {
    title: 'Your doctor has joined',
    body: '{{doctorName}} is waiting in the consultation room. Tap to join now.',
  },
  [NOTIFICATION_TEMPLATE_CODES.PRESCRIPTION_READY]: {
    title: 'Your prescription is ready',
    body: 'The prescription from your consultation with {{doctorName}} is now available in the app.',
  },
  [NOTIFICATION_TEMPLATE_CODES.CHECKIN_DUE]: {
    // FR-16.1's "check-in due". Says nothing about what the check-in is for
    // — a follow-up pathway is attached to a clinical reason, and naming it
    // here is exactly the disclosure FR-16.2 exists to prevent.
    title: 'Time for your check-in',
    body: 'Your scheduled check-in is due. Tap to answer a few short questions.',
  },
  [NOTIFICATION_TEMPLATE_CODES.INSTANT_REQUEST]: {
    // Doctor-facing, M-13. "You have {{expiresInSeconds}} seconds" is the
    // reason bare "you have" is NOT on the deny-list — see
    // `notification-diagnosis.util.ts`.
    title: 'New instant consult request',
    body: 'A patient is waiting for an instant consultation. You have {{expiresInSeconds}} seconds to accept.',
  },
  [NOTIFICATION_TEMPLATE_CODES.RED_FLAG_ALERT]: {
    // Doctor and care_coordinator, FR-16.4 / M-16. Urgency without content:
    // it says a case needs attention, never what was flagged.
    title: 'A case needs your attention',
    body: 'A case you are responsible for has been flagged for review. Tap to open it now.',
  },
  [NOTIFICATION_TEMPLATE_CODES.DOCUMENT_REJECTED]: {
    // Doctor onboarding, M-05. `{{reason}}` is the one genuinely free-form
    // variable in the default set — an admin reviewer types it — which is
    // why send-time screening exists at all.
    title: 'A document needs attention',
    body: 'Your {{documentType}} could not be verified: {{reason}}. Tap to upload it again.',
  },
  [NOTIFICATION_TEMPLATE_CODES.DOCTOR_APPROVED]: {
    title: 'Your account is approved',
    body: 'Your account has been verified. You can now be booked for consultations.',
  },
};

/** What `notification.seed.ts` writes into `app_config` under `notifications.templates`. */
export const NOTIFICATION_APP_CONFIG_DEFAULTS: Readonly<Record<NotificationConfigKey, unknown>> = {
  [NOTIFICATION_CONFIG_KEYS.TEMPLATES]: NOTIFICATION_TEMPLATE_DEFAULTS as NotificationTemplateSet,
};

/**
 * `notifications.failure_reason` is `varchar(200)`. A reason longer than
 * that would be a Postgres error on a row whose whole purpose is to record
 * that something already went wrong, so it is truncated on the way in.
 */
export const FAILURE_REASON_MAX_LENGTH = 200;

/** Default page size for the in-app list, and the ceiling a client may ask for. */
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 20;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

/**
 * DI token for the push channel, bound to `FcmPushAdapter` in
 * `notification.module.ts`. Mirrors `SEARCH_AI_PORT`.
 *
 * `notification.service.ts` depends on the `PushProvider` interface and never
 * on `firebase-admin`, which is what lets the service's rules be unit-tested
 * with a hand-rolled `jest.fn()` and no vendor SDK loaded. Rebinding this
 * token is also the hard kill switch for push — harder than an unset
 * credential, which merely degrades every send.
 */
export const NOTIFICATION_PUSH_PORT = Symbol('NOTIFICATION_PUSH_PORT');
