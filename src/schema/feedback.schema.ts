import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { patientsTable } from './patients.schema';

/**
 * FR-17.1: post-consult feedback. Deliberately small — a rating and an
 * optional free-text comment, tied to the one consultation it is about.
 *
 * *** ONE ROW PER CONSULTATION, ENFORCED BY `UNIQUE(consultation_id)`. ***
 * The same shape `checkin-responses.schema.ts` uses for its own
 * one-per-patient-per-day constraint (`UNIQUE(consultation_id,
 * checkin_date)`) — here the natural key is simpler, because unlike a daily
 * check-in there is exactly one post-consult moment per consultation, not
 * one per day. A patient rates THIS CONSULT, not the platform in general or
 * the doctor across every consult ever had, so a second submission for the
 * same consultation is a resend of the same opinion, not a new one — the
 * write path (`feedback.service.ts#submitFeedback`) turns a collision here
 * into a 409, not a silent overwrite and not a second row a "most recent
 * rating" query would have to disambiguate. There is no per-patient index
 * without `consultation_id` for the same reason `checkin_responses` has
 * none: every read this module needs is already scoped by consultation or
 * by patient-through-consultation, never "every rating a patient ever left"
 * as its own query shape.
 */
export const feedbackTable = pgTable(
  'feedback',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    /** 1-5. Range enforced below, not just in the DTO — see `feedback_rating_range_check`. */
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.consultationId),
    /** The admin review surface's two filters (FR-18.8): "by rating" and "by date". */
    index().on(table.rating, table.createdAt),
    index().on(table.patientId),
    check('feedback_rating_range_check', sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

export type FeedbackRow = typeof feedbackTable.$inferSelect;
export type NewFeedbackRow = typeof feedbackTable.$inferInsert;
