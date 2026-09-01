import { boolean, jsonb, pgTable, smallint, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { specialtiesTable } from './specialties.schema';

/**
 * No `sort_order` — a concern list is ordered by name, and search results by
 * `match_weight` against the query, never by a hand-set position.
 */
export const concernsTable = pgTable(
  'concerns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    specialtyId: uuid('specialty_id')
      .notNull()
      .references(() => specialtiesTable.id),
    /** depression, anxiety, sleep, ocd, substance_use, psychosis, child_adolescent, womens_mental_health, elderly_care. */
    code: varchar('code', { length: 60 }).notNull(),
    /** Also the plain-language match reason FR-5.4 shows — "matched to: sleep, anxiety". */
    name: varchar('name', { length: 120 }).notNull(),
    /** Trigger phrases and synonyms — English, Hindi and mixed. */
    matchPhrases: jsonb('match_phrases').$type<string[]>().notNull().default([]),
    matchWeight: smallint('match_weight').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [uniqueIndex().on(table.specialtyId, table.code)],
);

export type ConcernRow = typeof concernsTable.$inferSelect;
export type NewConcernRow = typeof concernsTable.$inferInsert;
