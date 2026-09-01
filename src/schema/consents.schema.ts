import { foreignKey, index, inet, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { doctorsTable } from './doctors.schema';
import { legalDocumentTypeEnum } from './enums.schema';
import { legalDocumentsTable } from './legal-documents.schema';
import { patientsTable } from './patients.schema';

/**
 * No consultation may start without a current teleconsultation consent.
 * Append-only legal evidence.
 */
export const consentsTable = pgTable(
  'consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id').references(() => patientsTable.id),
    doctorId: uuid('doctor_id').references(() => doctorsTable.id),
    /** Pins the exact version accepted. */
    legalDocumentId: uuid('legal_document_id')
      .notNull()
      .references(() => legalDocumentsTable.id),
    /**
     * Denormalised so the pre-consult check needs no join. Carries a
     * composite FK to `legal_documents (id, document_type)` (below) so it
     * cannot disagree with `legal_document_id`.
     */
    documentType: legalDocumentTypeEnum('document_type').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Kept here and nowhere else on an account — this is the legal evidence of acceptance. */
    ipAddress: inet('ip_address'),
  },
  (table) => [
    uniqueIndex().on(table.patientId, table.legalDocumentId),
    uniqueIndex().on(table.doctorId, table.legalDocumentId),
    index().on(table.patientId, table.documentType),
    foreignKey({
      columns: [table.legalDocumentId, table.documentType],
      foreignColumns: [legalDocumentsTable.id, legalDocumentsTable.documentType],
      name: 'consents_legal_document_id_document_type_fk',
    }),
  ],
);

export type ConsentRow = typeof consentsTable.$inferSelect;
export type NewConsentRow = typeof consentsTable.$inferInsert;
