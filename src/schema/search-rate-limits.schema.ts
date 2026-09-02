import { bigserial, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { searchSourceEnum } from './enums.schema';

/**
 * One row per SEARCH THAT IS ABOUT TO SPEND AN AI CALL — written immediately
 * before `SearchAiPort.completeStructured` is invoked, exactly as
 * `otp_request_attempts` is written before Slide is called, and counted the
 * same way (`count(*) where subject and created_at >= now() - window`). No
 * Redis: a DB-indexed count is correct across every instance of the service,
 * which an in-process counter is not.
 *
 * WHY NOT JUST COUNT `search_queries`, which already has `patient_id` and
 * `created_at`? Three reasons, each on its own sufficient:
 *   1. It would count the wrong thing. Every crisis-gated query and every
 *      query served by the deterministic matcher (AI kill switch off, AI
 *      unavailable, AI output rejected) is logged there but costs nothing.
 *      Throttling a patient for searches that never touched a model is both
 *      unfair and useless as a cost control.
 *   2. It would be resettable by the patient. `search_queries` is named in
 *      its own doc comment as in-scope for `data_deletion_requests`
 *      execution; a retention purge is also planned for it. Either one
 *      silently zeroes the throttle. A counter you can clear by asking for
 *      your data to be deleted is not a counter.
 *   3. Different lifetimes. This table is pure short-lived rate-limit noise
 *      with no dispute or analytics value past the counting window, so the
 *      retention-purge job can drop rows aggressively; `search_queries` is a
 *      historical record feeding FR-5.7.
 *
 * No FK to `patients` — same reasoning as `otp_request_attempts`: a row here
 * can outlive the account it counted, and `patient_id` is legitimately null
 * for the unattributed `mcp`/`whatsapp` sources, which are counted per
 * SOURCE instead. (Known limitation, flagged rather than hidden: every
 * unattributed caller on a given source currently shares one bucket. The
 * surface that owns those callers — M-09's MCP tools — should carry its own
 * per-client identity before that traffic is opened up.)
 */
export const searchRateLimitsTable = pgTable(
  'search_rate_limits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Null for an unattributed source — see the class doc comment. */
    patientId: uuid('patient_id'),
    source: searchSourceEnum('source').notNull().default('app'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // The per-patient count. B-tree indexes include NULLs, so the
    // `patient_id is null` (unattributed) probe uses this index too.
    index().on(table.patientId, table.createdAt),
    // The per-source count for unattributed traffic.
    index().on(table.source, table.createdAt),
    // Read by the retention-purge job.
    index().on(table.createdAt),
  ],
);

export type SearchRateLimitRow = typeof searchRateLimitsTable.$inferSelect;
export type NewSearchRateLimitRow = typeof searchRateLimitsTable.$inferInsert;
