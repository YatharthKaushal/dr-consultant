import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ToolRegistry } from './search-tool.registry';
import type { AgentTool } from './search-tool.contract';

/**
 * Exposes registry tools to our own in-process LangChain agent.
 *
 * IN-PROCESS, NO SERIALIZATION: `execute` is called directly and its result
 * object is handed back as the tool's return value. `DynamicStructuredTool`
 * in `@langchain/core` 1.2.9 accepts a non-string return when
 * `responseFormat: 'content_and_artifact'` is set, but the plain path
 * stringifies; we keep the structured object reachable by returning it
 * through the artifact channel, so an in-process caller never pays a
 * JSON round trip the way the MCP path does.
 *
 * Schema is taken straight off the tool — `schema: tool.inputSchema`, the
 * same zod object `McpServerAdapter` hands to the MCP SDK. Neither adapter
 * writes a schema of its own, so there is nothing to keep in sync;
 * `search-tool.adapter-parity.spec.ts` asserts both adapters land on the same
 * name/description/schema for every registered tool.
 */
@Injectable()
export class LangChainToolAdapter {
  constructor(private readonly registry: ToolRegistry) {}

  /** Every registered tool, as LangChain tools. */
  toLangChainTools(): DynamicStructuredTool[] {
    return this.registry.list().map((tool) => this.toLangChainTool(tool));
  }

  /** One registry tool as a LangChain `DynamicStructuredTool`. */
  toLangChainTool(tool: AgentTool): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      // The tool's own zod schema. LangChain validates the model's arguments
      // against it and hands `func` the parsed value, so the adapter never
      // re-validates or re-declares anything.
      schema: tool.inputSchema,
      responseFormat: 'content_and_artifact',
      func: async (input: unknown) => {
        const output = await tool.execute(input);
        // [text for the model, structured artifact for our own code].
        return [JSON.stringify(output), output];
      },
    });
  }
}
