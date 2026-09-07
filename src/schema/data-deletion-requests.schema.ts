import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { adminsTable } from './admins.schema';
import { deletionStatusEnum } from './enums.schema';
import { doctorsTable } from './doctors.schema';
import { patientsTable } from './patients.schema';

/**
 * Required by App Store guideline 5.1.1(v) and the DPDP Act. The evidence
 * outlives the data it describes. Deleted and retained were two columns
 * written in the same transaction and always read together, so they are
 * one — `execution_outcome` also carries a failed run's reason, so there is
 * no separate `failure_reason`.
 *
 * *** ADDITIVE (account-deletion lifecycle round). *** Widened from
 * patient-only to patient-OR-doctor:
 *   - `patient_id` is now NULLABLE; `doctor_id` joins it, also nullable.
 *     `account_xor_check` enforces exactly one is set — the same
 *     nullable-pair-plus-CHECK shape `consents.schema.ts` already uses for
 *     the identical "this row is about a patient XOR a doctor" fact.
 *   - `scheduled_for`: when the grace period elapses and the sweep
 *     (`data-rights-execution-sweep.service.ts`) may auto-approve and
 *     execute this request if no admin has decided it by then. Set once, at
 *     `raiseRequest` time, from `compliance.deletion_grace_period_days`.
 *   - `cancelled_at`: set by `cancelRequest`, the one write the REQUESTING
 *     account itself may make after `approved` (right up until execution) —
 *     see `enums.schema.ts#DELETION_STATUSES`'s new `'cancelled'` value.
 *   - Two PARTIAL UNIQUE indexes, one per account column, `WHERE status IN
 *     ('requested','in_review','approved')` — closes a real race
 *     `data-deletion.service.ts#raiseRequest`'s own header used to admit:
 *     "there is no `data_deletion_requests` constraint preventing
 *     duplicates" was an application-level-only guard; two concurrent
 *     `POST`s could each pass the check before either inserted. Postgres
 *     now refuses the second row outright.
 */
export const dataDeletionRequestsTable = pgTable(
  'data_deletion_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id').references(() => patientsTable.id),
    doctorId: uuid('doctor_id').references(() => doctorsTable.id),
    status: deletionStatusEnum('status').notNull().default('requested'),
    reason: text('reason'),
    reviewedByAdminId: uuid('reviewed_by_admin_id').references(() => adminsTable.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewNote: text('review_note'),
    /** One record of what happened — per-table counts, lawful retention grounds, or a failure reason. Written once, at execution. */
    executionOutcome: jsonb('execution_outcome').$type<unknown>(),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
    /** When the grace period elapses — the sweep's own trigger, not a promise to execute at exactly this instant. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.status, table.createdAt),
    index().on(table.patientId),
    index().on(table.doctorId),
    /** The sweep's own query shape: due, non-terminal requests. */
    index().on(table.scheduledFor, table.status),
    check('data_deletion_requests_account_xor_check', sql`(${table.patientId} is not null) <> (${table.doctorId} is not null)`),
    uniqueIndex('data_deletion_requests_open_patient_idx')
      .on(table.patientId)
      .where(sql`${table.status} IN ('requested','in_review','approved')`),
    uniqueIndex('data_deletion_requests_open_doctor_idx')
      .on(table.doctorId)
      .where(sql`${table.status} IN ('requested','in_review','approved')`),
  ],
);

export type DataDeletionRequestRow = typeof dataDeletionRequestsTable.$inferSelect;
export type NewDataDeletionRequestRow = typeof dataDeletionRequestsTable.$inferInsert;
