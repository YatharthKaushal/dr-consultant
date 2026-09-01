import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { deletionStatusEnum } from './enums.schema';
import { patientsTable } from './patients.schema';

/**
 * Required by App Store guideline 5.1.1(v) and the DPDP Act. The evidence
 * outlives the data it describes. Deleted and retained were two columns
 * written in the same transaction and always read together, so they are
 * one — `execution_outcome` also carries a failed run's reason, so there is
 * no separate `failure_reason`.
 */
export const dataDeletionRequestsTable = pgTable(
  'data_deletion_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    status: deletionStatusEnum('status').notNull().default('requested'),
    reason: text('reason'),
    reviewedByAdminId: uuid('reviewed_by_admin_id').references(() => adminsTable.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewNote: text('review_note'),
    /** One record of what happened — per-table counts, lawful retention grounds, or a failure reason. Written once, at execution. */
    executionOutcome: jsonb('execution_outcome').$type<unknown>(),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.status, table.createdAt), index().on(table.patientId)],
);

export type DataDeletionRequestRow = typeof dataDeletionRequestsTable.$inferSelect;
export type NewDataDeletionRequestRow = typeof dataDeletionRequestsTable.$inferInsert;
