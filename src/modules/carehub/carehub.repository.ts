import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { contentItemsTable, type ContentItemRow, type NewContentItemRow } from '../../schema/content-items.schema';
import {
  contentRecommendationsTable,
  type ContentRecommendationRow,
  type NewContentRecommendationRow,
} from '../../schema/content-recommendations.schema';
import type { ContentItemType, ContentReviewStatus } from '../../schema/enums.schema';

/** Either a pooled handle or an open transaction (`shared/audit/audit.service.ts`'s pattern) — every method takes one so a caller can compose it into its own transaction. */
type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL against `content_items` and `content_recommendations`
 * (`backend/README.md` §2: "repositories hold the SQL"). Business rules — the
 * review state machine, the recommendation ownership check, the patient-facing
 * type restriction — live in `carehub.service.ts`, never here.
 *
 * One class covering both tables, not two repositories: they are the same
 * module's data, `content_recommendations` exists specifically so this module
 * does not have to write into `clinical_records`
 * (`content-recommendations.schema.ts`'s own header), and every recommendation
 * write is immediately followed by a content-item read in the same request —
 * splitting them would only add a second constructor injection with no
 * boundary behind it.
 */
@Injectable()
export class CarehubRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── content_items: reads ────────────────────────────────────────────── */

  async findById(id: string, executor: Executor = this.db): Promise<ContentItemRow | null> {
    const [row] = await executor.select().from(contentItemsTable).where(eq(contentItemsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByIds(ids: readonly string[], executor: Executor = this.db): Promise<ContentItemRow[]> {
    if (ids.length === 0) return [];
    return executor.select().from(contentItemsTable).where(inArray(contentItemsTable.id, ids));
  }

  /** Published content only, optionally narrowed by `itemType`/`concernId` and excluding one or more types (the service passes `PATIENT_FACING_ITEM_TYPES`'s complement — see `carehub.constants.ts`). Ordered `sortOrder` then newest first, per the schema's own doc comment. */
  async listPublished(
    filter: { itemType?: ContentItemType; concernId?: string; excludeItemTypes?: readonly ContentItemType[] },
    executor: Executor = this.db,
  ): Promise<ContentItemRow[]> {
    const conditions = [eq(contentItemsTable.reviewStatus, 'published' as const)];
    if (filter.itemType) conditions.push(eq(contentItemsTable.itemType, filter.itemType));
    if (filter.concernId) conditions.push(eq(contentItemsTable.concernId, filter.concernId));
    if (filter.excludeItemTypes && filter.excludeItemTypes.length > 0) {
      conditions.push(notInArray(contentItemsTable.itemType, filter.excludeItemTypes as ContentItemType[]));
    }
    return executor
      .select()
      .from(contentItemsTable)
      .where(and(...conditions))
      .orderBy(asc(contentItemsTable.sortOrder), desc(contentItemsTable.createdAt));
  }

  /** Admin listing — every review status, optionally narrowed. */
  async listForAdmin(
    filter: { itemType?: ContentItemType; reviewStatus?: ContentReviewStatus; concernId?: string },
    executor: Executor = this.db,
  ): Promise<ContentItemRow[]> {
    const conditions = [];
    if (filter.itemType) conditions.push(eq(contentItemsTable.itemType, filter.itemType));
    if (filter.reviewStatus) conditions.push(eq(contentItemsTable.reviewStatus, filter.reviewStatus));
    if (filter.concernId) conditions.push(eq(contentItemsTable.concernId, filter.concernId));
    const query = executor.select().from(contentItemsTable);
    return (conditions.length > 0 ? query.where(and(...conditions)) : query).orderBy(
      asc(contentItemsTable.sortOrder),
      desc(contentItemsTable.createdAt),
    );
  }

  /* ── content_items: writes ───────────────────────────────────────────── */

  async create(data: NewContentItemRow, executor: Executor = this.db): Promise<ContentItemRow> {
    const [row] = await executor.insert(contentItemsTable).values(data).returning();
    if (!row) throw new Error('content_items insert returned no row — should be unreachable.');
    return row;
  }

  async update(id: string, patch: Partial<NewContentItemRow>, executor: Executor = this.db): Promise<ContentItemRow | null> {
    const [row] = await executor
      .update(contentItemsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(contentItemsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * *** THE GUARDED STATE-MACHINE MOVE. *** The `from` set is in the WHERE
   * clause, not a read-then-write check above it — the same reasoning
   * `clinical.repository.ts#updateDraft` gives for its `finalised_at IS NULL`
   * predicate. Returns `null` when the guard did not match (the row does not
   * exist, or its current status is not one of `from`).
   */
  async transitionReviewStatus(
    id: string,
    to: ContentReviewStatus,
    from: readonly ContentReviewStatus[],
    reviewSignOff: { reviewedByAdminId: string; reviewedAt: Date } | null,
    executor: Executor = this.db,
  ): Promise<ContentItemRow | null> {
    const patch: Partial<NewContentItemRow> = { reviewStatus: to, updatedAt: new Date() };
    if (reviewSignOff) {
      patch.reviewedByAdminId = reviewSignOff.reviewedByAdminId;
      patch.reviewedAt = reviewSignOff.reviewedAt;
    }
    const [row] = await executor
      .update(contentItemsTable)
      .set(patch)
      .where(and(eq(contentItemsTable.id, id), inArray(contentItemsTable.reviewStatus, from)))
      .returning();
    return row ?? null;
  }

  /* ── content_recommendations ─────────────────────────────────────────── */

  /**
   * `ON CONFLICT DO NOTHING` on the `(consultation_id, content_item_id)`
   * unique index — a doctor re-selecting an item they already recommended is
   * a success from the caller's point of view, the same reasoning
   * `promotion.repository.ts#insertRewardInstrumentIfAbsent` gives for its
   * own conflict target. Returns `null` when the pair already existed.
   */
  async addRecommendationIfAbsent(
    data: NewContentRecommendationRow,
    executor: Executor = this.db,
  ): Promise<ContentRecommendationRow | null> {
    const [row] = await executor
      .insert(contentRecommendationsTable)
      .values(data)
      .onConflictDoNothing({ target: [contentRecommendationsTable.consultationId, contentRecommendationsTable.contentItemId] })
      .returning();
    return row ?? null;
  }

  async removeRecommendation(consultationId: string, contentItemId: string, executor: Executor = this.db): Promise<boolean> {
    const rows = await executor
      .delete(contentRecommendationsTable)
      .where(
        and(
          eq(contentRecommendationsTable.consultationId, consultationId),
          eq(contentRecommendationsTable.contentItemId, contentItemId),
        ),
      )
      .returning({ id: contentRecommendationsTable.id });
    return rows.length > 0;
  }

  /** Oldest first — the order recommendations were made. */
  async listRecommendationsForConsultation(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<ContentRecommendationRow[]> {
    return executor
      .select()
      .from(contentRecommendationsTable)
      .where(eq(contentRecommendationsTable.consultationId, consultationId))
      .orderBy(asc(contentRecommendationsTable.createdAt));
  }

  /**
   * ADDITIVE (M-21/data rights execution): a patient data-deletion preview
   * needs a row count for `content_recommendations` without touching any of
   * them — this table is RETAIN in the M-21 compliance survey (SRS §5.3), so
   * this is a pure `SELECT COUNT`, never a delete. Empty array in, `0` out,
   * no query issued — `inArray(col, [])` is unsafe SQL otherwise.
   */
  async countRecommendationsForConsultations(consultationIds: readonly string[], executor: Executor = this.db): Promise<number> {
    if (consultationIds.length === 0) return 0;
    const [row] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(contentRecommendationsTable)
      .where(inArray(contentRecommendationsTable.consultationId, consultationIds as string[]));
    return Number(row?.count ?? 0);
  }
}
