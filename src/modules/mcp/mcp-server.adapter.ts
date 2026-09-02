import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AgentTool } from '../search/tools/search-tool.contract';
import { ToolRegistry } from '../search/tools/search-tool.registry';
import { MCP_SERVER_INFO } from './mcp.constants';
import type { McpClientContext } from './mcp.contract';

/**
 * Exposes registry tools over MCP.
 *
 * TRANSPORT: Streamable HTTP (`@modelcontextprotocol/sdk` 1.30.0), stateless,
 * with `enableJsonResponse`. Stateless because the consumer is a
 * request/response automation aggregator with no need for server-initiated
 * notifications or resumable streams; it means no session table, no session
 * expiry, and no server-side state to lose on a deploy or to pin a client to
 * one instance behind a load balancer. `enableJsonResponse` makes a POST
 * answer with a plain JSON body instead of an SSE stream, which is what an
 * ordinary HTTP client in an aggregator can consume without special handling.
 *
 * SCHEMAS COME FROM THE TOOL, NOT FROM HERE. `registerTool` is handed
 * `tool.inputSchema` — the same zod object `LangChainToolAdapter` passes to
 * `DynamicStructuredTool` — and the SDK derives JSON Schema from it and
 * validates arguments against it before invoking the handler. This adapter
 * declares no schema of its own, so there is nothing to keep in sync.
 *
 * A FRESH SERVER PER REQUEST, and that is load-bearing for scope enforcement:
 * only the tools this client is scoped for are ever registered. See
 * `buildServer`.
 */
@Injectable()
export class McpServerAdapter {
  private readonly logger = new Logger(McpServerAdapter.name);

  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Handles one MCP HTTP request against Node's raw request/response objects.
   * Fastify exposes these as `request.raw`/`reply.raw`; the caller is
   * responsible for `reply.hijack()` so Fastify does not also try to send.
   */
  async handleRequest(client: McpClientContext, req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
    const server = this.buildServer(client);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id is issued and none is required.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Per-request server and transport: release both once the response is
      // done, or a busy endpoint accumulates one of each per call.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  /**
   * Builds the MCP server this client sees.
   *
   * SCOPE ENFORCEMENT IS STRUCTURAL: a tool the client is not scoped for is
   * simply never registered. That is what makes the denial non-revealing —
   * `tools/list` omits it, and `tools/call` produces the SDK's own
   * `-32602 Tool <name> not found`, character-for-character identical to what
   * a genuinely non-existent tool name produces. There is no separate
   * "forbidden" path whose existence, wording or timing could tell an
   * unscoped client that the tool is real and merely off-limits.
   *
   * Verified against the SDK's actual behaviour: both cases return
   * `{ isError: true, content: [{ type: 'text', text: 'MCP error -32602:
   * Tool <name> not found' }] }`.
   */
  buildServer(client: McpClientContext): McpServer {
    const server = new McpServer(MCP_SERVER_INFO);
    const scopes = new Set(client.scopes);

    for (const tool of this.registry.list()) {
      if (!scopes.has(tool.name)) {
        continue;
      }
      this.registerTool(server, tool, client);
    }

    return server;
  }

  /** The tools this client would see — used by `mcp-server.adapter.spec.ts` and by the parity test. */
  scopedToolsFor(client: McpClientContext): AgentTool[] {
    const scopes = new Set(client.scopes);
    return this.registry.list().filter((tool) => scopes.has(tool.name));
  }

  private registerTool(server: McpServer, tool: AgentTool, client: McpClientContext): void {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The tool's own zod schema — the SDK converts it to JSON Schema for
        // `tools/list` and validates `tools/call` arguments against it.
        inputSchema: tool.inputSchema,
      },
      async (input: unknown) => {
        try {
          const output = await tool.execute(input as never);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(output) }],
            structuredContent: output as Record<string, unknown>,
          };
        } catch (error) {
          // A tool failure is a TOOL-level error (`isError: true`), not a
          // JSON-RPC protocol error: the call itself was well-formed and the
          // agent needs to read the reason and decide what to do, which the
          // MCP spec models as an error result rather than a transport fault.
          const { code, message } = describeError(error);
          this.logger.warn(`MCP tool "${tool.name}" failed for client "${client.name}": ${code} — ${message}`);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
            isError: true,
          };
        }
      },
    );
  }
}

/**
 * Extracts this codebase's `{ code, message }` from a thrown Nest
 * `HttpException`, whose `getResponse()` already carries that shape at every
 * throw site. Anything else is reported generically — an unexpected error's
 * message and stack stay server-side, exactly as
 * `HttpExceptionFilter`'s branch 4 does for HTTP responses.
 */
export function describeError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'getResponse' in error && typeof (error as { getResponse: unknown }).getResponse === 'function') {
    const body: unknown = (error as { getResponse: () => unknown }).getResponse();
    if (typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' && typeof (body as { message?: unknown }).message === 'string') {
      return { code: (body as { code: string }).code, message: (body as { message: string }).message };
    }
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred while running this tool.' };
}
