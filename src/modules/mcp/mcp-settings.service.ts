import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { MCP_CONFIG_FALLBACKS, MCP_CONFIG_KEYS } from './mcp.constants';

export interface McpRateLimit {
  maxRequests: number;
  windowSeconds: number;
}

/**
 * This module's `app_config` reads, in one place — same three-level shape as
 * `availability-settings.service.ts`'s: stored value, else compiled-in
 * fallback (`MCP_CONFIG_FALLBACKS`).
 */
@Injectable()
export class McpSettingsService {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Whether the MCP surface is served at all. Defaults to FALSE — see
   * `MCP_CONFIG_FALLBACKS` for why.
   *
   * Strictly boolean-typed: `AppConfigService.getJson` returns whatever JSON
   * the row holds, and a row containing the STRING `"false"` is truthy in
   * JavaScript. Coercing anything that is not the literal `true` to "off"
   * means a typo in an admin config edit fails closed, which for a switch
   * that exposes an external surface is the only acceptable direction to
   * fail.
   */
  async isEnabled(): Promise<boolean> {
    const value = await this.appConfig.getJson<unknown>(MCP_CONFIG_KEYS.ENABLED, MCP_CONFIG_FALLBACKS.ENABLED);
    return value === true;
  }

  async getRateLimit(): Promise<McpRateLimit> {
    const [maxRequests, windowSeconds] = await Promise.all([
      this.appConfig.getNumber(MCP_CONFIG_KEYS.RATE_LIMIT_MAX_REQUESTS, MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS),
      this.appConfig.getNumber(MCP_CONFIG_KEYS.RATE_LIMIT_WINDOW_SECONDS, MCP_CONFIG_FALLBACKS.RATE_LIMIT_WINDOW_SECONDS),
    ]);

    // A misconfigured non-positive limit would otherwise either lock every
    // client out permanently (max <= 0) or divide by a zero-length window.
    return {
      maxRequests: maxRequests > 0 ? maxRequests : MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: windowSeconds > 0 ? windowSeconds : MCP_CONFIG_FALLBACKS.RATE_LIMIT_WINDOW_SECONDS,
    };
  }
}
