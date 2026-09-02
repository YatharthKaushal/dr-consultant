import { DiscoverCareTool } from './discover-care.tool';
import { GetServiceDetailsTool } from './get-service-details.tool';
import { ListConcernTaxonomyTool } from './list-concern-taxonomy.tool';
import { ListDoctorsTool } from './list-doctors.tool';
import { ListServiceCatalogueTool } from './list-service-catalogue.tool';
import { REGISTERED_TOOL_PROVIDERS } from './search-tool.module';
import { TOOL_NAMES } from './search-tool.constants';
import type { AgentTool } from './search-tool.contract';
import { ToolRegistry } from './search-tool.registry';
import { mockCataloguePort, mockDoctorPort } from './search-tool.test-fixtures';

/**
 * Guards the design goal: adding a tool is ONE new class plus ONE entry in
 * `TOOL_PROVIDERS`, and nothing else. If a future tool were registered in a
 * second place, or the registry had to be told about it separately, the
 * assertions here would need editing too — which is the alarm.
 */

/** Constructed directly with mocked ports, the codebase's `new Service(mockedDeps)` convention. */
function buildAllTools(): AgentTool[] {
  const catalogue = mockCataloguePort();
  const doctors = mockDoctorPort();
  const doctorAdapter = { isAvailable: () => true, listListedDoctors: doctors.listListedDoctors } as never;
  const discovery = { discover: jest.fn() };

  return [
    new ListServiceCatalogueTool(catalogue),
    new ListConcernTaxonomyTool(catalogue),
    new GetServiceDetailsTool(catalogue, doctorAdapter),
    new ListDoctorsTool(doctors),
    new DiscoverCareTool(discovery, catalogue, doctors),
  ];
}

describe('SearchToolModule wiring', () => {
  it('registers exactly the five tools the tool layer defines', () => {
    expect(REGISTERED_TOOL_PROVIDERS).toHaveLength(5);
  });

  it('lists the tool classes in TOOL_PROVIDERS, the single registration point', () => {
    expect([...REGISTERED_TOOL_PROVIDERS]).toEqual([
      ListServiceCatalogueTool,
      ListConcernTaxonomyTool,
      GetServiceDetailsTool,
      ListDoctorsTool,
      DiscoverCareTool,
    ]);
  });

  it('produces a registry whose names are exactly TOOL_NAMES', () => {
    const registry = new ToolRegistry(buildAllTools());

    expect(registry.listNames().sort()).toEqual(Object.values(TOOL_NAMES).sort());
  });

  it('has one registered tool per TOOL_NAMES entry — no orphan name, no unnamed tool', () => {
    expect(REGISTERED_TOOL_PROVIDERS).toHaveLength(Object.keys(TOOL_NAMES).length);
  });

  it('gives every tool a non-trivial description, since that text is what an LLM routes on', () => {
    for (const tool of buildAllTools()) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.description.trim()).toBe(tool.description);
    }
  });

  it('gives every tool a usable zod schema', () => {
    for (const tool of buildAllTools()) {
      expect(typeof tool.inputSchema.safeParse).toBe('function');
      // Every tool's schema must reject a non-object outright.
      expect(tool.inputSchema.safeParse('not an object').success).toBe(false);
    }
  });

  it('gives every tool a stable snake_case name', () => {
    for (const tool of buildAllTools()) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('constructs a registry from the tool set without a name clash', () => {
    expect(() => new ToolRegistry(buildAllTools())).not.toThrow();
  });
});
