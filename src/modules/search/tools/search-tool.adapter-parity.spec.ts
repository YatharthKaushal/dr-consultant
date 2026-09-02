import { z } from 'zod';
import { McpServerAdapter } from '../../mcp/mcp-server.adapter';
import { LangChainToolAdapter } from './langchain-tool.adapter';
import type { AgentTool } from './search-tool.contract';
import { ToolRegistry } from './search-tool.registry';

/**
 * The property that makes "write the tools once" real rather than a claim:
 * BOTH adapters must derive name, description and argument schema from the
 * same `AgentTool` definition, with nothing hand-maintained on either side.
 *
 * These tests compare what a LangChain agent would see against what an MCP
 * client would see, for the same registry — so a future edit that hand-writes
 * a schema in one adapter, or renames a tool in only one place, fails here.
 */

function fakeTool(name: string, description: string, schema: z.ZodType): AgentTool {
  return { name, description, inputSchema: schema, execute: jest.fn().mockResolvedValue({ ok: true }) };
}

const TOOLS = [
  fakeTool('alpha', 'The alpha tool.', z.object({ a: z.string(), n: z.number().optional() })),
  fakeTool('beta', 'The beta tool.', z.object({ flag: z.boolean() })),
];

const ALL_SCOPES = { clientId: 'client-1', name: 'Test client', scopes: ['alpha', 'beta'] };

function build() {
  const registry = new ToolRegistry(TOOLS);
  return { registry, langchain: new LangChainToolAdapter(registry), mcp: new McpServerAdapter(registry) };
}

describe('adapter parity — one tool definition, two transports', () => {
  it('exposes the same tool names through both adapters', () => {
    const { langchain, mcp } = build();

    const langchainNames = langchain.toLangChainTools().map((tool) => tool.name);
    const mcpNames = mcp.scopedToolsFor(ALL_SCOPES).map((tool) => tool.name);

    expect(langchainNames).toEqual(['alpha', 'beta']);
    expect(mcpNames).toEqual(langchainNames);
  });

  it('exposes the same descriptions through both adapters', () => {
    const { langchain, mcp } = build();

    const langchainDescriptions = langchain.toLangChainTools().map((tool) => tool.description);
    const mcpDescriptions = mcp.scopedToolsFor(ALL_SCOPES).map((tool) => tool.description);

    expect(langchainDescriptions).toEqual(mcpDescriptions);
  });

  it('hands both adapters the very same zod schema object — not a copy', () => {
    const { registry, langchain, mcp } = build();

    const langchainSchemas = langchain.toLangChainTools().map((tool) => tool.schema);
    const mcpSchemas = mcp.scopedToolsFor(ALL_SCOPES).map((tool) => tool.inputSchema);
    const registrySchemas = registry.list().map((tool) => tool.inputSchema);

    // Reference equality: there is no per-adapter schema to drift.
    expect(langchainSchemas).toEqual(registrySchemas);
    expect(mcpSchemas).toEqual(registrySchemas);
    langchainSchemas.forEach((schema, index) => {
      expect(schema).toBe(registrySchemas[index]);
      expect(mcpSchemas[index]).toBe(registrySchemas[index]);
    });
  });

  it('accepts and rejects identical inputs on both sides, because the schema is identical', () => {
    const { langchain, mcp } = build();

    const langchainAlpha = langchain.toLangChainTools()[0]!;
    const mcpAlpha = mcp.scopedToolsFor(ALL_SCOPES)[0]!;

    const valid = { a: 'hello', n: 1 };
    const invalid = { a: 42 };

    expect((langchainAlpha.schema as z.ZodType).safeParse(valid).success).toBe(true);
    expect(mcpAlpha.inputSchema.safeParse(valid).success).toBe(true);
    expect((langchainAlpha.schema as z.ZodType).safeParse(invalid).success).toBe(false);
    expect(mcpAlpha.inputSchema.safeParse(invalid).success).toBe(false);
  });

  it('adds a new tool to both transports from a single registration', () => {
    const registry = new ToolRegistry([...TOOLS, fakeTool('gamma', 'The gamma tool.', z.object({}))]);

    expect(new LangChainToolAdapter(registry).toLangChainTools().map((tool) => tool.name)).toContain('gamma');
    expect(new McpServerAdapter(registry).scopedToolsFor({ ...ALL_SCOPES, scopes: ['alpha', 'beta', 'gamma'] }).map((tool) => tool.name)).toContain('gamma');
  });
});

describe('LangChainToolAdapter', () => {
  it('runs the underlying tool and returns [text, artifact]', async () => {
    const { langchain } = build();
    const alpha = langchain.toLangChainTools()[0]!;

    // `DynamicStructuredTool.invoke` returns the content half; the artifact
    // half is the structured object, which is what an in-process caller
    // wants and is exactly what avoids a JSON round trip.
    const output = await alpha.invoke({ a: 'hello' });

    expect(output).toBe(JSON.stringify({ ok: true }));
  });

  it('rejects input that fails the tool schema', async () => {
    const { langchain } = build();
    const alpha = langchain.toLangChainTools()[0]!;

    await expect(alpha.invoke({ a: 42 } as never)).rejects.toThrow();
  });

  it('wraps a single tool on request', () => {
    const { langchain, registry } = build();
    const wrapped = langchain.toLangChainTool(registry.resolve('beta'));
    expect(wrapped.name).toBe('beta');
  });
});
