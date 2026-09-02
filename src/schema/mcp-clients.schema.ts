import { boolean, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * An external machine authorised to call our MCP tool endpoint — a
 * third-party automation aggregator, not a person.
 *
 * WHY THIS IS NOT AN `accounts` ROW. `account_type` is
 * `patient | doctor | admin`, and every one of those is a human with a mobile
 * number, an OTP sign-in flow, a `token_version` and a consent history. An
 * aggregator has none of that: it authenticates with a long-lived static key,
 * has no profile, and can never be the subject of a consultation. Widening
 * `ACCOUNT_TYPES` for it would push a fourth value into every account-type
 * check, guard and enum in the codebase to model something that shares no
 * behaviour with the other three. It gets its own table instead.
 *
 * `hashed_key` stores a salted scrypt digest, never the key itself — see
 * `mcp-client-key.util.ts` for the encoding. The plaintext key exists exactly
 * once, in the response to `POST /admin/mcp/clients`, and is not recoverable
 * afterwards by any code path: no endpoint returns it, and no column holds
 * it. `key_prefix`/`key_last4` exist so an admin can tell two keys apart in a
 * listing without either being usable as a credential.
 *
 * `scopes` is the list of tool NAMES this client may call
 * (`search-tool.constants.ts`'s `TOOL_NAMES`). Empty by default: a freshly
 * created client can authenticate but can call nothing, so forgetting to set
 * scopes fails closed.
 */
export const mcpClientsTable = pgTable(
  'mcp_clients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Human-facing label for the integration, e.g. "WhatsApp aggregator (staging)". */
    name: varchar('name', { length: 120 }).notNull().unique(),
    /** `scrypt$N$r$p$<salt-b64>$<hash-b64>` — self-describing so the cost parameters can be raised later without a migration. */
    hashedKey: text('hashed_key').notNull(),
    /**
     * The key's leading characters. UNIQUE because it is also the lookup
     * handle: authentication finds the candidate row by prefix and then does
     * one constant-time verification, rather than scrypt-ing the presented
     * key against every active client in the table.
     */
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull().unique(),
    keyLast4: varchar('key_last4', { length: 4 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.isActive)],
);

export type McpClientRow = typeof mcpClientsTable.$inferSelect;
export type NewMcpClientRow = typeof mcpClientsTable.$inferInsert;
