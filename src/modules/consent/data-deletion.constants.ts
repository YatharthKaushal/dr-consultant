/**
 * FR-2.5's error vocabulary and its `audit_log.entity_type` values. Structure
 * copied from `consent.constants.ts` — see that file's own header for why.
 */

/** `audit_log.entity_type` values this feature writes. */
export const DATA_DELETION_AUDIT_ENTITY_TYPES = {
  DATA_DELETION_REQUEST: 'data_deletion_request',
} as const;

export const DATA_DELETION_ERROR_CODES = {
  DATA_DELETION_REQUEST_NOT_FOUND: 'DATA_DELETION_REQUEST_NOT_FOUND',
  /**
   * The status named is not one this module may set — `executed`/`failed` are
   * M-21's job (see `data-deletion.service.ts#reviewRequest`'s header) or the
   * transition itself is illegal (e.g. `approved` back to `in_review`).
   */
  DATA_DELETION_ILLEGAL_TRANSITION: 'DATA_DELETION_ILLEGAL_TRANSITION',
  /**
   * ADDITIVE (M-21/data rights execution). `recordExecutionOutcome` was
   * called against a request that is not currently `approved` — either it
   * was never reviewed, was rejected, or has already been executed once.
   */
  DATA_DELETION_NOT_APPROVED: 'DATA_DELETION_NOT_APPROVED',
  /** ADDITIVE (account-deletion lifecycle round). `cancelRequest` called against a request no longer in `requested`/`in_review`/`approved`. */
  DATA_DELETION_NOT_CANCELLABLE: 'DATA_DELETION_NOT_CANCELLABLE',
} as const;
export type DataDeletionErrorCode = (typeof DATA_DELETION_ERROR_CODES)[keyof typeof DATA_DELETION_ERROR_CODES];

export const DEFAULT_DATA_DELETION_PAGE_SIZE = 20;
export const MAX_DATA_DELETION_PAGE_SIZE = 100;

/**
 * ADDITIVE (account-deletion lifecycle round). This module's own
 * `app_config` keys — read via `AppConfigService`, same shared/memoized
 * read-only surface every other module's config uses. There is no WRITE
 * path/admin screen for these yet (a deliberate, stated scope cut — see the
 * build report); an admin who wants a different grace period edits the
 * `app_config` row directly until one exists.
 */
export const DATA_DELETION_CONFIG_KEYS = {
  /** Days between a request being raised and the sweep becoming eligible to auto-approve and execute it. */
  GRACE_PERIOD_DAYS: 'compliance.deletion_grace_period_days',
  /** Whether the sweep auto-executes a due, still-undecided request at all — `false` makes the grace period informational only, requiring an admin to act. */
  AUTO_EXECUTE: 'compliance.deletion_auto_execute',
} as const;

export const DATA_DELETION_DEFAULT_GRACE_PERIOD_DAYS = 30;
export const DATA_DELETION_DEFAULT_AUTO_EXECUTE = true;

/**
 * DI token for the `DataDeletionNotificationPort` implementation, bound in
 * `consent.module.ts` to the real `NotificationFacade` — see
 * `data-deletion-notification.contract.ts`'s header for why this indirection
 * exists even though M-08 is already merged.
 */
export const DATA_DELETION_NOTIFICATION_PORT = Symbol('DATA_DELETION_NOTIFICATION_PORT');

/**
 * ADDITIVE (deferred follow-up: notify on status change). None of these are
 * in `docs/erd.sql`'s `notifications.template_code` comment — the closed set
 * M-08 ships compiled defaults for. Like `INSTANT_NOTIFICATION_TEMPLATES`/
 * `FOLLOWUP_NOTIFICATION_TEMPLATES` before them, these are GENUINELY NEW
 * codes: they resolve ONLY once an admin configures a template for them
 * (`PUT /admin/notifications/templates/:code`) and degrade to
 * `reason: 'template_missing'`/nothing-queued until then — not a bug, the
 * established M-08 design (copy sign-off before anything ships to a user).
 *
 * *** NONE OF THESE MAY NAME A DIAGNOSIS (FR-16.2). *** This module never
 * passes anything beyond a status/date — a deletion request carries no
 * clinical content to begin with.
 */
export const DATA_DELETION_NOTIFICATION_TEMPLATES = {
  /** To the requester: their request was received, with the scheduled deletion date. */
  REQUESTED: 'data_deletion_requested',
  /** To the requester: an admin (or the grace-period sweep) approved the request. */
  APPROVED: 'data_deletion_approved',
  /** To the requester: an admin rejected the request. */
  REJECTED: 'data_deletion_rejected',
  /** To the requester: they cancelled their own request. */
  CANCELLED: 'data_deletion_cancelled',
  /** To the requester: execution completed and their account is deactivated. Sent on success only — see `data-deletion.service.ts#recordExecutionOutcome`'s own comment for why `failed` is internal-only. */
  EXECUTED: 'data_deletion_executed',
} as const;
