import { check, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clarificationCasesTable } from './clarification-cases.schema';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { patientFileCategoryEnum } from './enums.schema';
import { patientsTable } from './patients.schema';
import { reportRequestsTable } from './report-requests.schema';

/**
 * Served only through short-lived signed URLs minted after an ownership
 * check. No `size_bytes`/`mime_type`: the object store is authoritative for
 * both.
 *
 * DE-IDENTIFICATION IS STRUCTURAL, not a coding convention. A file attached
 * to a clarification case is stored as a scrubbed copy with `patient_id`
 * NULL, enforced by the CHECK below, so an expert-facing query cannot reach
 * a patient through it even by mistake.
 */
export const patientFilesTable = pgTable(
  'patient_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileCategory: patientFileCategoryEnum('file_category').notNull(),
    /** Set for every clinical file, so history predating any booking is still readable. */
    patientId: uuid('patient_id').references(() => patientsTable.id),
    /** Set when a doctor uploaded on the patient's behalf; NULL means the patient uploaded it themselves. */
    uploadedByDoctorId: uuid('uploaded_by_doctor_id').references(() => doctorsTable.id),
    /** Null when the file belongs to the patient rather than one booking. */
    consultationId: uuid('consultation_id').references(() => consultationsTable.id),
    /** Set when uploaded against a doctor request, so it arrives labelled. */
    reportRequestId: uuid('report_request_id').references(() => reportRequestsTable.id),
    /** Set for a de-identified attachment. When set, patient_id MUST be null — enforced by CHECK. */
    clarificationCaseId: uuid('clarification_case_id').references(() => clarificationCasesTable.id),
    /** Object-store key, never exposed to the client. */
    storageKey: text('storage_key').notNull().unique(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    /** Soft delete. Set = deleted; there is no separate is_deleted flag. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.patientId, table.fileCategory),
    index().on(table.consultationId),
    index().on(table.reportRequestId),
    index().on(table.clarificationCaseId),
    check(
      'patient_files_deidentified_check',
      sql`${table.clarificationCaseId} is null or ${table.patientId} is null`,
    ),
  ],
);

export type PatientFileRow = typeof patientFilesTable.$inferSelect;
export type NewPatientFileRow = typeof patientFilesTable.$inferInsert;
