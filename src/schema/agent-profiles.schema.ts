import { boolean, index, jsonb, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Per-profile model tuning, stored as JSON rather than as three more columns.
 *
 * Deliberately JSON: these are pass-through knobs for whichever vendor SDK
 * ends up handling the call, and the set of knobs that matters differs per
 * provider and drifts with each vendor's API. Promoting them to columns would
 * mean a migration every time a provider grows a parameter worth exposing,
 * for values nothing ever queries or joins on. Only the three below are read
 * today (`llm-provider.types.ts`); an unknown key is ignored, not an error.
 */
export interface AgentProfileConfig {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One LLM "agent profile" — a provider, a model on it, and the tuning to call
 * it with. API keys are NOT here: a profile has many keys, each with its own
 * health and priority, so they live in `agent_credentials` (one-to-many).
 *
 * `provider` is a plain `varchar(40)` with NO pgEnum and NO CHECK constraint,
 * unlike every other closed value set in this schema (`enums.schema.ts`).
 * That is a deliberate exception, and the reason is migrations:
 *
 *   - A `pgEnum` needs `ALTER TYPE ... ADD VALUE` to gain a provider, i.e. a
 *     migration, a review and a deploy before an admin can register a key for
 *     a provider we already have an adapter for.
 *   - A `varchar` + CHECK needs the CHECK dropped and recreated. Same cost.
 *   - A bare `varchar` needs nothing. Adding a provider becomes: one entry in
 *     `PROVIDER_CODES` (`ai.constants.ts`), one new adapter class, one line in
 *     `LlmProviderRegistry` — and TypeScript refuses to compile until that
 *     registry line exists, because the registry is typed
 *     `Record<ProviderCode, LlmProviderAdapter>`. No DB change at all.
 *
 * The trade is that the database will accept a `provider` string no adapter
 * can serve (a hand-written INSERT, a restored dump from a build that knew a
 * provider this one does not). That is handled, not ignored: the DTO layer
 * validates against `PROVIDER_CODES`, and the registry answers an unknown
 * code with `AI_ERROR_CODES.UNSUPPORTED_PROVIDER` rather than a crash — a
 * profile it cannot serve is simply skipped by rotation instead of poisoning
 * the whole candidate list. Given the value set is authored by us (not by
 * users) and every write path validates it, the integrity a CHECK would add
 * is smaller than the release friction it would cost.
 *
 * `baseUrl` is what makes this table small: OpenRouter, Groq, Together,
 * DeepSeek, xAI, Fireworks and Alibaba/DashScope are all OpenAI-compatible,
 * so they are one `provider = 'openai_compatible'` adapter pointed at
 * different hosts, not seven adapters. NULL means "the SDK's own default
 * endpoint" — the same convention `SLIDE_BASE_URL` already uses.
 *
 * `priority` is the outer sort key of the rotation candidate list
 * (`ai-rotation.service.ts`): lower runs first, so the cheap/preferred
 * provider is tried before the expensive fallback. `smallint` because the
 * value is an ordering hint, never arithmetic — DTOs cap it at the 32767
 * ceiling explicitly.
 *
 * `isActive` is the admin's kill switch for a whole provider. Rotation also
 * has an automatic mechanism (per-credential `cooldown_until`), but the two
 * are strictly separate: nothing in this module ever writes `is_active`.
 * See `ai-rotation.service.ts`.
 */
export const agentProfilesTable = pgTable(
  'agent_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Admin-facing label, unique so the panel's profile list is unambiguous. */
    name: varchar('name', { length: 120 }).notNull().unique(),
    /** One of `PROVIDER_CODES` (`ai.constants.ts`) — see this table's doc comment for why it is not an enum. */
    provider: varchar('provider', { length: 40 }).notNull(),
    /** Vendor model id, verbatim — e.g. `gpt-4o-mini`, `claude-sonnet-4-5`, `gemini-2.0-flash`, `qwen-plus`. */
    model: varchar('model', { length: 120 }).notNull(),
    /** Override endpoint for OpenAI-compatible hosts. NULL = the SDK's own default. `text`, not `varchar`: a URL has no meaningful length bound worth enforcing at the column. */
    baseUrl: text('base_url'),
    config: jsonb('config').$type<AgentProfileConfig>().notNull().default({}),
    priority: smallint('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  // Serves the rotation candidate query, which is always "active profiles,
  // cheapest priority first" — the only read on this table that runs on a
  // request path rather than in the admin panel.
  (table) => [index().on(table.isActive, table.priority)],
);

export type AgentProfileRow = typeof agentProfilesTable.$inferSelect;
export type NewAgentProfileRow = typeof agentProfilesTable.$inferInsert;
