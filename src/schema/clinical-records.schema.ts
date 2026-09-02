import { boolean, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { riskCategoryEnum } from './enums.schema';

/**
 * THE COMPLETION GATE. Setting `finalised_at` requires `case_summary`, plus
 * either a medicine line (prescribing specialty) or the advice fields
 * (non-prescribing). The same transaction clears `doctors.blocked_by_consultation_id`.
 *
 * `consultation_id` references `consultations.id` and is UNIQUE, so the
 * relationship is 1:1. Migration 0006 corrected this direction: it used to run
 * backwards (`consultations.id -> clinical_records.consultation_id`) and
 * non-deferrably, which meant a booking could not be inserted without first
 * fabricating a clinical record — impossible, since `chief_complaint` and
 * `risk_category` are NOT NULL and only exist AFTER the consult.
 *
 * There is no `has_clinical_doubt` flag — a doubt IS a `clarification_cases`
 * row with `source_consultation_id` set.
 *
 * There is no `recommended_content_ids` here either — doctor-recommended
 * Care Hub items (FR-15.4) are `content_recommendations` rows, because
 * MODULES M-18 owns that data, not M-15; see `content-recommendations.schema.ts`.
 */
export const clinicalRecordsTable = pgTable(
  'clinical_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .unique()
      .references(() => consultationsTable.id),
    chiefComplaint: text('chief_complaint').notNull(),
    clinicalHistory: text('clinical_history'),
    /** Diagnosis or provisional diagnosis. */
    diagnosis: text('diagnosis'),
    isDiagnosisProvisional: boolean('is_diagnosis_provisional').notNull().default(true),
    riskCategory: riskCategoryEnum('risk_category').notNull(),
    /** Set = a referral was advised, and this is it. No separate referral_advised flag. */
    referralNote: varchar('referral_note', { length: 255 }),
    /** Array of — name, dose, frequency, duration, instructions. */
    medicines: jsonb('medicines').$type<unknown[]>().notNull().default([]),
    /** What was covered this session. */
    adviceCovered: text('advice_covered'),
    adviceHomePractice: text('advice_home_practice'),
    adviceNextFocus: text('advice_next_focus'),
    /** Surfaced on the patient Care Plan, FR-14.1. */
    adviceWarningSigns: text('advice_warning_signs'),
    /** 3 to 5 lines — required before finalising. */
    caseSummary: text('case_summary'),
    /** *** THE COMPLETION GATE *** NULL = still a draft. */
    finalisedAt: timestamp('finalised_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.finalisedAt)],
);

export type ClinicalRecordRow = typeof clinicalRecordsTable.$inferSelect;
export type NewClinicalRecordRow = typeof clinicalRecordsTable.$inferInsert;
