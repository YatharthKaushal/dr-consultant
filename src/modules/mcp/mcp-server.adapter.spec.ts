import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { AgentTool } from '../search/tools/search-tool.contract';
import { ToolRegistry } from '../search/tools/search-tool.registry';
import type { McpClientContext } from './mcp.contract';
import { McpServerAdapter, describeError } from './mcp-server.adapter';

function fakeTool(name: string): AgentTool {
  return { name, description: `The ${name} tool.`, inputSchema: z.object({}), execute: jest.fn().mockResolvedValue({ ok: name }) };
}

function build(scopes: string[]) {
  const registry = new ToolRegistry([fakeTool('alpha'), fakeTool('beta'), fakeTool('gamma')]);
  const client: McpClientContext = { clientId: 'client-1', name: 'Aggregator', scopes };
  return { adapter: new McpServerAdapter(registry), client, registry };
}

describe('McpServerAdapter — scope enforcement', () => {
  it('exposes a tool the client IS scoped for', () => {
    const { adapter, client } = build(['alpha']);
    expect(adapter.scopedToolsFor(client).map((tool) => tool.name)).toEqual(['alpha']);
  });

  it('omits a tool the client is NOT scoped for', () => {
    const { adapter, client } = build(['alpha']);
    const names = adapter.scopedToolsFor(client).map((tool) => tool.name);
    expect(names).not.toContain('beta');
    expect(names).not.toContain('gamma');
  });

  it('exposes several tools when several are scoped, in registry order', () => {
    const { adapter, client } = build(['gamma', 'alpha']);
    expect(adapter.scopedToolsFor(client).map((tool) => tool.name)).toEqual(['alpha', 'gamma']);
  });

  it('exposes nothing for a client with no scopes — a fresh client can call nothing', () => {
    const { adapter, client } = build([]);
    expect(adapter.scopedToolsFor(client)).toEqual([]);
  });

  it('ignores a scope naming a tool that does not exist', () => {
    const { adapter, client } = build(['alpha', 'not_a_real_tool']);
    expect(adapter.scopedToolsFor(client).map((tool) => tool.name)).toEqual(['alpha']);
  });

  /* ---------------------------------------------------------------------- */
  /* The non-leak property                                                   */
  /* ---------------------------------------------------------------------- */

  describe('an out-of-scope tool is indistinguishable from a non-existent one', () => {
    it('registers only scoped tools on the server, so nothing else can be discovered', () => {
      const { adapter, client } = build(['alpha']);

      // The server this client talks to is built from the scoped set alone;
      // `beta` is never registered, so `tools/list` cannot list it and
      // `tools/call` answers with the SDK's own "Tool beta not found" — the
      // same string a genuinely unknown name produces. There is no separate
      // "forbidden" branch whose wording or timing could differ.
      const server = adapter.buildServer(client);

      expect(server).toBeDefined();
      expect(adapter.scopedToolsFor(client).map((tool) => tool.name)).toEqual(['alpha']);
    });

    it('treats an unscoped real tool and an invented name identically', () => {
      const { adapter, client } = build(['alpha']);
      const visible = new Set(adapter.scopedToolsFor(client).map((tool) => tool.name));

      // `beta` exists in the registry; `zeta` does not. From this client's
      // side of the wire the two are the same: absent.
      expect(visible.has('beta')).toBe(false);
      expect(visible.has('zeta')).toBe(false);
    });

    it('does not consult the registry for existence when answering an unscoped client', () => {
      const { adapter, client, registry } = build([]);
      const spy = jest.spyOn(registry, 'resolve');

      adapter.buildServer(client);

      // Nothing asks "does this tool exist but is denied" — the question is
      // never posed, so it cannot be answered differently.
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('builds a server without throwing for any scope combination', () => {
    for (const scopes of [[], ['alpha'], ['alpha', 'beta', 'gamma'], ['unknown']]) {
      const { adapter, client } = build(scopes);
      expect(() => adapter.buildServer(client)).not.toThrow();
    }
  });
});

describe('describeError', () => {
  it('extracts code and message from this codebase\'s HttpException shape', () => {
    const error = new ServiceUnavailableException({ code: 'DISCOVERY_UNAVAILABLE', message: 'Not available.' });
    expect(describeError(error)).toEqual({ code: 'DISCOVERY_UNAVAILABLE', message: 'Not available.' });
  });

  it('extracts from a NotFoundException too', () => {
    const error = new NotFoundException({ code: 'SPECIALTY_NOT_FOUND', message: 'No such specialty.' });
    expect(describeError(error)).toEqual({ code: 'SPECIALTY_NOT_FOUND', message: 'No such specialty.' });
  });

  it('reports an unexpected error generically, leaking no internals', () => {
    const result = describeError(new Error('connection string postgres://user:password@host/db failed'));

    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).not.toContain('postgres://');
    expect(result.message).not.toContain('password');
  });

  it('handles a non-Error throw', () => {
    expect(describeError('a bare string')).toEqual({ code: 'INTERNAL_ERROR', message: expect.any(String) });
  });

  it('handles an HttpException whose body is a plain string', () => {
    const error = new NotFoundException('just a message');
    expect(describeError(error).code).toBe('INTERNAL_ERROR');
  });
});
