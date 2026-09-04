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
} as const;
export type DataDeletionErrorCode = (typeof DATA_DELETION_ERROR_CODES)[keyof typeof DATA_DELETION_ERROR_CODES];

export const DEFAULT_DATA_DELETION_PAGE_SIZE = 20;
export const MAX_DATA_DELETION_PAGE_SIZE = 100;
