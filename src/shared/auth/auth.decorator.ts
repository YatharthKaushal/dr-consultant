import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccountType as AccountTypeValue } from '../../schema/enums.schema';
import { ACCOUNT_TYPES_KEY, IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from './auth.constants';
import type { AuthContext } from './auth.types';
import type { PermissionKey } from './permission.catalog';

/** Marks a route reachable without a bearer token. Every route requires one by default. */
export function Public(): MethodDecorator & ClassDecorator {
  return SetMetadata(IS_PUBLIC_KEY, true);
}

/** Restricts a route to one or more account types — e.g. `@AccountType('admin')`. */
export function AccountType(...types: AccountTypeValue[]): MethodDecorator & ClassDecorator {
  return SetMetadata(ACCOUNT_TYPES_KEY, types);
}

/**
 * Requires an admin to hold every listed permission (ANDed — no OR
 * semantics; nothing in the permission catalog needs it, and adding it now
 * would double the decorator's surface for no current use). Implies
 * `@AccountType('admin')`; `PermissionGuard` rejects any other account type
 * outright before checking permissions.
 */
export function RequirePermission(...keys: PermissionKey[]): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_PERMISSIONS_KEY, keys);
}

/** Injects the resolved `AuthContext` — only valid on a route `JwtAuthGuard` has already run for. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
  if (!request.auth) {
    throw new Error('@CurrentUser() used on a route with no JwtAuthGuard — this should be unreachable.');
  }
  return request.auth;
});
