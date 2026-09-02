import { bigserial, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per authenticated MCP request, for per-client rate limiting.
 *
 * Deliberately the same DB-counter shape as `otp_request_attempts` rather
 * than an in-process counter: this backend is designed to be run as more than
 * one process (`backend/README.md` §1's extraction path), and a per-process
 * counter would multiply every client's real limit by the instance count
 * while silently resetting on every deploy. Counting rows in a window is the
 * precedent already set for the OTP endpoints, and it is the one that stays
 * correct behind a load balancer.
 *
 * A row is written AFTER the key is verified, keyed by `mcp_client_id`, so an
 * unauthenticated caller can never grow this table — the limit protects our
 * tool execution budget from an authorised-but-runaway integration, and
 * unauthenticated traffic is already refused before it gets here.
 *
 * No FK cascade concerns: this is short-lived rate-limit noise with no
 * dispute or audit value (the audit trail for a client lives in `audit_log`),
 * and the `created_at` index is what a retention purge reads.
 */
export const mcpRequestAttemptsTable = pgTable(
  'mcp_request_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mcpClientId: uuid('mcp_client_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // The counting query: WHERE mcp_client_id = $1 AND created_at >= $2.
    index().on(table.mcpClientId, table.createdAt),
    index().on(table.createdAt),
  ],
);

export type McpRequestAttemptRow = typeof mcpRequestAttemptsTable.$inferSelect;
export type NewMcpRequestAttemptRow = typeof mcpRequestAttemptsTable.$inferInsert;
