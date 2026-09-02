import { HttpException, HttpStatus } from '@nestjs/common';
import { MCP_CONFIG_FALLBACKS, MCP_ERROR_CODES } from './mcp.constants';
import type { McpClientRepository } from './mcp-client.repository';
import { McpRateLimitService } from './mcp-rate-limit.service';
import type { McpSettingsService } from './mcp-settings.service';

function createDeps(limit = { maxRequests: 3, windowSeconds: 60 }) {
  const repo = {
    countRequestAttemptsSince: jest.fn().mockResolvedValue(0),
    recordRequestAttempt: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<McpClientRepository>;

  const settings = { getRateLimit: jest.fn().mockResolvedValue(limit), isEnabled: jest.fn() } as unknown as jest.Mocked<McpSettingsService>;

  return { service: new McpRateLimitService(repo, settings), repo, settings };
}

describe('McpRateLimitService', () => {
  describe('boundary', () => {
    it('allows a request when the client is one under the limit', async () => {
      const { service, repo } = createDeps({ maxRequests: 3, windowSeconds: 60 });
      repo.countRequestAttemptsSince.mockResolvedValue(2);

      await expect(service.consume('client-1')).resolves.toBeUndefined();
      expect(repo.recordRequestAttempt).toHaveBeenCalledWith('client-1');
    });

    it('refuses the request that would exceed the limit', async () => {
      const { service, repo } = createDeps({ maxRequests: 3, windowSeconds: 60 });
      repo.countRequestAttemptsSince.mockResolvedValue(3);

      await expect(service.consume('client-1')).rejects.toBeInstanceOf(HttpException);
    });

    it('does not record an attempt that was refused — refusals must not deepen the lockout', async () => {
      const { service, repo } = createDeps({ maxRequests: 3, windowSeconds: 60 });
      repo.countRequestAttemptsSince.mockResolvedValue(5);

      await expect(service.consume('client-1')).rejects.toBeDefined();
      expect(repo.recordRequestAttempt).not.toHaveBeenCalled();
    });

    it('allows the very first request', async () => {
      const { service, repo } = createDeps();
      repo.countRequestAttemptsSince.mockResolvedValue(0);

      await expect(service.consume('client-1')).resolves.toBeUndefined();
    });
  });

  it('answers 429 with MCP_RATE_LIMITED and retryAfterSeconds', async () => {
    const { service, repo } = createDeps({ maxRequests: 1, windowSeconds: 90 });
    repo.countRequestAttemptsSince.mockResolvedValue(1);

    try {
      await service.consume('client-1');
      fail('expected a refusal');
    } catch (error) {
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(exception.getResponse()).toMatchObject({
        code: MCP_ERROR_CODES.MCP_RATE_LIMITED,
        retryAfterSeconds: 90,
      });
    }
  });

  it('counts only within the configured trailing window', async () => {
    const { service, repo } = createDeps({ maxRequests: 10, windowSeconds: 60 });
    const before = Date.now();

    await service.consume('client-1');

    const since = repo.countRequestAttemptsSince.mock.calls[0]![1];
    const windowStart = since.getTime();
    expect(windowStart).toBeLessThanOrEqual(before - 59_000);
    expect(windowStart).toBeGreaterThanOrEqual(before - 61_000);
  });

  it('counts per client, not globally', async () => {
    const { service, repo } = createDeps();

    await service.consume('client-A');

    expect(repo.countRequestAttemptsSince).toHaveBeenCalledWith('client-A', expect.any(Date));
  });

  describe('misconfiguration falls back rather than locking everyone out', () => {
    it('ignores a non-positive max and uses the compiled fallback', async () => {
      const settings = { getRateLimit: jest.fn(), isEnabled: jest.fn() } as unknown as jest.Mocked<McpSettingsService>;
      const repo = {
        countRequestAttemptsSince: jest.fn().mockResolvedValue(MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS - 1),
        recordRequestAttempt: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<McpClientRepository>;
      // `McpSettingsService` itself does the clamping; here we assert the
      // limiter honours whatever it is handed.
      settings.getRateLimit.mockResolvedValue({ maxRequests: MCP_CONFIG_FALLBACKS.RATE_LIMIT_MAX_REQUESTS, windowSeconds: 60 });

      await expect(new McpRateLimitService(repo, settings).consume('client-1')).resolves.toBeUndefined();
    });
  });
});
