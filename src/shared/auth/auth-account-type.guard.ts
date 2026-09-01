import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccountType } from '../../schema/enums.schema';
import { ACCOUNT_TYPES_KEY, AUTH_ERROR_CODES } from './auth.constants';
import type { AuthContext } from './auth.types';

/**
 * Global guard, runs second (after `JwtAuthGuard`). No-ops on a route
 * without `@AccountType(...)` metadata. This is the reusable "stack
 * anything on top" primitive resource-owning modules (M-04 patient profile,
 * M-05 doctor registry, ...) layer their own ownership checks on top of —
 * RBAC/ABAC itself stays admin-only (`PermissionGuard`).
 */
@Injectable()
export class AccountTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AccountType[] | undefined>(ACCOUNT_TYPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = request.auth;
    if (!auth || !required.includes(auth.accountType)) {
      throw new ForbiddenException({
        code: AUTH_ERROR_CODES.WRONG_ACCOUNT_TYPE,
        message: 'This endpoint is not available for your account type.',
      });
    }

    return true;
  }
}
