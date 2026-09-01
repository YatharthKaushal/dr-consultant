import {
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { clinicalRecordsTable } from './clinical-records.schema';
import { concernsTable } from './concerns.schema';
// Forward reference for `doctor_id` — genuinely circular with doctors.schema.ts
// (which references consultations.id via `blocked_by_consultation_id`).
// Resolved via the lazy `(): AnyPgColumn =>` callback form.
import { doctorsTable } from './doctors.schema';
// One-directional: doctor_specialties never references consultations back.
import { doctorSpecialtiesTable } from './doctor-specialties.schema';
import { consultationModeEnum, consultationStatusEnum, followupStatusEnum, partyEnum } from './enums.schema';
import { followupPathwaysTable } from './followup-pathways.schema';
import { patientsTable } from './patients.schema';
// Only `consultations.id -> payments.consultation_id` exists (see below) —
// payments.schema.ts has no FK back to this table, so this import is
// one-directional, not circular.
import { paymentsTable } from './payments.schema';
import { specialtiesTable } from './specialties.schema';

/**
 * NO video or audio is recorded. Join/leave times live in
 * `consultation_participants`; `status = no_show` plus the absence of a row
 * for that party is what names the no-show. The follow-up window ends at
 * `followup_starts_on` plus the pinned pathway `duration_days`.
 *
 * `id` carries two FKs the *other* way round, exactly as `docs/erd.sql`
 * declares them — `payments.consultation_id` and `clinical_records.consultation_id`
 * are each UNIQUE NOT NULL, and it is `consultations.id` that references
 * them, not the reverse. See `foreignKey()` entries below.
 *
 * Double-booking prevention and the partial index behind the
 * pending-documentation worklist are, per `docs/erd.sql`, added by hand in
 * the first migration (`db/README.md`, not yet written) — not expressed here.
 */
export const consultationsTable = pgTable(
  'consultations',
  {
    /** *** THE CONSULTATION ID *** */
    id: uuid('id').defaultRandom().primaryKey(),
    referenceCode: varchar('reference_code', { length: 24 }).notNull().unique(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    /** NULL only while an instant request is still searching for a doctor. */
    doctorId: uuid('doctor_id').references((): AnyPgColumn => doctorsTable.id),
    /** BOOKING-TIME SNAPSHOT — not derivable, since concern_id/doctor_id are both nullable. */
    specialtyId: uuid('specialty_id')
      .notNull()
      .references(() => specialtiesTable.id),
    concernId: uuid('concern_id').references(() => concernsTable.id),
    mode: consultationModeEnum('mode').notNull(),
    status: consultationStatusEnum('status').notNull().default('pending_payment'),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true, mode: 'date' }),
    durationMinutes: smallint('duration_minutes').notNull(),
    /** While status = pending_payment this row IS the slot hold; a sweep expires it. */
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true, mode: 'date' }),
    /** Snapshot of answers to the specialty intake form. There is no separate patient_note. */
    intakeAnswers: jsonb('intake_answers').$type<unknown>(),
    /** Self-reference — the prior consultation this replaced. */
    rescheduledFromConsultationId: uuid('rescheduled_from_consultation_id').references(
      (): AnyPgColumn => consultationsTable.id,
    ),
    /**
     * Self-reference — this consultation is a REVIEW of that one (FR-13.6's
     * "continue with the same doctor"), distinct from
     * `rescheduled_from_consultation_id` which REPLACED one. Presence is
     * what makes the `reconsult_policy` legal document applicable, and what
     * turns the per-patient row history into the chronological timeline
     * FR-19.6 asks the data model to be prepared for.
     */
    followupOfConsultationId: uuid('followup_of_consultation_id').references(
      (): AnyPgColumn => consultationsTable.id,
    ),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelledByParty: partyEnum('cancelled_by_party'),
    cancellationReason: varchar('cancellation_reason', { length: 200 }),
    /** Pinned to the pathway version in force when assigned. */
    followupPathwayId: uuid('followup_pathway_id').references(() => followupPathwaysTable.id),
    followupStartsOn: date('followup_starts_on'),
    /** `cancelled` is the state no date arithmetic can produce, which is why this stays. */
    followupStatus: followupStatusEnum('followup_status').notNull().default('none'),
    /** FR-13.8 — DOCTOR-added daily check-in questions for THIS patient only. Carry NO red-flag rules. */
    extraCheckinQuestions: jsonb('extra_checkin_questions').$type<unknown[]>().notNull().default([]),
    /** 1 to 5. Set = feedback submitted, so there is no feedback_at. */
    feedbackRating: smallint('feedback_rating'),
    feedbackComment: text('feedback_comment'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.patientId, table.status),
    index().on(table.doctorId, table.status),
    index().on(table.doctorId, table.scheduledStartAt),
    index().on(table.status, table.scheduledStartAt),
    index().on(table.followupStatus, table.followupStartsOn),
    index().on(table.holdExpiresAt),
    index().on(table.followupOfConsultationId),
    foreignKey({
      columns: [table.id],
      foreignColumns: [paymentsTable.consultationId],
      name: 'consultations_id_payments_consultation_id_fk',
    }),
    foreignKey({
      columns: [table.id],
      foreignColumns: [clinicalRecordsTable.consultationId],
      name: 'consultations_id_clinical_records_consultation_id_fk',
    }),
    // An assigned doctor must actually practise the specialty this
    // consultation was booked under. Vacuously satisfied while doctor_id is
    // still null during instant-request routing (MATCH SIMPLE); enforced
    // the moment a doctor is assigned.
    foreignKey({
      columns: [table.doctorId, table.specialtyId],
      foreignColumns: [doctorSpecialtiesTable.doctorId, doctorSpecialtiesTable.specialtyId],
      name: 'consultations_doctor_specialty_fk',
    }),
  ],
);

export type ConsultationRow = typeof consultationsTable.$inferSelect;
export type NewConsultationRow = typeof consultationsTable.$inferInsert;
