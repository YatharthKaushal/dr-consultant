import { date, index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { checkinStatusEnum } from './enums.schema';

/**
 * One row per patient per day. A MISSING row past its date raises a
 * `missed_checkin` alert. No `triggered_rules` — answers plus the pinned
 * pathway version reproduce exactly which rules fired.
 */
export const checkinResponsesTable = pgTable(
  'checkin_responses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    checkinDate: date('checkin_date').notNull(),
    /** Keyed to the pinned pathway question set. */
    answers: jsonb('answers').$type<unknown>().notNull(),
    status: checkinStatusEnum('status').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.consultationId, table.checkinDate),
    index().on(table.status, table.submittedAt),
  ],
);

export type CheckinResponseRow = typeof checkinResponsesTable.$inferSelect;
export type NewCheckinResponseRow = typeof checkinResponsesTable.$inferInsert;
