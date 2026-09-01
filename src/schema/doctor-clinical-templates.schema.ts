import { foreignKey, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { doctorSpecialtiesTable } from './doctor-specialties.schema';
import { doctorsTable } from './doctors.schema';
import { specialtiesTable } from './specialties.schema';

/**
 * Doctor-authored, reusable across consultations (FR-9.6: "the doctor can
 * save and reuse prescription templates"). Distinct from
 * `specialties.prescriptionTemplate`/`adviceTemplate`: those are ONE
 * admin-authored default per specialty (M-06); this is MANY doctor-authored
 * personal templates (M-15), many-per-doctor.
 *
 * Shaped as a subset of `clinical_records` — the same `medicines` jsonb
 * array and the same four `advice_*` fields — so applying a template is a
 * field-for-field copy into a new `clinical_records` row with no mapping
 * layer. A non-prescribing doctor's templates simply leave `medicines`
 * empty; that is why this is one table, not a medicine/advice pair.
 *
 * Deliberately excludes `diagnosis` and `chief_complaint`. FR-9.6 scopes
 * this to cutting down prescription/advice entry time; a pre-fillable
 * diagnosis is a clinical-safety hazard, not a convenience, and must be
 * written fresh every consultation.
 *
 * No soft delete, no usage counter: nothing else references a template row
 * (applying one is a copy, not a link), so delete is a hard delete, and the
 * picker orders by `updated_at desc` — an ordering no requirement asks a
 * write-on-every-use counter to produce.
 *
 * The prescribing gate (can this doctor enter `medicines`?) is NOT
 * re-derived here from `specialty_id`. It already lives, correctly, at
 * `consultations.specialty_id -> specialties.can_prescribe` — the snapshot
 * of which specialty a given consultation was actually booked under. Adding
 * a second check here would be a second, possibly-disagreeing source of
 * truth for the same fact.
 */
export const doctorClinicalTemplatesTable = pgTable(
  'doctor_clinical_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    /** Optional context tag. When set, the composite FK below requires it be one of this doctor's actual specialties. Null = a general-purpose template. */
    specialtyId: uuid('specialty_id').references(() => specialtiesTable.id),
    /** The doctor's own label, e.g. "Standard anxiety start". */
    name: varchar('name', { length: 120 }).notNull(),
    /** Same shape as clinical_records.medicines — array of name, dose, frequency, duration, instructions. */
    medicines: jsonb('medicines').$type<unknown[]>().notNull().default([]),
    adviceCovered: text('advice_covered'),
    adviceHomePractice: text('advice_home_practice'),
    adviceNextFocus: text('advice_next_focus'),
    adviceWarningSigns: text('advice_warning_signs'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.doctorId, table.name),
    foreignKey({
      columns: [table.doctorId, table.specialtyId],
      foreignColumns: [doctorSpecialtiesTable.doctorId, doctorSpecialtiesTable.specialtyId],
      name: 'doctor_clinical_templates_doctor_specialty_fk',
    }),
  ],
);

export type DoctorClinicalTemplateRow = typeof doctorClinicalTemplatesTable.$inferSelect;
export type NewDoctorClinicalTemplateRow = typeof doctorClinicalTemplatesTable.$inferInsert;
