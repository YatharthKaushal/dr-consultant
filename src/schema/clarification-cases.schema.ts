import { index, jsonb, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { clarificationStatusEnum, clarificationUrgencyEnum, genderEnum } from './enums.schema';

/**
 * TWO independent checks. `seniority_level = expert` says WHO MAY BE ASKED.
 * `expert_doctor_id` says WHAT THEY MAY SEE. Nothing here reaches the patient
 * automatically. No `viewed_at`/`responded_at` — the status enum already
 * carries `awaiting_response`/`response_received`, and the expert reply is a
 * `messages` entry carrying its own `at`.
 */
export const clarificationCasesTable = pgTable(
  'clarification_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    treatingDoctorId: uuid('treating_doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    /** For the treating doctor and audit ONLY — never exposed to the reviewer. */
    sourceConsultationId: uuid('source_consultation_id').references(() => consultationsTable.id),
    title: varchar('title', { length: 200 }).notNull(),
    patientAge: smallint('patient_age'),
    patientGender: genderEnum('patient_gender'),
    briefHistory: text('brief_history').notNull(),
    diagnosis: text('diagnosis'),
    currentPlan: text('current_plan'),
    specificDoubt: text('specific_doubt').notNull(),
    urgency: clarificationUrgencyEnum('urgency').notNull().default('routine'),
    /** Must be a doctor with seniority_level = expert. */
    expertDoctorId: uuid('expert_doctor_id').references(() => doctorsTable.id),
    /** Drives the urgency queue. Which admin assigned it is the audit_log row. */
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }),
    /** Array of — author_id, author_type, message_type, body, at. */
    messages: jsonb('messages').$type<unknown[]>().notNull().default([]),
    status: clarificationStatusEnum('status').notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.treatingDoctorId, table.status),
    index().on(table.expertDoctorId, table.status),
    index().on(table.status, table.urgency),
  ],
);

export type ClarificationCaseRow = typeof clarificationCasesTable.$inferSelect;
export type NewClarificationCaseRow = typeof clarificationCasesTable.$inferInsert;
