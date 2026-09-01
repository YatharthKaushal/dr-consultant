import { boolean, index, jsonb, pgTable, smallint, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Admin-editable with no app release, FR-13.7. Versioned whole, so an
 * in-flight assignment keeps the version it started on. No `published_at` —
 * `is_current` decides which version new assignments get.
 */
export const followupPathwaysTable = pgTable(
  'followup_pathways',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** depression_anxiety, sleep, substance_use, bipolar_psychosis, general. */
    code: varchar('code', { length: 60 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    version: smallint('version').notNull().default(1),
    /** The follow-up window length. `consultations.followup_starts_on` plus this IS the end date. */
    durationDays: smallint('duration_days').notNull().default(7),
    /** Ordered question set with the flag rule per option. */
    questions: jsonb('questions').$type<unknown>().notNull(),
    /** Conditions forcing a red status, FR-13.5. */
    redFlagRules: jsonb('red_flag_rules').$type<unknown>().notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.code, table.version),
    index().on(table.code, table.isCurrent),
  ],
);

export type FollowupPathwayRow = typeof followupPathwaysTable.$inferSelect;
export type NewFollowupPathwayRow = typeof followupPathwaysTable.$inferInsert;
