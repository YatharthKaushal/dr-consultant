/**
 * `app_config` keys this module reads (never writes — the write side, with
 * an audited before/after, belongs to whichever module builds the admin
 * config screen). Thresholds live in `app_config` rather than env because
 * SRS 6.6 requires them editable from the admin panel without a release.
 */
export const IDENTITY_APP_CONFIG_KEYS = {
  OTP_REQUEST_MAX_PER_NUMBER_PER_HOUR: 'otp.request.max_per_number_per_hour',
  OTP_REQUEST_MAX_PER_IP_PER_HOUR: 'otp.request.max_per_ip_per_hour',
  OTP_RESEND_MAX_PER_CHALLENGE: 'otp.resend.max_per_challenge',
  OTP_RESEND_COOLDOWN_SECONDS: 'otp.resend.cooldown_seconds',
  OTP_VERIFY_MAX_ATTEMPTS_PER_CHALLENGE: 'otp.verify.max_attempts_per_challenge',
  OTP_CHALLENGE_TTL_SECONDS: 'otp.challenge.ttl_seconds',
  OTP_PROVIDER_RETRY_AFTER_SECONDS: 'otp.provider.retry_after_seconds',
  RETENTION_OTP_CHALLENGES_DAYS: 'retention.otp_challenges_days',
} as const;

/**
 * Compiled-in fallbacks — every `AppConfigService` read in this module
 * passes one of these, so a missing or not-yet-seeded row degrades to a
 * sane default rather than breaking sign-in. Also what `identity.seed.ts`
 * inserts on first run.
 */
export const IDENTITY_APP_CONFIG_DEFAULTS: Record<string, number> = {
  [IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_NUMBER_PER_HOUR]: 5,
  [IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_IP_PER_HOUR]: 20,
  [IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_MAX_PER_CHALLENGE]: 3,
  [IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_COOLDOWN_SECONDS]: 30,
  [IDENTITY_APP_CONFIG_KEYS.OTP_VERIFY_MAX_ATTEMPTS_PER_CHALLENGE]: 5,
  [IDENTITY_APP_CONFIG_KEYS.OTP_CHALLENGE_TTL_SECONDS]: 300,
  [IDENTITY_APP_CONFIG_KEYS.OTP_PROVIDER_RETRY_AFTER_SECONDS]: 60,
  [IDENTITY_APP_CONFIG_KEYS.RETENTION_OTP_CHALLENGES_DAYS]: 30,
};

/** `audit_log.entity_type` values this module writes. */
export const IDENTITY_AUDIT_ENTITY_TYPES = {
  SESSION: 'session',
  ADMIN: 'admin',
  ADMIN_ROLE: 'admin_role',
  ADMIN_PERMISSION_GRANT: 'admin_permission_grant',
  SEED: 'seed',
} as const;

export const IDENTITY_ERROR_CODES = {
  ACCOUNT_NOT_FOUND_FOR_ROLE: 'ACCOUNT_NOT_FOUND_FOR_ROLE',
  /** `GET /auth/me`: the account summary vanished between token resolution and this read — distinct from `ADMIN_NOT_FOUND` (an admin-management target lookup). */
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  CHALLENGE_ALREADY_USED: 'CHALLENGE_ALREADY_USED',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  INVALID_OTP: 'INVALID_OTP',
  OTP_SEND_FAILED: 'OTP_SEND_FAILED',
  OTP_RESEND_FAILED: 'OTP_RESEND_FAILED',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  OTP_PROVIDER_UNAVAILABLE: 'OTP_PROVIDER_UNAVAILABLE',
  RESEND_COOLDOWN: 'RESEND_COOLDOWN',
  RESEND_LIMIT_REACHED: 'RESEND_LIMIT_REACHED',
  REQUEST_RATE_LIMITED: 'REQUEST_RATE_LIMITED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  CANNOT_MODIFY_SELF: 'CANNOT_MODIFY_SELF',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  ADMIN_NOT_FOUND: 'ADMIN_NOT_FOUND',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  PERMISSION_NOT_FOUND: 'PERMISSION_NOT_FOUND',
  MOBILE_NUMBER_TAKEN: 'MOBILE_NUMBER_TAKEN',
} as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];
