import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_CONTEXT_RESOLVER, AUTH_ERROR_CODES, BEARER_PREFIX, IS_PUBLIC_KEY } from './auth.constants';
import type { AuthContext, AuthContextResolver } from './auth.types';

interface RequestWithAuth {
  headers: { authorization?: string };
  auth?: AuthContext;
}

/**
 * Global guard (registered via `APP_GUARD` in `auth.module.ts`) — every
 * route requires a valid bearer token unless marked `@Public()`. Runs first
 * of the three global auth guards; `AccountTypeGuard` and `PermissionGuard`
 * both assume `request.auth` is already set by the time they run.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONTEXT_RESOLVER) private readonly resolver: AuthContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({
        code: AUTH_ERROR_CODES.UNAUTHENTICATED,
        message: 'Missing bearer token.',
      });
    }

    const auth = await this.resolver.resolveAccessToken(token);
    if (!auth) {
      throw new UnauthorizedException({
        code: AUTH_ERROR_CODES.UNAUTHENTICATED,
        message: 'Invalid or expired session.',
      });
    }

    request.auth = auth;
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
