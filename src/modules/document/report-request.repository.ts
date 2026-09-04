import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { reportRequestsTable, type NewReportRequestRow, type ReportRequestRow } from '../../schema/report-requests.schema';
import type { ReportRequestStatus } from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. Same pattern as `search-config.repository.ts`. */
type Executor = Database | DatabaseTransaction;

/**
 * `report_requests` CRUD. No `raised_by_doctor_id` column exists — the
 * raising doctor is always `consultations.doctor_id`, read via
 * `ConsultationLookupPort` by the service layer, never stored redundantly
 * here (`report-requests.schema.ts`'s own comment; `docs/MODULES.md`'s "with
 * the raising doctor and date recorded" is satisfied by that derivation).
 */
@Injectable()
export class ReportRequestRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(data: NewReportRequestRow, executor: Executor = this.db): Promise<ReportRequestRow> {
    const [row] = await executor.insert(reportRequestsTable).values(data).returning();
    if (!row) {
      throw new Error('report_requests insert returned no row — should be unreachable.');
    }
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<ReportRequestRow | null> {
    const [row] = await executor.select().from(reportRequestsTable).where(eq(reportRequestsTable.id, id)).limit(1);
    return row ?? null;
  }

  async listByConsultation(consultationId: string, executor: Executor = this.db): Promise<ReportRequestRow[]> {
    return executor
      .select()
      .from(reportRequestsTable)
      .where(eq(reportRequestsTable.consultationId, consultationId))
      .orderBy(desc(reportRequestsTable.createdAt));
  }

  /** Every report request raised across a set of consultation ids — backs the patient's own "my report requests" listing, derived from their own consultations. Empty array in, empty array out (no query issued). */
  async listByConsultations(consultationIds: string[], executor: Executor = this.db): Promise<ReportRequestRow[]> {
    if (consultationIds.length === 0) return [];
    return executor
      .select()
      .from(reportRequestsTable)
      .where(inArray(reportRequestsTable.consultationId, consultationIds))
      .orderBy(desc(reportRequestsTable.createdAt));
  }

  /**
   * ADDITIVE (M-21/data rights execution): a patient data-deletion preview
   * needs a row count for `report_requests` without touching any of them —
   * `report_requests` is RETAIN in the M-21 compliance survey (SRS §5.3), so
   * this is a pure `SELECT COUNT`, never a delete. Empty array in, `0` out,
   * no query issued — same guard as `listByConsultations` above, because
   * `inArray(col, [])` is unsafe SQL.
   */
  async countByConsultations(consultationIds: readonly string[], executor: Executor = this.db): Promise<number> {
    if (consultationIds.length === 0) return 0;
    const [row] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(reportRequestsTable)
      .where(inArray(reportRequestsTable.consultationId, consultationIds as string[]));
    return Number(row?.count ?? 0);
  }

  /**
   * Atomic compare-and-swap: `UPDATE ... WHERE id = ? AND status = 'open' RETURNING`.
   * This is the ONE place either "fulfil" (implicit, on upload) or "cancel"
   * (explicit, doctor action) actually changes status — both go through this
   * same guarded update rather than a plain unconditional `SET status`, so a
   * request that flips between the caller's read and its write (fulfilled by
   * one upload while a doctor's cancel request is in flight, or vice versa)
   * is caught here, atomically, rather than racing. Returns `null` when no
   * row matched (already left `open`), which the caller treats as a conflict.
   */
  async updateStatusIfOpen(id: string, newStatus: ReportRequestStatus, executor: Executor = this.db): Promise<ReportRequestRow | null> {
    const [row] = await executor
      .update(reportRequestsTable)
      .set({ status: newStatus })
      .where(and(eq(reportRequestsTable.id, id), eq(reportRequestsTable.status, 'open')))
      .returning();
    return row ?? null;
  }
}
