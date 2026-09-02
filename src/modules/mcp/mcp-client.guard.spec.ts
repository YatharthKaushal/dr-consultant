import { HttpException, ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { MCP_ERROR_CODES } from './mcp.constants';
import type { McpClientContext } from './mcp.contract';
import { McpClientGuard, type RequestWithMcpClient } from './mcp-client.guard';
import type { McpClientService } from './mcp-client.service';
import type { McpRateLimitService } from './mcp-rate-limit.service';
import type { McpSettingsService } from './mcp-settings.service';

const CLIENT: McpClientContext = { clientId: 'client-1', name: 'Aggregator', scopes: ['list_service_catalogue'] };

function contextFor(request: RequestWithMcpClient): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function createDeps({ enabled = true } = {}) {
  const clients = { authenticate: jest.fn().mockResolvedValue(CLIENT) } as unknown as jest.Mocked<McpClientService>;
  const rateLimit = { consume: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<McpRateLimitService>;
  const settings = { isEnabled: jest.fn().mockResolvedValue(enabled), getRateLimit: jest.fn() } as unknown as jest.Mocked<McpSettingsService>;
  return { guard: new McpClientGuard(clients, rateLimit, settings), clients, rateLimit, settings };
}

function bodyOf(error: unknown): { code: string } {
  return (error as HttpException).getResponse() as { code: string };
}

describe('McpClientGuard', () => {
  describe('the mcp.enabled kill switch', () => {
    it('refuses every request when the surface is disabled', async () => {
      const { guard } = createDeps({ enabled: false });

      await expect(guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_valid' } }))).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('reports MCP_DISABLED', async () => {
      const { guard } = createDeps({ enabled: false });

      try {
        await guard.canActivate(contextFor({ headers: {} }));
        fail('expected a refusal');
      } catch (error) {
        expect(bodyOf(error).code).toBe(MCP_ERROR_CODES.MCP_DISABLED);
      }
    });

    it('does not touch the database when disabled', async () => {
      const { guard, clients, rateLimit } = createDeps({ enabled: false });

      await expect(guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_valid' } }))).rejects.toBeDefined();

      expect(clients.authenticate).not.toHaveBeenCalled();
      expect(rateLimit.consume).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('accepts a valid key and attaches the client to the request', async () => {
      const { guard } = createDeps();
      const request: RequestWithMcpClient = { headers: { authorization: 'Bearer mcp_valid' } };

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.mcpClient).toEqual(CLIENT);
    });

    it('passes the key through without the Bearer prefix', async () => {
      const { guard, clients } = createDeps();

      await guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_theKeyItself' } }));

      expect(clients.authenticate).toHaveBeenCalledWith('mcp_theKeyItself');
    });

    it.each([
      ['no Authorization header', undefined],
      ['an empty header', ''],
      ['a non-Bearer scheme', 'Basic abc123'],
      ['Bearer with nothing after it', 'Bearer '],
      ['a lowercase bearer scheme', 'bearer mcp_valid'],
    ])('refuses %s', async (_label, authorization) => {
      const { guard } = createDeps();
      const headers = authorization === undefined ? {} : { authorization };

      await expect(guard.canActivate(contextFor({ headers }))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses an invalid key', async () => {
      const { guard, clients } = createDeps();
      clients.authenticate.mockResolvedValue(null);

      await expect(guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_wrong' } }))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('reports one MCP_UNAUTHENTICATED code for a missing header and for a bad key alike', async () => {
      const { guard, clients } = createDeps();

      const codes: string[] = [];
      for (const headers of [{}, { authorization: 'Bearer mcp_wrong' }]) {
        clients.authenticate.mockResolvedValue(null);
        try {
          await guard.canActivate(contextFor({ headers }));
          fail('expected a refusal');
        } catch (error) {
          codes.push(bodyOf(error).code);
        }
      }

      expect(codes).toEqual([MCP_ERROR_CODES.MCP_UNAUTHENTICATED, MCP_ERROR_CODES.MCP_UNAUTHENTICATED]);
    });

    it('never attaches a client when authentication fails', async () => {
      const { guard, clients } = createDeps();
      clients.authenticate.mockResolvedValue(null);
      const request: RequestWithMcpClient = { headers: { authorization: 'Bearer mcp_wrong' } };

      await expect(guard.canActivate(contextFor(request))).rejects.toBeDefined();

      expect(request.mcpClient).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('consumes budget for the authenticated client', async () => {
      const { guard, rateLimit } = createDeps();

      await guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_valid' } }));

      expect(rateLimit.consume).toHaveBeenCalledWith('client-1');
    });

    it('does NOT consume budget for an unauthenticated caller — the counter table cannot be grown anonymously', async () => {
      const { guard, clients, rateLimit } = createDeps();
      clients.authenticate.mockResolvedValue(null);

      await expect(guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_wrong' } }))).rejects.toBeDefined();

      expect(rateLimit.consume).not.toHaveBeenCalled();
    });

    it('propagates the limiter refusal', async () => {
      const { guard, rateLimit } = createDeps();
      rateLimit.consume.mockRejectedValue(new HttpException({ code: MCP_ERROR_CODES.MCP_RATE_LIMITED, message: 'too many' }, 429));

      await expect(guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_valid' } }))).rejects.toBeInstanceOf(HttpException);
    });

    it('does not attach a client when the request is rate-limited', async () => {
      const { guard, rateLimit } = createDeps();
      rateLimit.consume.mockRejectedValue(new HttpException({ code: MCP_ERROR_CODES.MCP_RATE_LIMITED, message: 'too many' }, 429));
      const request: RequestWithMcpClient = { headers: { authorization: 'Bearer mcp_valid' } };

      await expect(guard.canActivate(contextFor(request))).rejects.toBeDefined();

      expect(request.mcpClient).toBeUndefined();
    });
  });

  it('gates in order: enabled, then authenticate, then rate limit', async () => {
    const order: string[] = [];
    const { guard, clients, rateLimit, settings } = createDeps();
    settings.isEnabled.mockImplementation(async () => {
      order.push('enabled');
      return true;
    });
    clients.authenticate.mockImplementation(async () => {
      order.push('authenticate');
      return CLIENT;
    });
    rateLimit.consume.mockImplementation(async () => {
      order.push('rateLimit');
    });

    await guard.canActivate(contextFor({ headers: { authorization: 'Bearer mcp_valid' } }));

    expect(order).toEqual(['enabled', 'authenticate', 'rateLimit']);
  });
});
