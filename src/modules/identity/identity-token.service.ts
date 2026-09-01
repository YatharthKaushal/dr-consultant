import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getEnv } from '../../config/env/env.validation';
import type { AccountType } from '../../schema/enums.schema';
import type { AccessTokenPayload, RefreshTokenPayload } from '../../shared/auth/auth.types';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access token TTL in seconds, so the client can schedule its own refresh. */
  expiresIn: number;
}

const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `"15m"` / `"12h"` / `"30d"` -> seconds. `env.validation.ts` already regex-validates this shape at boot. */
function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) {
    throw new Error(`Cannot parse TTL "${ttl}" — expected a pattern like "15m", "12h", "30d".`);
  }
  const [, amount, unit] = match;
  return Number(amount) * (TTL_UNIT_SECONDS[unit as keyof typeof TTL_UNIT_SECONDS] ?? 1);
}

/**
 * Mints and verifies the stateless access/refresh JWT pair. Two distinct
 * secrets (not one plus the `typ` claim alone) — see `env.validation.ts` —
 * so a leaked access-verification secret can't mint a refresh token.
 *
 * No session store: revocation is `tokenVersion`-bump-only (an explicit,
 * earlier decision). `verifyAccessToken`/`verifyRefreshToken` only check
 * the token's own signature/claims; the caller (`identity-auth-context.
 * service.ts`) is responsible for re-reading the account row and comparing
 * `tokenVersion` against the current value.
 */
@Injectable()
export class IdentityTokenService {
  constructor(private readonly jwt: JwtService) {}

  async mintTokenPair(accountType: AccountType, accountId: string, tokenVersion: number): Promise<TokenPair> {
    const env = getEnv();
    const refreshTtl = accountType === 'admin' ? env.JWT_ADMIN_REFRESH_TTL : env.JWT_REFRESH_TTL;
    // `jsonwebtoken`'s `expiresIn` types a string TTL with a branded
    // template-literal type ours (a plain, zod-validated `string`) doesn't
    // structurally satisfy — sidestep entirely by passing pre-computed
    // seconds, which `expiresIn` also accepts unconditionally.
    const accessTtlSeconds = parseTtlSeconds(env.JWT_ACCESS_TTL);
    const refreshTtlSeconds = parseTtlSeconds(refreshTtl);

    const accessToken = await this.jwt.signAsync(
      { sub: accountId, act: accountType, tv: tokenVersion, typ: 'access' },
      { secret: env.JWT_ACCESS_SECRET, expiresIn: accessTtlSeconds, issuer: env.JWT_ISSUER },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: accountId, act: accountType, tv: tokenVersion, typ: 'refresh' },
      { secret: env.JWT_REFRESH_SECRET, expiresIn: refreshTtlSeconds, issuer: env.JWT_ISSUER },
    );

    return { accessToken, refreshToken, expiresIn: accessTtlSeconds };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    return this.verify<AccessTokenPayload>(token, getEnv().JWT_ACCESS_SECRET, 'access');
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
    return this.verify<RefreshTokenPayload>(token, getEnv().JWT_REFRESH_SECRET, 'refresh');
  }

  private async verify<T extends { typ: string }>(
    token: string,
    secret: string,
    expectedTyp: T['typ'],
  ): Promise<T | null> {
    try {
      const payload = await this.jwt.verifyAsync<T>(token, { secret, issuer: getEnv().JWT_ISSUER });
      return payload.typ === expectedTyp ? payload : null;
    } catch {
      // Expired, malformed, wrong secret, wrong issuer — all collapse to
      // null here; the guard reports one uniform 401 regardless of which.
      return null;
    }
  }
}
