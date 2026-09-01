import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { doctorDocumentTypeEnum, documentReviewStatusEnum } from './enums.schema';
import { doctorsTable } from './doctors.schema';

/**
 * Separate from `patient_files` on purpose — these are the doctor's own
 * credentials, read only by admins and that doctor. No `size_bytes`/`mime_type`:
 * the object store is authoritative for both. No `expires_on`: verifying
 * registrations is a client obligation under SRS section 8, not this release.
 */
export const doctorDocumentsTable = pgTable(
  'doctor_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    documentType: doctorDocumentTypeEnum('document_type').notNull(),
    /** Object-store key, never exposed to the client. */
    storageKey: text('storage_key').notNull().unique(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    reviewStatus: documentReviewStatusEnum('review_status').notNull().default('pending'),
    /** The admin who checked THIS document. */
    verifiedByAdminId: uuid('verified_by_admin_id').references(() => adminsTable.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    rejectionReason: varchar('rejection_reason', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.doctorId, table.documentType),
    index().on(table.reviewStatus, table.createdAt),
  ],
);

export type DoctorDocumentRow = typeof doctorDocumentsTable.$inferSelect;
export type NewDoctorDocumentRow = typeof doctorDocumentsTable.$inferInsert;
