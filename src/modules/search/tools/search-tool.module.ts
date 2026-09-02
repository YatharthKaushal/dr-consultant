import { Module } from '@nestjs/common';
import { CatalogueModule } from '../../catalogue/catalogue.module';
import { DoctorModule } from '../../doctor/doctor.module';
import { CatalogueToolAdapter } from './catalogue-tool.adapter';
import { DiscoverCareTool } from './discover-care.tool';
import { DoctorToolAdapter } from './doctor-tool.adapter';
import { GetServiceDetailsTool } from './get-service-details.tool';
import { LangChainToolAdapter } from './langchain-tool.adapter';
import { ListConcernTaxonomyTool } from './list-concern-taxonomy.tool';
import { ListDoctorsTool } from './list-doctors.tool';
import { ListServiceCatalogueTool } from './list-service-catalogue.tool';
import { AGENT_TOOLS, CATALOGUE_TOOL_PORT, DISCOVERY_PORT, DOCTOR_TOOL_PORT } from './search-tool.constants';
import { ToolRegistry } from './search-tool.registry';
import { UnavailableDiscoveryProvider } from './unavailable-discovery.provider';

/**
 * THE ONE REGISTRATION LINE.
 *
 * Adding a tool is: write the class, add it here. This array is the only
 * place a tool is named — it feeds both the `providers` list (so Nest
 * constructs it) and the `AGENT_TOOLS` factory's `inject` list (so the
 * registry receives it), which is why adding a tool never means editing two
 * lists that can drift apart. Nothing in `ToolRegistry`,
 * `LangChainToolAdapter` or `McpServerAdapter` enumerates tools.
 *
 * Order here is the order `tools/list` reports over MCP.
 */
const TOOL_PROVIDERS = [
  ListServiceCatalogueTool,
  ListConcernTaxonomyTool,
  GetServiceDetailsTool,
  ListDoctorsTool,
  DiscoverCareTool,
] as const;

/**
 * The provider-agnostic tool layer. Owns no tables and exposes no HTTP
 * routes: it is a library of capabilities that transports (in-process
 * LangChain, and `modules/mcp` over MCP) consume.
 *
 * Lives under `modules/search/tools/` because these tools are the agent-
 * facing surface of symptom discovery and the catalogue reads that support
 * it. Everything OUTSIDE `tools/` in `modules/search` belongs to the M-09
 * worktree and is untouched by this one.
 *
 * `CatalogueModule`/`DoctorModule` are real (non-global) imports —
 * `CatalogueToolAdapter`/`DoctorToolAdapter` resolve their facades from them,
 * exactly as `AvailabilityModule` imports `DoctorModule` for `DoctorFacade`.
 * Modules are read ONLY through those facades (`backend/README.md` §2); no
 * tool here touches `specialties`, `concerns` or `doctors` directly.
 *
 * DISCOVERY_PORT is bound to the placeholder `UnavailableDiscoveryProvider`.
 * POST-MERGE: rebind that single provider entry to the M-09 pipeline's own
 * `DiscoveryPort` implementation. That is the whole integration step.
 */
@Module({
  imports: [CatalogueModule, DoctorModule],
  providers: [
    ...TOOL_PROVIDERS,
    {
      provide: AGENT_TOOLS,
      useFactory: (...tools: unknown[]) => tools,
      inject: [...TOOL_PROVIDERS],
    },
    CatalogueToolAdapter,
    DoctorToolAdapter,
    { provide: CATALOGUE_TOOL_PORT, useExisting: CatalogueToolAdapter },
    { provide: DOCTOR_TOOL_PORT, useExisting: DoctorToolAdapter },
    { provide: DISCOVERY_PORT, useClass: UnavailableDiscoveryProvider },
    ToolRegistry,
    LangChainToolAdapter,
  ],
  exports: [ToolRegistry, LangChainToolAdapter],
})
export class SearchToolModule {}

/** Exported for `search-tool.module.spec.ts`, which asserts the registry and this list stay in step. */
export const REGISTERED_TOOL_PROVIDERS = TOOL_PROVIDERS;
