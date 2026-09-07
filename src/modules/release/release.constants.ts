/**
 * Force-update policy. One `app_config` key, `release.policy`, keyed
 * `{app}.{platform}` — `{ patient: { ios, android }, doctor: { ios, android
 * } }`. No migration: `app_config.value` is untyped jsonb, and this module
 * owns exactly this one key, the same discipline `pricing-config.
 * repository.ts`'s header states for `pricing.*`.
 *
 * Per-app-AND-per-platform rather than per-app-only: an iOS review delay is
 * routine and would otherwise force choosing between locking out Android
 * users early or leaving a broken iOS build reachable — see the module's
 * README-style header in `release.module.ts` for the full reasoning.
 */
export const RELEASE_CONFIG_KEYS = {
  POLICY: 'release.policy',
} as const;

export const RELEASE_CONFIG_KEY_LIST: readonly string[] = Object.values(RELEASE_CONFIG_KEYS);

/** `PUSH_APP_KEYS` (`notification-push.types.ts`) is the canonical "which app" discriminator — reused, not reinvented. */
export const RELEASE_PLATFORMS = ['ios', 'android'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/**
 * Deliberately permissive: `minimumSupportedVersion: '0.0.0'` never blocks
 * anyone. A misconfigured or never-configured deployment must fail OPEN —
 * the alternative (defaulting to a high minimum) would lock every app out
 * the moment this module first deploys, before an admin has ever touched
 * the screen.
 */
export const RELEASE_DEFAULT_ENTRY = {
  minimumSupportedVersion: '0.0.0',
  latestVersion: '0.0.0',
  storeUrl: null as string | null,
  message: null as string | null,
};

export const RELEASE_ERROR_CODES = {
  CONFIG_KEY_NOT_OWNED: 'RELEASE_CONFIG_KEY_NOT_OWNED',
  CONFIG_INVALID: 'RELEASE_CONFIG_INVALID',
  INVALID_VERSION: 'RELEASE_INVALID_VERSION',
} as const;

export const RELEASE_AUDIT_ENTITY_TYPES = {
  CONFIG: 'release_config',
} as const;
