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
