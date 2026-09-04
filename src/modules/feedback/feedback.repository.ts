import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { feedbackTable, type FeedbackRow, type NewFeedbackRow } from '../../schema/feedback.schema';

/** Either a pooled handle or an open transaction — every method takes one, `clinical.repository.ts`'s pattern. */
type Executor = Database | DatabaseTransaction;

export interface ListFeedbackFilter {
  rating?: number;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
}

/**
 * All of this module's SQL against `feedback` (`backend/README.md` §2:
 * "repositories hold the SQL"). No rules live here — the one-per-
 * consultation guarantee is `feedback.schema.ts`'s `UNIQUE(consultation_id)`
 * itself, and `feedback.service.ts` is what turns a collision on it into a
 * clean 409.
 */
@Injectable()
export class FeedbackRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByConsultationId(consultationId: string, executor: Executor = this.db): Promise<FeedbackRow | null> {
    const [row] = await executor.select().from(feedbackTable).where(eq(feedbackTable.consultationId, consultationId)).limit(1);
    return row ?? null;
  }

  async create(data: NewFeedbackRow, executor: Executor = this.db): Promise<FeedbackRow> {
    const [row] = await executor.insert(feedbackTable).values(data).returning();
    if (!row) {
      throw new Error('feedback insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * ADDITIVE (M-21/data rights execution). READ-ONLY row count of `feedback`
   * for one patient — `feedback` is RETAIN in the M-21 survey (M-19's own
   * done-when: "a complaint can be raised, tracked and closed with its full
   * history kept", `docs/MODULES.md`), so this exists purely to report a
   * count in a data-deletion preview; nothing here is ever written.
   */
  async countByPatientId(patientId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(feedbackTable).where(eq(feedbackTable.patientId, patientId));
    return row?.value ?? 0;
  }

  /** The admin review surface's list — FR-18.8: filterable by rating and by date. */
  async listForAdmin(filter: ListFeedbackFilter, executor: Executor = this.db): Promise<FeedbackRow[]> {
    const conditions = [];
    if (filter.rating !== undefined) conditions.push(eq(feedbackTable.rating, filter.rating));
    if (filter.dateFrom !== undefined) conditions.push(gte(feedbackTable.createdAt, filter.dateFrom));
    if (filter.dateTo !== undefined) conditions.push(lte(feedbackTable.createdAt, filter.dateTo));
    return executor
      .select()
      .from(feedbackTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(feedbackTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }
}
