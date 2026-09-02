import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../shared/auth/auth.decorator';
import { MCP_ROUTE_PATH } from './mcp.constants';
import type { McpClientContext } from './mcp.contract';
import { McpClientGuard } from './mcp-client.guard';
import { McpServerAdapter } from './mcp-server.adapter';

/**
 * The MCP endpoint: `POST /api/mcp`, Streamable HTTP.
 *
 * `@Public()` skips `JwtAuthGuard` — an MCP key is not a JWT and must not be
 * handed to `AuthContextResolver`. `@UseGuards(McpClientGuard)` then does the
 * real authentication, the `mcp.enabled` check and the rate limit. The other
 * two global guards no-op here because this route declares no
 * `@AccountType`/`@RequirePermission`. See `mcp-client.guard.ts` for why this
 * split rather than checks in the handler body.
 *
 * `reply.hijack()` hands the socket to the SDK's transport, which writes
 * headers and body to the raw `ServerResponse` itself. Without it Fastify
 * would also try to send a reply for a request it thinks is unanswered, and
 * the global `ResponseInterceptor` would attempt to wrap the handler's
 * `undefined` in `{ success: true, data }` — an envelope that has no business
 * on a JSON-RPC response, which carries its own `result`/`error` shape.
 *
 * NOTE the asymmetry this creates, documented in `docs/mcp-integration.md`:
 * failures BEFORE the handler (disabled, unauthenticated, rate-limited) are
 * refused by the guard and therefore come back in the platform's standard
 * `{ success: false, error: { code, message } }` envelope with a real HTTP
 * status, while everything from the handler onward is MCP's own JSON-RPC
 * shape. That is the correct split: transport-level authentication failures
 * are an HTTP concern under the MCP spec, and tool-level failures are a
 * protocol concern.
 */
@Controller(MCP_ROUTE_PATH)
export class McpController {
  constructor(private readonly adapter: McpServerAdapter) {}

  @Post()
  @Public()
  @UseGuards(McpClientGuard)
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): Promise<void> {
    // Set by `McpClientGuard`; unreachable as undefined, since the guard
    // throws rather than returning false on every failure path.
    const client = (request as FastifyRequest & { mcpClient?: McpClientContext }).mcpClient;
    if (!client) {
      throw new Error('McpClientGuard did not attach a client — this should be unreachable.');
    }

    reply.hijack();
    await this.adapter.handleRequest(client, request.raw, reply.raw, body);
  }
}
