import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { complaintsTable, type ComplaintRow, type NewComplaintRow } from '../../schema/complaints.schema';
import type { ComplaintCategory, ComplaintStatus } from '../../schema/enums.schema';

/** Either a pooled handle or an open transaction — every method takes one, `clinical.repository.ts`'s pattern. */
type Executor = Database | DatabaseTransaction;

export interface ListComplaintsFilter {
  status?: ComplaintStatus;
  category?: ComplaintCategory;
  assignedToAdminId?: string;
  limit: number;
  offset: number;
}

/**
 * All of this module's SQL against `complaints` (`backend/README.md` §2:
 * "repositories hold the SQL"). Every rule — the reference-code generator,
 * the state machine, the message cap, the patient-visible message filter —
 * lives in `complaint.service.ts`/`complaint-message.util.ts`, never here.
 *
 * Single-row reads (`findById`/`findByIdForUpdate`) are NOT pre-filtered by
 * owner, matching `clarification.repository.ts#findById`'s own convention —
 * the service checks ownership against the row it gets back and throws the
 * shared 404 either way, so "does not exist" and "is not yours" stay
 * indistinguishable to the caller.
 */
@Injectable()
export class ComplaintRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Reads ────────────────────────────────────────────────────────────── */

  async findById(id: string, executor: Executor = this.db): Promise<ComplaintRow | null> {
    const [row] = await executor.select().from(complaintsTable).where(eq(complaintsTable.id, id)).limit(1);
    return row ?? null;
  }

  /** *** THE ROW LOCK. *** `SELECT ... FOR UPDATE`, inside the caller's transaction — `tx` is required, not defaulted, `clarification.repository.ts#findByIdForUpdate`'s pattern. */
  async findByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<ComplaintRow | null> {
    const [row] = await tx.select().from(complaintsTable).where(eq(complaintsTable.id, id)).limit(1).for('update');
    return row ?? null;
  }

  /** Reference codes are unique; this backs the retry loop in `complaint.service.ts#generateReferenceCode` — `booking.repository.ts#referenceCodeExists`'s pattern. */
  async referenceCodeExists(referenceCode: string, executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ id: complaintsTable.id })
      .from(complaintsTable)
      .where(eq(complaintsTable.referenceCode, referenceCode))
      .limit(1);
    return row !== undefined;
  }

  /** The patient's own complaints — `patientId` in the `WHERE` clause, never applied after the fact. */
  async listByPatientId(
    patientId: string,
    filter: { status?: ComplaintStatus; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<ComplaintRow[]> {
    const conditions = [eq(complaintsTable.patientId, patientId)];
    if (filter.status) conditions.push(eq(complaintsTable.status, filter.status));
    return executor
      .select()
      .from(complaintsTable)
      .where(and(...conditions))
      .orderBy(desc(complaintsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /** The admin tracker's list — FR-18.8: filterable by status, category and assignee. */
  async listForAdmin(filter: ListComplaintsFilter, executor: Executor = this.db): Promise<ComplaintRow[]> {
    const conditions = [];
    if (filter.status) conditions.push(eq(complaintsTable.status, filter.status));
    if (filter.category) conditions.push(eq(complaintsTable.category, filter.category));
    if (filter.assignedToAdminId) conditions.push(eq(complaintsTable.assignedToAdminId, filter.assignedToAdminId));
    return executor
      .select()
      .from(complaintsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(complaintsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /**
   * *** THE M-20 SEAM'S QUERY. *** One `GROUP BY status` read, matching
   * `referral.repository.ts#countForReferrerGrouped`'s "one query for every
   * count, not one per status" shape. A status with zero rows is simply
   * absent from the result — `complaint.service.ts#countComplaintsByStatus`
   * is what fills every `COMPLAINT_STATUSES` key in, defaulting to `0`.
   */
  async countByStatusGrouped(executor: Executor = this.db): Promise<Map<ComplaintStatus, number>> {
    const rows = await executor.select({ status: complaintsTable.status, value: count() }).from(complaintsTable).groupBy(complaintsTable.status);
    return new Map(rows.map((row) => [row.status, row.value]));
  }

  /**
   * ADDITIVE (M-21/data rights execution). READ-ONLY row count of
   * `complaints` for one patient — `complaints` is RETAIN in the M-21
   * survey (M-19's own done-when: "a complaint can be raised, tracked and
   * closed with its full history kept", `docs/MODULES.md`), so this exists
   * purely to report a count in a data-deletion preview; nothing here is
   * ever written.
   */
  async countByPatientId(patientId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(complaintsTable).where(eq(complaintsTable.patientId, patientId));
    return row?.value ?? 0;
  }

  /* ── Writes ───────────────────────────────────────────────────────────── */

  async create(data: NewComplaintRow, executor: Executor = this.db): Promise<ComplaintRow> {
    const [row] = await executor.insert(complaintsTable).values(data).returning();
    if (!row) {
      throw new Error('complaints insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * A `messages`-only write (no status change) — used when a patient or
   * admin adds a message that is not itself a workflow transition. The
   * `WHERE id = ?` guard alone (no status predicate) is enough: unlike the
   * state machine below, appending a message is legal from every status —
   * see `feedback.constants.ts#COMPLAINT_STATUS_TRANSITIONS`'s header for
   * why messages and transitions are deliberately independent here, unlike
   * M-17's turn-based cases.
   */
  async appendMessages(id: string, messages: unknown[], executor: Executor = this.db): Promise<ComplaintRow | null> {
    const [row] = await executor
      .update(complaintsTable)
      .set({ messages, updatedAt: new Date() })
      .where(eq(complaintsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * *** THE STATE MACHINE, WRITTEN. *** One guarded `UPDATE ... WHERE id = ?
   * AND status = <from>`, `clarification.repository.ts#updateStatusIfIn`'s
   * shape narrowed to a single `from` status (this module's transitions each
   * have exactly one legal source — see `COMPLAINT_STATUS_TRANSITIONS`).
   * `patch` carries whatever else this move writes (`assignedToAdminId` for
   * an assignment, `resolvedAt`/`resolutionNote` for a resolution,
   * `resolutionNote` alone for a rejection) so the status move and its
   * side-effects commit as one row write. Returns `null` when the guard did
   * not match — an illegal transition.
   */
  async updateStatusIfFrom(
    id: string,
    from: ComplaintStatus,
    patch: Partial<NewComplaintRow> & { status: ComplaintStatus },
    executor: Executor = this.db,
  ): Promise<ComplaintRow | null> {
    const [row] = await executor
      .update(complaintsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(complaintsTable.id, id), eq(complaintsTable.status, from)))
      .returning();
    return row ?? null;
  }
}
