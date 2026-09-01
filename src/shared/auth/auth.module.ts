import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountTypeGuard } from './auth-account-type.guard';
import { PermissionGuard } from './auth-permission.guard';
import { JwtAuthGuard } from './auth.guard';

/**
 * Registers the three auth guards globally, in order: authenticate, then
 * account-type check, then permission check. Each guard's own `AUTH_CONTEXT_
 * RESOLVER` dependency is resolved from `IdentityModule` (`@Global()`) —
 * Nest resolves global providers regardless of module import order, but
 * `AppModule` imports `IdentityModule` before this module so the dependency
 * reads top-to-bottom.
 */
@Module({
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AccountTypeGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AuthModule {}
