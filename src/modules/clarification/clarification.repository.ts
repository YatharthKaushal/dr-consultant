import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  clarificationCasesTable,
  type ClarificationCaseRow,
  type NewClarificationCaseRow,
} from '../../schema/clarification-cases.schema';
import type { ClarificationStatus } from '../../schema/enums.schema';

/** Either a pooled handle or an open transaction — every method takes one, `clinical.repository.ts`'s pattern. */
type Executor = Database | DatabaseTransaction;

/** Shared narrowing for the two scoped list reads below. */
export interface ListClarificationCasesFilter {
  status?: ClarificationStatus;
  limit: number;
  offset: number;
}

/**
 * All of this module's SQL against `clarification_cases`
 * (`backend/README.md` §2: "repositories hold the SQL"). Every rule — the
 * WHO-MAY-BE-ASKED seniority check, the state machine, the message cap, the
 * de-identified projection — lives in `clarification.service.ts`/
 * `clarification.mapper.ts`, never here.
 *
 * *** THE TWO LIST METHODS ARE THE STRUCTURAL HALF OF CHECK #2. ***
 * `listByExpertDoctor` takes `expertDoctorId` as a REQUIRED, non-optional
 * parameter and puts it in the `WHERE` clause — there is no method on this
 * class an expert-facing call site could reach for "every case", only "every
 * case assigned to this one doctor id". The single-row reads
 * (`findById`/`findByIdForUpdate`) are NOT pre-filtered by owner, matching
 * `booking.repository.ts#findById`'s own convention — the service checks
 * ownership against the row it gets back and throws the shared 404 either
 * way (`clarification.service.ts#requireOwnCase`/`#requireAssignedCase`), so
 * "does not exist" and "is not yours" stay indistinguishable to the caller.
 */
@Injectable()
export class ClarificationRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Reads ────────────────────────────────────────────────────────────── */

  async findById(id: string, executor: Executor = this.db): Promise<ClarificationCaseRow | null> {
    const [row] = await executor.select().from(clarificationCasesTable).where(eq(clarificationCasesTable.id, id)).limit(1);
    return row ?? null;
  }

  /** *** THE ROW LOCK. *** `SELECT ... FOR UPDATE`, inside the caller's transaction — `tx` is required, not defaulted, exactly as `clinical.repository.ts#findByConsultationIdForUpdate` requires one. */
  async findByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<ClarificationCaseRow | null> {
    const [row] = await tx
      .select()
      .from(clarificationCasesTable)
      .where(eq(clarificationCasesTable.id, id))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** Every case this doctor POSTED (or is drafting) — `treatingDoctorId` in the `WHERE` clause, never applied after the fact. */
  async listByTreatingDoctor(
    treatingDoctorId: string,
    filter: ListClarificationCasesFilter,
    executor: Executor = this.db,
  ): Promise<ClarificationCaseRow[]> {
    const conditions = [eq(clarificationCasesTable.treatingDoctorId, treatingDoctorId)];
    if (filter.status) conditions.push(eq(clarificationCasesTable.status, filter.status));
    return executor
      .select()
      .from(clarificationCasesTable)
      .where(and(...conditions))
      .orderBy(desc(clarificationCasesTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /**
   * *** THE QUERY CHECK #2 ("WHAT THEY MAY SEE") DEPENDS ON. *** Every case
   * assigned to this expert, and structurally nothing else — `expertDoctorId`
   * is a required parameter and sits directly in `WHERE`, so there is no way
   * to call this method for "every case" by omitting it.
   */
  async listByExpertDoctor(
    expertDoctorId: string,
    filter: ListClarificationCasesFilter,
    executor: Executor = this.db,
  ): Promise<ClarificationCaseRow[]> {
    const conditions = [eq(clarificationCasesTable.expertDoctorId, expertDoctorId)];
    if (filter.status) conditions.push(eq(clarificationCasesTable.status, filter.status));
    return executor
      .select()
      .from(clarificationCasesTable)
      .where(and(...conditions))
      .orderBy(desc(clarificationCasesTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /** The admin tracker's list — every case, admin-only callers reach this through `ClarificationService`, never through the facade. */
  async listForAdmin(
    filter: ListClarificationCasesFilter & { urgency?: string },
    executor: Executor = this.db,
  ): Promise<ClarificationCaseRow[]> {
    const conditions = filter.status ? [eq(clarificationCasesTable.status, filter.status)] : [];
    return executor
      .select()
      .from(clarificationCasesTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(clarificationCasesTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /* ── Writes ───────────────────────────────────────────────────────────── */

  async create(data: NewClarificationCaseRow, executor: Executor = this.db): Promise<ClarificationCaseRow> {
    const [row] = await executor.insert(clarificationCasesTable).values(data).returning();
    if (!row) {
      throw new Error('clarification_cases insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * Patches a DRAFT in place. The `status = 'draft'` predicate is in the
   * `WHERE` clause, not a read-then-write check above it — `clinical.
   * repository.ts#updateDraft`'s reasoning: there is no window in which a
   * concurrent post can be overwritten by a stale edit. Returns `null` when
   * the guard did not match (not a draft, or gone).
   */
  async updateDraftFields(
    id: string,
    patch: Partial<NewClarificationCaseRow>,
    executor: Executor = this.db,
  ): Promise<ClarificationCaseRow | null> {
    const [row] = await executor
      .update(clarificationCasesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clarificationCasesTable.id, id), eq(clarificationCasesTable.status, 'draft')))
      .returning();
    return row ?? null;
  }

  /**
   * *** THE STATE MACHINE, WRITTEN. *** One guarded `UPDATE ... WHERE id = ?
   * AND status IN (from)`, exactly the shape `booking.repository.ts` names
   * `updateStatusIfIn` and `LEGAL_VIDEO_STATUS_TRANSITIONS`'s doc comment
   * describes. `patch` carries whatever ELSE this particular move writes
   * (`expertDoctorId`/`assignedAt` for an assignment, `messages` for a
   * reply, `postedAt`/`closedAt` for those two moves) so the status move and
   * its side-effects commit as one row write, never two. Returns `null` when
   * the guard did not match — the caller's `from` did not include the row's
   * current status, i.e. an illegal transition.
   */
  async updateStatusIfIn(
    id: string,
    from: readonly ClarificationStatus[],
    patch: Partial<NewClarificationCaseRow> & { status: ClarificationStatus },
    executor: Executor = this.db,
  ): Promise<ClarificationCaseRow | null> {
    if (from.length === 0) return null;
    const [row] = await executor
      .update(clarificationCasesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clarificationCasesTable.id, id), inArray(clarificationCasesTable.status, [...from])))
      .returning();
    return row ?? null;
  }

  /**
   * ADDITIVE (M-21/data rights execution): a patient data-deletion preview
   * needs a row count for `clarification_cases` without touching any of
   * them — this table is RETAIN in the M-21 compliance survey (its case
   * content is already de-identified per this table's own doc comment;
   * `source_consultation_id` is kept "for the treating doctor and audit
   * ONLY", which is exactly the audit-trail exception the survey applies).
   * Counts rows whose (nullable) `source_consultation_id` is in the given
   * list. Empty array in, `0` out, no query issued — `inArray(col, [])` is
   * unsafe SQL otherwise.
   */
  async countCasesForConsultations(consultationIds: readonly string[], executor: Executor = this.db): Promise<number> {
    if (consultationIds.length === 0) return 0;
    const [row] = await executor
      .select({ value: count() })
      .from(clarificationCasesTable)
      .where(inArray(clarificationCasesTable.sourceConsultationId, [...consultationIds]));
    return row?.value ?? 0;
  }
}
