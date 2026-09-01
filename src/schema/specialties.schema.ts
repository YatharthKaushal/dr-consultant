import { boolean, check, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Adding a row here is how a new specialty goes live — no code change, no
 * app release.
 */
export const specialtiesTable = pgTable(
  'specialties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** psychiatry, psychology, therapy, counselling, de_addiction. */
    code: varchar('code', { length: 60 }).notNull().unique(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    /** THE prescribing gate. psychiatry true, the rest false. */
    canPrescribe: boolean('can_prescribe').notNull().default(false),
    /** Ordered field list — key, label, input type, options, required. */
    intakeForm: jsonb('intake_form').$type<unknown>(),
    /** The medical-history block, asked only on a first consultation. */
    firstConsultForm: jsonb('first_consult_form').$type<unknown>(),
    /**
     * Admin-authored starter content for the medicine section of a
     * consultation, `[{ name, dose, frequency, duration, instructions }]`,
     * seeding `clinical_records.medicines`. Never set where `can_prescribe`
     * is false — enforced by the CHECK below, not by convention.
     *
     * A doctor applying this COPIES it into the clinical_records row, so a
     * later admin edit here can never retroactively alter a finalised
     * record — same reasoning `consultations.intake_answers` relies on.
     * There is no version history column: an edit here is an `audit_log`
     * row (`entity_type = 'specialty'`) carrying the before/after, exactly
     * like `app_config` changes already are.
     *
     * Distinct from `doctor_clinical_templates`: this is the ONE
     * admin-authored default per specialty (M-06); that table holds MANY
     * doctor-authored personal templates (M-15, FR-9.6).
     */
    prescriptionTemplate: jsonb('prescription_template').$type<unknown>(),
    /** Admin-authored starter text for the four `advice_*` fields, `{ covered, homePractice, nextFocus, warningSigns }` — written for every specialty, prescribing or not. Same copy-not-reference and audit-log-versioned reasoning as `prescriptionTemplate` above. */
    adviceTemplate: jsonb('advice_template').$type<unknown>(),
    /** doctor_document_type values a doctor of this specialty must submit. */
    requiredDocuments: jsonb('required_documents').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'specialties_prescription_template_check',
      sql`${table.canPrescribe} or ${table.prescriptionTemplate} is null`,
    ),
  ],
);

export type SpecialtyRow = typeof specialtiesTable.$inferSelect;
export type NewSpecialtyRow = typeof specialtiesTable.$inferInsert;
