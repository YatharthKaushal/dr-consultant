import type { ZodSchema } from 'zod';
import type { PublicConcern, PublicSpecialty } from '../../catalogue/catalogue.contract';
import type { ListedDoctorSummary } from '../../doctor/doctor.contract';

/* -------------------------------------------------------------------------- */
/* The tool interface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One capability an AI agent can invoke, written ONCE and exposed through two
 * transports: `LangChainToolAdapter` (in-process, for our own agent — no
 * serialization) and `McpServerAdapter` (over MCP, for external clients).
 *
 * `inputSchema` is the single source of truth for the tool's arguments.
 * Neither adapter hand-writes a schema: the LangChain adapter hands the zod
 * schema straight to `DynamicStructuredTool`, and the MCP SDK converts the
 * same object to JSON Schema itself (verified against
 * `@modelcontextprotocol/sdk` 1.30.0 — `registerTool` accepts a full
 * `z.object(...)` and emits draft-07). So there is nothing to keep in sync by
 * hand, which is the property `search-tool.adapter-parity.spec.ts` asserts.
 *
 * `description` is not documentation for us — it is the text an LLM reads to
 * decide whether to call this tool at all. Each one states what the tool
 * returns, what it deliberately does NOT return, and when to reach for a
 * different tool instead.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodSchema<TInput>;
  execute(input: TInput): Promise<TOutput>;
}

/* -------------------------------------------------------------------------- */
/* Discovery port — implemented by the search pipeline (parallel worktree)      */
/* -------------------------------------------------------------------------- */

/**
 * What an integrator must show a patient when discovery detects a crisis.
 * `message` is written by us and is meant to be rendered VERBATIM — see
 * `docs/mcp-integration.md`'s crisis-response contract.
 */
export interface CrisisGuidance {
  /** The emergency message. Render as-is; do not summarise or paraphrase. */
  message: string;
  helplines: ReadonlyArray<{ name: string; phone: string; availability?: string }>;
}

/**
 * The discovery pipeline's verdict. A DISCRIMINATED UNION on purpose: the
 * `crisis` branch has no concern/specialty fields at all, so no code path can
 * accidentally carry routing data out of a crisis result (SRS FR-5.6 / §6.3).
 */
export type DiscoveryResult =
  | { outcome: 'crisis'; guidance: CrisisGuidance }
  | {
      outcome: 'routed';
      /** `concerns.id` values the pipeline matched. Ids only — this module resolves them to names through `CatalogueFacade`. */
      interpretedConcernIds: string[];
      /** `specialties.id` values, in the pipeline's own recommended order. */
      recommendedSpecialtyIds: string[];
      /** Plain-language "matched to: sleep, anxiety" reason (FR-5.4), if the pipeline produced one. */
      matchReason?: string;
    };

/**
 * The tools module's only dependency on the AI symptom-discovery pipeline,
 * which lives in `modules/search` proper and is owned by a different
 * worktree. Bound to the `DISCOVERY_PORT` DI token
 * (`search-tool.constants.ts`) — the same pattern
 * `availability.contract.ts`'s `BusyIntervalProvider`/`BUSY_INTERVAL_PROVIDER`
 * and `shared/auth`'s `AUTH_CONTEXT_RESOLVER` already use for exactly this
 * situation.
 *
 * Currently bound to `UnavailableDiscoveryProvider`, which throws
 * `DISCOVERY_UNAVAILABLE`. Post-merge the coordinator rebinds the token to
 * the search pipeline's own implementation in `search-tool.module.ts`;
 * nothing in `discover-care.tool.ts` or its tests changes.
 */
export interface DiscoveryPort {
  discover(input: { text: string; source: 'mcp'; locale?: string }): Promise<DiscoveryResult>;
}

/* -------------------------------------------------------------------------- */
/* Facade ports — methods the parallel search worktree is adding               */
/* -------------------------------------------------------------------------- */

/** Filter for `DoctorToolPort#listListedDoctors`. Deterministic: every field is an exact/threshold match, never a relevance score. */
export interface ListListedDoctorsFilter {
  specialtyId?: string;
  /** Exact match against one of `doctors.languages`. */
  language?: string;
  /** Inclusive upper bound on `doctors.consultation_fee_inr`. */
  maxFeeInr?: number;
  limit?: number;
}

/*
 * NOTE ON THIS FILTER'S SHAPE (M-09 merge).
 *
 * `DoctorFacade.listListedDoctors` takes the PLURAL `ListedDoctorFilter`
 * (`specialtyIds[]`/`languages[]`, a decimal-string `maxFeeInr`, and required
 * `limit`/`offset`). This singular shape is kept deliberately as the
 * AGENT-FACING one: a model filling a tool call reasons about "a psychiatrist
 * who speaks Hindi", not about arrays and page offsets, and every field here
 * maps onto the richer one without loss. `doctor-tool.adapter.ts` does that
 * translation in one place — which is exactly what the port is for.
 */

/**
 * The slice of `CatalogueFacade` these tools need.
 *
 * `listActiveSpecialties` exists today. `listActiveConcerns` and
 * `getConcernsByIds` are being added to `CatalogueFacade` by the parallel
 * search worktree (M-09) and are ABSENT from this worktree's checkout — see
 * `catalogue-tool.adapter.ts` for how that absence is handled without
 * duplicating their implementation.
 */
export interface CatalogueToolPort {
  listActiveSpecialties(): Promise<PublicSpecialty[]>;
  /** Every active concern across every specialty. Called with NO arguments — see `catalogue-tool.adapter.ts`. */
  listActiveConcerns(): Promise<PublicConcern[]>;
  getConcernsByIds(ids: string[]): Promise<PublicConcern[]>;
}

/**
 * The slice of `DoctorFacade` these tools need. `listListedDoctors` is being
 * added by the parallel search worktree; `DoctorFacade` has no multi-doctor
 * read at all in this worktree's checkout.
 */
export interface DoctorToolPort {
  listListedDoctors(filter: ListListedDoctorsFilter): Promise<ListedDoctorSummary[]>;
}
