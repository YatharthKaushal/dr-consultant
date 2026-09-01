/** DI token for the `AuthContextResolver` implementation, bound by `IdentityModule`. */
export const AUTH_CONTEXT_RESOLVER = Symbol('AUTH_CONTEXT_RESOLVER');

/** Reflector metadata keys, set by the decorators in `auth.decorator.ts`. */
export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ACCOUNT_TYPES_KEY = 'auth:accountTypes';
export const REQUIRED_PERMISSIONS_KEY = 'auth:requiredPermissions';

export const BEARER_PREFIX = 'Bearer ';

/**
 * `resolveAccessToken` collapses every failure reason (missing, malformed,
 * expired, wrong `typ`, stale `tokenVersion`, inactive account) into a
 * single `null` — the guard therefore reports one uniform code rather than
 * leaking which check failed, which is free reconnaissance to an attacker
 * and not asked for by anything in the SRS.
 */
export const AUTH_ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  WRONG_ACCOUNT_TYPE: 'WRONG_ACCOUNT_TYPE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
