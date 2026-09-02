import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AccountTypeGuard } from './auth-account-type.guard';
import type { AuthContext } from './auth.types';

function createReflector(returnValue: unknown): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(returnValue) } as unknown as Reflector;
}

function createContext(auth?: AuthContext): ExecutionContext {
  const request = { auth };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('AccountTypeGuard', () => {
  it('no-ops when the route has no @AccountType metadata', () => {
    const guard = new AccountTypeGuard(createReflector(undefined));

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('no-ops when the route metadata is an empty array', () => {
    const guard = new AccountTypeGuard(createReflector([]));

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('rejects when there is no auth context at all', () => {
    const guard = new AccountTypeGuard(createReflector(['doctor']));

    expect(() => guard.canActivate(createContext())).toThrow(ForbiddenException);
  });

  it('rejects an account type not in the required list', () => {
    const guard = new AccountTypeGuard(createReflector(['doctor']));
    const context = createContext({ accountType: 'patient', accountId: 'p1' });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows an account type that IS in the required list', () => {
    const guard = new AccountTypeGuard(createReflector(['doctor', 'admin']));
    const context = createContext({ accountType: 'doctor', accountId: 'd1' });

    expect(guard.canActivate(context)).toBe(true);
  });
});
