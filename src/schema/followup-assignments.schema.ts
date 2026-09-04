import { date, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { followupStatusEnum } from './enums.schema';
import { followupPathwaysTable } from './followup-pathways.schema';

/**
 * *** NOT ONE OF THE THREE TABLES THE M-16 BUILD PLAN NAMED AS PRE-EXISTING.
 * ADDED DELIBERATELY, FLAGGED HERE RATHER THAN SILENTLY. ***
 *
 * `followup_pathways` is versioned whole precisely so an in-flight assignment
 * can keep the version it started on (FR-13.7). Something has to record, per
 * consultation, WHICH pathway row (a specific `code`+`version`, not a
 * re-resolvable `code`) applies and from what date. `checkin_responses`
 * deliberately carries no such column — its own header says "answers plus
 * the pinned pathway version reproduce exactly which rules fired", which
 * presupposes the pin is recorded somewhere else.
 *
 * `consultations.followup_pathway_id` / `followup_starts_on` /
 * `followup_status` already model exactly this. They are BOOKING's columns
 * though (`booking.mapper.ts`: "they live on the consultations row but
 * belong to M-16 ... and this module has no business publishing them"), and
 * `backend/README.md` §2 forbids one module writing another's table. Reaching
 * them needs an ADDITIVE `BookingContract` method — the same seam
 * `clinical-booking.contract.ts` documents for `completeConsultation` — and
 * this worktree's guardrails leave `src/modules/booking/*` untouched, so that
 * extension is the coordinator's to make post-merge, not this table's author's.
 *
 * This table is the honest alternative in the meantime: `followup` owns its
 * own pin, is fully correct standing alone, and the coordinator can choose to
 * ALSO mirror it onto `consultations` later by growing `BookingContract` —
 * see `followup.service.ts#assignPathway`'s header for the full account of
 * the gap this closes.
 */
export const followupAssignmentsTable = pgTable(
  'followup_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** One assignment per consultation — a re-assignment updates this row in place, it does not add a second. */
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    /** The PINNED row — one specific (code, version). Never re-resolved against `is_current` after this write. */
    pathwayId: uuid('pathway_id')
      .notNull()
      .references(() => followupPathwaysTable.id),
    /** IST calendar date the seven (or `duration_days`) day window starts. */
    startsOn: date('starts_on').notNull(),
    status: followupStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex().on(table.consultationId), index().on(table.status, table.startsOn)],
);

export type FollowupAssignmentRow = typeof followupAssignmentsTable.$inferSelect;
export type NewFollowupAssignmentRow = typeof followupAssignmentsTable.$inferInsert;
