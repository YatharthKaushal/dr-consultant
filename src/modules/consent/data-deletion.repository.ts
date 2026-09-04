import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import {
  dataDeletionRequestsTable,
  type DataDeletionRequestRow,
  type NewDataDeletionRequestRow,
} from '../../schema/data-deletion-requests.schema';
import type { DeletionStatus } from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/** `data_deletion_requests` — the request and its review status only. Execution (`executed_at`/`execution_outcome`) is never written here; see `data-deletion.service.ts`. */
@Injectable()
export class DataDeletionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(
    data: Pick<NewDataDeletionRequestRow, 'patientId' | 'reason'>,
    executor: Executor = this.db,
  ): Promise<DataDeletionRequestRow> {
    const [row] = await executor.insert(dataDeletionRequestsTable).values(data).returning();
    if (!row) {
      throw new Error('data_deletion_requests insert returned no row — should be unreachable.');
    }
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor.select().from(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, id)).limit(1);
    return row ?? null;
  }

  /** This patient's whole request history, newest first. */
  async listByPatient(patientId: string, executor: Executor = this.db): Promise<DataDeletionRequestRow[]> {
    return executor
      .select()
      .from(dataDeletionRequestsTable)
      .where(eq(dataDeletionRequestsTable.patientId, patientId))
      .orderBy(desc(dataDeletionRequestsTable.createdAt));
  }

  /** Whether this patient already has an OPEN request — `requested` or `in_review` — so a second one is refused rather than silently duplicated. */
  async findOpenByPatient(patientId: string, executor: Executor = this.db): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor
      .select()
      .from(dataDeletionRequestsTable)
      .where(
        and(
          eq(dataDeletionRequestsTable.patientId, patientId),
          inArray(dataDeletionRequestsTable.status, ['requested', 'in_review']),
        ),
      )
      .orderBy(desc(dataDeletionRequestsTable.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The admin queue. `status` narrows it (e.g. to `requested`, the pending ones); omitted lists every request. */
  async listForAdmin(
    input: { status?: DeletionStatus; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<DataDeletionRequestRow[]> {
    const { status, limit, offset } = input;
    return executor
      .select()
      .from(dataDeletionRequestsTable)
      .where(status ? eq(dataDeletionRequestsTable.status, status) : undefined)
      .orderBy(desc(dataDeletionRequestsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * The admin review write. *** NEVER TOUCHES `executed_at`/`execution_outcome` —
   * THOSE TWO COLUMNS ARE NOT PARAMETERS HERE ON PURPOSE. *** See
   * `data-deletion.service.ts#reviewRequest`'s header comment for why: this
   * module owns the request and its review status only, never execution.
   */
  async updateReview(
    id: string,
    data: { status: DeletionStatus; reviewedByAdminId: string; reviewedAt: Date; reviewNote: string | null },
    executor: Executor = this.db,
  ): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor
      .update(dataDeletionRequestsTable)
      .set(data)
      .where(eq(dataDeletionRequestsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * ADDITIVE (M-21/data rights execution). *** THE ONLY WRITE TO
   * `executed_at`/`execution_outcome` IN THIS REPOSITORY. *** Deliberately a
   * sibling of `updateReview`, not a widening of it — `updateReview`'s own
   * header says those two columns "are not parameters here on purpose".
   * Unconditional on the row's current status; `data-deletion.service.ts
   * #recordExecutionOutcome` is what enforces "only from `approved`" before
   * calling this.
   */
  /**
   * *** GUARDED ON `status = 'approved'` IN THE WHERE CLAUSE ITSELF. *** This
   * is what actually makes two concurrent `executeForRequest` calls on the
   * SAME request safe, not the plain `existing.status !== 'approved'` read
   * `DataDeletionService#recordExecutionOutcome` does before calling this —
   * that earlier read is a TOCTOU check on its own (two callers can both
   * read `approved` before either commits). Postgres serializes two
   * concurrent `UPDATE ... WHERE id = ? AND status = 'approved'` statements
   * against the same row via the row lock: the first to commit wins, and
   * the second's WHERE no longer matches once the winner's new `status` has
   * committed, so it affects zero rows and this returns `null` — the caller
   * turns that into an honest `ConflictException`, never a silent second
   * "success".
   */
  async recordExecutionOutcome(
    id: string,
    data: { status: DeletionStatus; executionOutcome: unknown; executedAt: Date },
    executor: Executor = this.db,
  ): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor
      .update(dataDeletionRequestsTable)
      .set(data)
      .where(and(eq(dataDeletionRequestsTable.id, id), eq(dataDeletionRequestsTable.status, 'approved')))
      .returning();
    return row ?? null;
  }
}
