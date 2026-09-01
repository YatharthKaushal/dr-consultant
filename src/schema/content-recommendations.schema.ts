import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consultationsTable } from './consultations.schema';
import { contentItemsTable } from './content-items.schema';

/**
 * FR-15.4 — the doctor selects Care Hub items after a consult; the patient
 * sees them tagged "Recommended by your doctor". MODULES M-18 names "doctor
 * recommendations" as Care Hub's own data, not Clinical Records' — a real FK
 * on both sides, not the useless join table this schema otherwise avoids:
 * without it, archiving or deleting a `content_items` row would leave
 * dangling ids that the Care Plan (FR-14.1) live-renders as broken cards,
 * and M-18 would be reading and writing a column inside M-15's row, which
 * the module-ownership rule in `README.md` forbids.
 *
 * Holds no clinical data of its own — echoing M-18's own phrasing, "records
 * recommendations against a consultation ID, with no clinical data held
 * here" — which is exactly why this must not live inside `clinical_records`.
 */
export const contentRecommendationsTable = pgTable(
  'content_recommendations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItemsTable.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.consultationId, table.contentItemId),
    index().on(table.contentItemId),
  ],
);

export type ContentRecommendationRow = typeof contentRecommendationsTable.$inferSelect;
export type NewContentRecommendationRow = typeof contentRecommendationsTable.$inferInsert;
