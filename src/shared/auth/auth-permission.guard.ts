import { ForbiddenException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_CONTEXT_RESOLVER, AUTH_ERROR_CODES, REQUIRED_PERMISSIONS_KEY } from './auth.constants';
import type { AuthContext, AuthContextResolver } from './auth.types';
import type { PermissionKey } from './permission.catalog';

/**
 * Global guard, runs third (after `JwtAuthGuard` and `AccountTypeGuard`).
 * No-ops on a route without `@RequirePermission(...)` metadata; otherwise
 * requires `accountType === 'admin'` and every listed permission (ANDed).
 *
 * Has no special case for `super_admin` — the short-circuit that grants a
 * super_admin every permission lives entirely in
 * `identity-access.repository.ts`'s resolution query, not here. This guard
 * only ever asks "does the resolver say yes."
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONTEXT_RESOLVER) private readonly resolver: AuthContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = request.auth;
    if (!auth || auth.accountType !== 'admin') {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.PERMISSION_DENIED,
        message: 'This action requires admin permissions.',
      });
    }

    const allowed = await this.resolver.hasAllPermissions(auth.accountId, required);
    if (!allowed) {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.PERMISSION_DENIED,
        message: 'You do not have permission to perform this action.',
      });
    }

    return true;
  }
}
