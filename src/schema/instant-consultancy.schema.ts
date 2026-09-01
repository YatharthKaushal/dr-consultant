import { index, pgTable, smallint, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { instantConsultancyOutcomeEnum } from './enums.schema';

/**
 * One row per doctor offered. Also the source for the FR-18.6
 * acceptance-rate metric, so no counter is cached on `doctors`. No
 * `responded_at` — response latency is not a reported figure.
 */
export const instantConsultancyTable = pgTable(
  'instant_consultancy',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    /** Routing order — 1 is the first doctor tried. */
    attemptNumber: smallint('attempt_number').notNull(),
    outcome: instantConsultancyOutcomeEnum('outcome').notNull().default('pending'),
    offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Acceptance window, configured in app_config. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex().on(table.consultationId, table.attemptNumber),
    index().on(table.doctorId, table.outcome),
    index().on(table.expiresAt),
  ],
);

export type InstantConsultancyRow = typeof instantConsultancyTable.$inferSelect;
export type NewInstantConsultancyRow = typeof instantConsultancyTable.$inferInsert;
