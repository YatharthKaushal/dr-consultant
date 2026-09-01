import { bigserial, boolean, index, jsonb, pgTable, smallint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { patientsTable } from './patients.schema';

/**
 * One row per symptom/category search (FR-5.1–5.11). Serves BOTH of M-09's
 * "recent searches" and "query logs" — recent searches is just `LIMIT n` on
 * this same log ordered by `created_at desc` per patient, so splitting them
 * into two tables would be the unnecessary split.
 *
 * `concerns.matchPhrases`/`matchWeight` already hold the mapping rules and
 * synonyms; `app_config` already holds `search.crisis_keywords` and
 * `search.popular_searches` as admin-edited data. This table does NOT
 * replace `search.popular_searches` — that list stays admin-edited per
 * FR-5.11, not computed from this log; don't "improve" it into a computed
 * ranking later.
 *
 * `matched_concern_ids` is a deliberately unenforced jsonb array (no FK):
 * this is a historical record of what the mapper decided at that moment, in
 * rank order, and a later edit or deactivation of a concern must not rewrite
 * that history. Contrast with `content_recommendations`, where the
 * equivalent ids ARE a real FK, because that table is live-read to render a
 * screen rather than logged for history.
 *
 * Must be included in `data_deletion_requests` execution — a free-text
 * symptom query is among the most sensitive strings this platform stores.
 */
export const searchQueriesTable = pgTable(
  'search_queries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    queryText: varchar('query_text', { length: 500 }).notNull(),
    /** FR-5.10 — spoken input, already transcribed to text by the time it lands here. */
    isVoiceInput: boolean('is_voice_input').notNull().default(false),
    /** Rank-ordered ids the mapper matched, FR-5.4's "matched to: sleep, anxiety". */
    matchedConcernIds: jsonb('matched_concern_ids').$type<string[]>().notNull().default([]),
    /** How many doctors this query returned — what finds "phrasings that return zero doctors" for FR-5.7's admin mapping edits. */
    resultCount: smallint('result_count').notNull().default(0),
    /** FR-5.6 — did the crisis guardrail interrupt booking for this query. */
    crisisGuardrailFired: boolean('crisis_guardrail_fired').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.patientId, table.createdAt), index().on(table.createdAt)],
);

export type SearchQueryRow = typeof searchQueriesTable.$inferSelect;
export type NewSearchQueryRow = typeof searchQueriesTable.$inferInsert;
