import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { reportRequestStatusEnum } from './enums.schema';

/**
 * Patient and doctor are read through the consultation — the treating doctor
 * is always `consultations.doctor_id`. No `fulfilled_at` — the arriving
 * `patient_files` row carries that time in its `created_at`. No `due_by`
 * either: no requirement sets or chases a deadline.
 */
export const reportRequestsTable = pgTable(
  'report_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    /** What is needed. */
    title: varchar('title', { length: 160 }).notNull(),
    /** Why — shown to the patient. */
    reason: text('reason'),
    status: reportRequestStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.consultationId, table.status),
    index().on(table.status, table.createdAt),
  ],
);

export type ReportRequestRow = typeof reportRequestsTable.$inferSelect;
export type NewReportRequestRow = typeof reportRequestsTable.$inferInsert;
