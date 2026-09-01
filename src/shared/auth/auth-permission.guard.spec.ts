import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PermissionGuard } from './auth-permission.guard';
import type { AuthContext, AuthContextResolver } from './auth.types';
import { PERMISSIONS } from './permission.catalog';

function createReflector(returnValue: unknown): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(returnValue) } as unknown as Reflector;
}

function createResolver(overrides: Partial<AuthContextResolver> = {}): AuthContextResolver {
  return {
    resolveAccessToken: jest.fn(),
    hasAllPermissions: jest.fn(),
    listEffectivePermissions: jest.fn(),
    ...overrides,
  };
}

function createContext(auth?: AuthContext): ExecutionContext {
  const request = { auth };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('PermissionGuard', () => {
  it('no-ops when the route has no @RequirePermission metadata', async () => {
    const resolver = createResolver();
    const guard = new PermissionGuard(createReflector(undefined), resolver);

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(resolver.hasAllPermissions).not.toHaveBeenCalled();
  });

  it('rejects a non-admin account type outright, without asking the resolver', async () => {
    const resolver = createResolver();
    const guard = new PermissionGuard(createReflector([PERMISSIONS.DOCTORS_VERIFY]), resolver);
    const context = createContext({ accountType: 'patient', accountId: 'p1' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(resolver.hasAllPermissions).not.toHaveBeenCalled();
  });

  it('allows when the resolver confirms every required permission (AND semantics)', async () => {
    const resolver = createResolver({ hasAllPermissions: jest.fn().mockResolvedValue(true) });
    const required = [PERMISSIONS.DOCTORS_VERIFY, PERMISSIONS.DOCTORS_MANAGE_EXPERT_ROLE];
    const guard = new PermissionGuard(createReflector(required), resolver);
    const context = createContext({ accountType: 'admin', accountId: 'a1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolver.hasAllPermissions).toHaveBeenCalledWith('a1', required);
  });

  it('rejects when the resolver says even one required permission is missing', async () => {
    const resolver = createResolver({ hasAllPermissions: jest.fn().mockResolvedValue(false) });
    const guard = new PermissionGuard(createReflector([PERMISSIONS.DOCTORS_VERIFY]), resolver);
    const context = createContext({ accountType: 'admin', accountId: 'a1' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super_admin passes because the resolver itself short-circuits — the guard has no special case', async () => {
    const resolver = createResolver({ hasAllPermissions: jest.fn().mockResolvedValue(true) });
    const guard = new PermissionGuard(createReflector([PERMISSIONS.CONFIG_MANAGE]), resolver);
    const context = createContext({ accountType: 'admin', accountId: 'super-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
