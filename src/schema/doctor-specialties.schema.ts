import { boolean, index, pgTable, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { doctorsTable } from './doctors.schema';
import { specialtiesTable } from './specialties.schema';

/**
 * A doctor can practise under more than one specialty (FR-4.3, M-05 both say
 * "specialties", plural) — psychiatrist-and-de-addiction is the launch set's
 * most common real overlap. `is_primary` picks the default shown on the
 * doctor's profile and listing; it does NOT gate prescribing — that stays
 * `consultations.specialty_id -> specialties.can_prescribe`, the booking-time
 * snapshot of which specialty a given consultation was actually held under,
 * unaffected by which specialty a doctor happens to default to.
 *
 * Fee, consultation duration and buffer stay doctor-wide on `doctors` — this
 * table is about which specialties a doctor is listed and matched under, not
 * per-specialty pricing, which nothing in the SRS asks for.
 */
export const doctorSpecialtiesTable = pgTable(
  'doctor_specialties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    specialtyId: uuid('specialty_id')
      .notNull()
      .references(() => specialtiesTable.id),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Also the composite-FK target used by doctor_clinical_templates and by
    // consultations (a consultation's assigned doctor must actually
    // practise the specialty it was booked under). MUST be a table
    // constraint (unique()), not a bare uniqueIndex(): drizzle-kit inlines
    // a unique() constraint into this table's own CREATE TABLE statement,
    // so it exists before either dependent migration statement runs. A
    // standalone CREATE UNIQUE INDEX is not ordered ahead of a cross-table
    // FK that depends on it — see legal-documents.schema.ts for the same
    // fix and the migration failure it corrects.
    unique().on(table.doctorId, table.specialtyId),
    // "doctors of specialty X" — the core listing/search query.
    index().on(table.specialtyId),
    // At most one primary specialty per doctor.
    uniqueIndex('doctor_specialties_one_primary_idx')
      .on(table.doctorId)
      .where(sql`${table.isPrimary} = true`),
  ],
);

export type DoctorSpecialtyRow = typeof doctorSpecialtiesTable.$inferSelect;
export type NewDoctorSpecialtyRow = typeof doctorSpecialtiesTable.$inferInsert;
