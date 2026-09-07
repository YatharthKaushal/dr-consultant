/** `deleted_accounts`' own error vocabulary and `audit_log.entity_type` value — ADDITIVE (account-deletion lifecycle round). */
export const DELETED_ACCOUNTS_AUDIT_ENTITY_TYPES = {
  DELETED_ACCOUNT: 'deleted_account',
} as const;

export const DELETED_ACCOUNTS_ERROR_CODES = {
  DELETED_ACCOUNT_NOT_FOUND: 'DELETED_ACCOUNT_NOT_FOUND',
  /** `restore` called against a snapshot that already has a `restoredAt` — a delete -> restore -> delete cycle raises a NEW snapshot rather than reusing this one. */
  DELETED_ACCOUNT_ALREADY_RESTORED: 'DELETED_ACCOUNT_ALREADY_RESTORED',
  /**
   * *** THE ONE GENUINELY UNAVOIDABLE RESTORE FAILURE. *** The account's
   * original mobile number was reassigned to a NEWER sign-up after this
   * account was soft-deleted (`anonymizeMobileNumber` is exactly what makes
   * that possible — "if the user tries to access the account they have to
   * sign up again"). Restoring would collide with that newer account's own
   * `mobile_number` UNIQUE constraint, so this is refused loudly rather
   * than silently overwriting either account's sign-in identity.
   */
  MOBILE_NUMBER_REASSIGNED: 'MOBILE_NUMBER_REASSIGNED',
} as const;

export const DEFAULT_DELETED_ACCOUNTS_PAGE_SIZE = 20;
export const MAX_DELETED_ACCOUNTS_PAGE_SIZE = 100;
