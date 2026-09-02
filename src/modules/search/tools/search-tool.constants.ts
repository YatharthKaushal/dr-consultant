/**
 * Stable tool names. These are part of the external contract: an MCP client's
 * `scopes` array holds exactly these strings, and renaming one silently
 * revokes every client scoped to the old name. Treat as append-only.
 */
export const TOOL_NAMES = {
  LIST_SERVICE_CATALOGUE: 'list_service_catalogue',
  LIST_CONCERN_TAXONOMY: 'list_concern_taxonomy',
  GET_SERVICE_DETAILS: 'get_service_details',
  LIST_DOCTORS: 'list_doctors',
  DISCOVER_CARE: 'discover_care',
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const TOOL_ERROR_CODES = {
  /** No tool with that name is registered. Also what an out-of-scope tool looks like over MCP — deliberately indistinguishable, see `mcp-server.adapter.ts`. */
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  /** Input failed the tool's own zod schema. */
  TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
  /** The discovery pipeline (`modules/search`, parallel worktree) is not bound yet. */
  DISCOVERY_UNAVAILABLE: 'DISCOVERY_UNAVAILABLE',
  /** A `CatalogueFacade` method the search worktree owns is not present in this build. */
  CATALOGUE_CAPABILITY_UNAVAILABLE: 'CATALOGUE_CAPABILITY_UNAVAILABLE',
  /** `DoctorFacade.listListedDoctors` is not present in this build. */
  DOCTOR_DIRECTORY_UNAVAILABLE: 'DOCTOR_DIRECTORY_UNAVAILABLE',
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
} as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/**
 * DI token for the `DiscoveryPort` implementation — mirrors
 * `availability.constants.ts`'s `BUSY_INTERVAL_PROVIDER` and
 * `shared/auth/auth.constants.ts`'s `AUTH_CONTEXT_RESOLVER`.
 *
 * Bound to `UnavailableDiscoveryProvider` in `search-tool.module.ts` today.
 * POST-MERGE THE COORDINATOR REBINDS THIS ONE LINE to the search pipeline's
 * real implementation; `discover-care.tool.ts` and its tests are unaffected.
 */
export const DISCOVERY_PORT = Symbol('DISCOVERY_PORT');

/** DI token for `CatalogueToolPort`, bound to `CatalogueToolAdapter`. */
export const CATALOGUE_TOOL_PORT = Symbol('CATALOGUE_TOOL_PORT');

/** DI token for `DoctorToolPort`, bound to `DoctorToolAdapter`. */
export const DOCTOR_TOOL_PORT = Symbol('DOCTOR_TOOL_PORT');

/** DI token for the array of every registered `AgentTool` — see `search-tool.module.ts`'s `TOOL_PROVIDERS`. */
export const AGENT_TOOLS = Symbol('AGENT_TOOLS');

/**
 * Hard ceiling on any tool's `limit` argument. An external agent is a machine
 * that will happily ask for 10,000 doctors; the zod schema caps it before the
 * query is ever built.
 */
export const MAX_TOOL_RESULT_LIMIT = 50;
export const DEFAULT_TOOL_RESULT_LIMIT = 10;
