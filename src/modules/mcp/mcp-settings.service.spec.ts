import type { AppConfigService } from '../../shared/app-config/app-config.service';
import { MCP_CONFIG_FALLBACKS, MCP_CONFIG_KEYS } from './mcp.constants';
import { McpSettingsService } from './mcp-settings.service';

function createDeps() {
  const appConfig = {
    getNumber: jest.fn(),
    getJson: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as jest.Mocked<AppConfigService>;
  return { service: new McpSettingsService(appConfig), appConfig };
}

describe('McpSettingsService', () => {
  describe('isEnabled — fails closed', () => {
    it('is false by default, when no app_config row exists', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getJson.mockImplementation(async (_key: string, fallback: unknown) => fallback);

      await expect(service.isEnabled()).resolves.toBe(false);
    });

    it('reads the mcp.enabled key', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getJson.mockResolvedValue(true);

      await service.isEnabled();

      expect(appConfig.getJson).toHaveBeenCalledWith(MCP_CONFIG_KEYS.ENABLED, MCP_CONFIG_FALLBACKS.ENABLED);
    });

    it('is true only for the literal boolean true', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getJson.mockResolvedValue(true);

      await expect(service.isEnabled()).resolves.toBe(true);
    });

    it.each([
      ['the string "true"', 'true'],
      ['the string "false"', 'false'],
      ['the number 1', 1],
      ['an object', { enabled: true }],
      ['null', null],
      ['undefined', undefined],
    ])('treats %s as OFF — a config typo must not open an external surface', async (_label, value) => {
      const { service, appConfig } = createDeps();
      appConfig.getJson.mockResolvedValue(value);

      await expect(service.isEnabled()).resolves.toBe(false);
    });
  });

  describe('getRateLimit', () => {
    it('returns the configured values', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getNumber.mockImplementation(async (key: string) => (key === MCP_CONFIG_KEYS.RATE_LIMIT_MAX_REQUESTS ? 30 : 15));

      await expect(service.getRateLimit()).resolves.toEqual({ maxRequests: 30, windowSeconds: 15 });
    });

    it('falls back to the compiled defaults when no rows exist', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getNumber.mockImplementation(async (_key: string, fallback: number) => fallback);

      await expect(service.getRateLimit()).resolves.toEqual({
        maxRequests: MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS,
        windowSeconds: MCP_CONFIG_FALLBACKS.RATE_LIMIT_WINDOW_SECONDS,
      });
    });

    it('clamps a non-positive max back to the fallback rather than locking every client out', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getNumber.mockImplementation(async (key: string) => (key === MCP_CONFIG_KEYS.RATE_LIMIT_MAX_REQUESTS ? 0 : 60));

      const limit = await service.getRateLimit();

      expect(limit.maxRequests).toBe(MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS);
    });

    it('clamps a zero-length window', async () => {
      const { service, appConfig } = createDeps();
      appConfig.getNumber.mockImplementation(async (key: string) => (key === MCP_CONFIG_KEYS.RATE_LIMIT_WINDOW_SECONDS ? 0 : 100));

      const limit = await service.getRateLimit();

      expect(limit.windowSeconds).toBe(MCP_CONFIG_FALLBACKS.RATE_LIMIT_WINDOW_SECONDS);
    });
  });
});
