import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AGENT_TOOLS, TOOL_ERROR_CODES } from './search-tool.constants';
import type { AgentTool } from './search-tool.contract';

/**
 * Holds every `AgentTool` and resolves one by name. Provider-agnostic on
 * purpose: it knows nothing about MCP, LangChain, HTTP or which model is
 * calling — both adapters read from this same registry, which is what makes
 * "the tools are written once" true rather than aspirational.
 *
 * The tool array arrives through the `AGENT_TOOLS` token, built from the
 * single `TOOL_PROVIDERS` list in `search-tool.module.ts`. Adding a tool is
 * therefore one new class plus one entry in that list — nothing here, in
 * either adapter, or in any wiring changes. `search-tool.registry.spec.ts`
 * and `search-tool.module.spec.ts` assert that property directly.
 */
@Injectable()
export class ToolRegistry {
  private readonly byName: ReadonlyMap<string, AgentTool>;

  constructor(@Inject(AGENT_TOOLS) tools: readonly AgentTool[]) {
    const map = new Map<string, AgentTool>();
    for (const tool of tools) {
      if (map.has(tool.name)) {
        // A duplicate name would make `resolve` silently ambiguous and, worse,
        // make an MCP client's scope grant point at whichever registered last.
        throw new Error(`Duplicate agent tool name "${tool.name}" — tool names must be unique.`);
      }
      map.set(tool.name, tool);
    }
    this.byName = map;
  }

  /** Every registered tool, in registration order. */
  list(): AgentTool[] {
    return [...this.byName.values()];
  }

  listNames(): string[] {
    return [...this.byName.keys()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** `null` rather than throwing — callers that must not reveal whether a name exists (scope checks) need the quiet form. */
  find(name: string): AgentTool | null {
    return this.byName.get(name) ?? null;
  }

  /** Throws `TOOL_NOT_FOUND` for an unknown name. */
  resolve(name: string): AgentTool {
    const tool = this.byName.get(name);
    if (!tool) {
      throw new NotFoundException({
        code: TOOL_ERROR_CODES.TOOL_NOT_FOUND,
        message: `No tool named "${name}".`,
      });
    }
    return tool;
  }

  /**
   * Resolve, validate the input against the tool's own zod schema, execute.
   * The single place a tool's schema is enforced for callers that do not get
   * validation for free — the MCP SDK validates against the same schema
   * itself before invoking a handler, so `McpServerAdapter` does not go
   * through here, but the in-process/LangChain path and any direct caller do.
   */
  async execute(name: string, rawInput: unknown): Promise<unknown> {
    const tool = this.resolve(name);
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BadRequestException({
        code: TOOL_ERROR_CODES.TOOL_INPUT_INVALID,
        message: `Invalid input for tool "${name}": ${formatZodIssues(parsed.error)}`,
      });
    }
    return tool.execute(parsed.data);
  }
}

/** Compact, single-line rendering of a zod error — the shape an agent can actually act on. */
function formatZodIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
