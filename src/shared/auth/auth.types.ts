import type { AccountType } from '../../schema/enums.schema';
import type { PermissionKey } from './permission.catalog';

/**
 * What lands on `request.auth` once `JwtAuthGuard` resolves a token. Carries
 * no permission list (decision: resolve fresh per request, not eager-load —
 * loading permissions for every admin request would cost a query even on
 * endpoints with no `@RequirePermission`), and no `status`/`tokenVersion` —
 * both are validation-time concerns already spent inside
 * `resolveAccessToken`; by construction, a non-null `AuthContext` already
 * means "this account is currently allowed to authenticate."
 */
export interface AuthContext {
  accountType: AccountType;
  accountId: string;
}

interface BaseTokenPayload {
  /** Account id. */
  sub: string;
  /** Account type. */
  act: AccountType;
  /** `tokenVersion` at mint time — compared against the account row's current value on every use. */
  tv: number;
  iss: string;
  iat: number;
  exp: number;
}

export interface AccessTokenPayload extends BaseTokenPayload {
  typ: 'access';
}

export interface RefreshTokenPayload extends BaseTokenPayload {
  typ: 'refresh';
}

/**
 * The contract `shared/auth`'s guards depend on, implemented by
 * `modules/identity` and bound to `AUTH_CONTEXT_RESOLVER`. Declaring it here
 * (rather than importing identity's own service types) is what keeps the
 * dependency direction module -> shared instead of the reverse, per
 * `backend/README.md`'s "`src/shared` is imported by modules and never
 * imports them" — the same DI-token pattern `database.module.ts` already
 * uses for `DATABASE`.
 */
export interface AuthContextResolver {
  /** Verifies signature, `typ === 'access'`, issuer, `tokenVersion` and account status. Never throws — returns `null` on any failure. */
  resolveAccessToken(token: string): Promise<AuthContext | null>;
  /** True only if every key in `keys` is in the admin's effective permission set (role bundles ∪ direct grants). ANDed, not ORed. */
  hasAllPermissions(adminId: string, keys: readonly PermissionKey[]): Promise<boolean>;
  /** For `GET /auth/me` — the full effective set, not narrowed to a check. */
  listEffectivePermissions(adminId: string): Promise<PermissionKey[]>;
}
