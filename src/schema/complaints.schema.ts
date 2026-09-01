import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { complaintCategoryEnum, complaintStatusEnum } from './enums.schema';
import { consultationsTable } from './consultations.schema';
import { patientsTable } from './patients.schema';

/**
 * FR-18.8 tracks resolution, so `resolved_at` stays beside a four-state
 * status — `rejected` is not resolved, and neither is derivable from the
 * other.
 */
export const complaintsTable = pgTable(
  'complaints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The ticket number the patient quotes to support. */
    referenceCode: varchar('reference_code', { length: 24 }).notNull().unique(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    /** Null when not about one consultation. */
    consultationId: uuid('consultation_id').references(() => consultationsTable.id),
    category: complaintCategoryEnum('category').notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    description: text('description').notNull(),
    status: complaintStatusEnum('status').notNull().default('open'),
    assignedToAdminId: uuid('assigned_to_admin_id').references(() => adminsTable.id),
    /** Array of — author_id, author_type, body, is_internal, at. */
    messages: jsonb('messages').$type<unknown[]>().notNull().default([]),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.status, table.createdAt), index().on(table.patientId)],
);

export type ComplaintRow = typeof complaintsTable.$inferSelect;
export type NewComplaintRow = typeof complaintsTable.$inferInsert;
