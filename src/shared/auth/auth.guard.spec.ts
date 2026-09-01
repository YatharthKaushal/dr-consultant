import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './auth.guard';
import type { AuthContext, AuthContextResolver } from './auth.types';

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

function createContext(headers: Record<string, string> = {}) {
  const request: { headers: Record<string, string>; auth?: AuthContext } = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  it('allows a @Public() route without ever calling the resolver', async () => {
    const resolver = createResolver();
    const guard = new JwtAuthGuard(createReflector(true), resolver);
    const { context } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolver.resolveAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    const guard = new JwtAuthGuard(createReflector(false), createResolver());
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a header that is not a Bearer token', async () => {
    const guard = new JwtAuthGuard(createReflector(false), createResolver());
    const { context } = createContext({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the resolver cannot resolve the token (expired, malformed, revoked, or inactive account)', async () => {
    const resolver = createResolver({ resolveAccessToken: jest.fn().mockResolvedValue(null) });
    const guard = new JwtAuthGuard(createReflector(false), resolver);
    const { context } = createContext({ authorization: 'Bearer bad-token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the resolved auth context to the request and allows the call', async () => {
    const auth: AuthContext = { accountType: 'admin', accountId: 'admin-1' };
    const resolver = createResolver({ resolveAccessToken: jest.fn().mockResolvedValue(auth) });
    const guard = new JwtAuthGuard(createReflector(false), resolver);
    const { context, request } = createContext({ authorization: 'Bearer good-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth).toEqual(auth);
    expect(resolver.resolveAccessToken).toHaveBeenCalledWith('good-token');
  });
});
