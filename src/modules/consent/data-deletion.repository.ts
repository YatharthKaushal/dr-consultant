import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import {
  dataDeletionRequestsTable,
  type DataDeletionRequestRow,
} from '../../schema/data-deletion-requests.schema';
import type { DeletableAccountType, DeletionStatus } from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/** The three non-terminal statuses — open in the sense a duplicate-request guard and the sweep both care about. */
const OPEN_STATUSES: readonly DeletionStatus[] = ['requested', 'in_review', 'approved'];

/** `data_deletion_requests` — the request and its review status only. Execution (`executed_at`/`execution_outcome`) is never written here; see `data-deletion.service.ts`. */
@Injectable()
export class DataDeletionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(
    data: { patientId: string | null; doctorId: string | null; reason: string | null; scheduledFor: Date },
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

  /** This account's whole request history, newest first. */
  async listByAccount(accountType: DeletableAccountType, accountId: string, executor: Executor = this.db): Promise<DataDeletionRequestRow[]> {
    const column = accountType === 'patient' ? dataDeletionRequestsTable.patientId : dataDeletionRequestsTable.doctorId;
    return executor.select().from(dataDeletionRequestsTable).where(eq(column, accountId)).orderBy(desc(dataDeletionRequestsTable.createdAt));
  }

  /**
   * Whether this account already has an OPEN request. The DB now ALSO
   * enforces this (the partial unique indexes `data-deletion-requests.
   * schema.ts` adds) — this read stays because it lets `raiseRequest`
   * return the EXISTING open request rather than a 409 on the common,
   * legitimate case of a double-tap; the unique index is the backstop for
   * the race the read alone cannot close.
   */
  async findOpenByAccount(accountType: DeletableAccountType, accountId: string, executor: Executor = this.db): Promise<DataDeletionRequestRow | null> {
    const column = accountType === 'patient' ? dataDeletionRequestsTable.patientId : dataDeletionRequestsTable.doctorId;
    const [row] = await executor
      .select()
      .from(dataDeletionRequestsTable)
      .where(and(eq(column, accountId), inArray(dataDeletionRequestsTable.status, [...OPEN_STATUSES])))
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
   * ADDITIVE (account-deletion lifecycle round). The one write the
   * REQUESTING account itself may make — `cancelRequest`'s own guard.
   * Guarded on the same OPEN statuses in the `WHERE` clause itself, the
   * same conditional-update discipline `recordExecutionOutcome` below uses:
   * a request that has already moved to `rejected`/`executed`/`failed`
   * between the service's read and this write affects zero rows, and the
   * caller turns that into an honest `ConflictException` rather than a
   * silent no-op success.
   */
  async cancel(id: string, cancelledAt: Date, executor: Executor = this.db): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor
      .update(dataDeletionRequestsTable)
      .set({ status: 'cancelled', cancelledAt })
      .where(and(eq(dataDeletionRequestsTable.id, id), inArray(dataDeletionRequestsTable.status, [...OPEN_STATUSES])))
      .returning();
    return row ?? null;
  }

  /**
   * ADDITIVE (account-deletion lifecycle round). The sweep's own write —
   * `requested`/`in_review` -> `approved`, WITHOUT a `reviewed_by_admin_id`
   * (stays `null`, honestly: no admin reviewed this, the grace period
   * simply elapsed). `reviewed_at` is still stamped, so "when was this
   * decided" stays answerable the same way for every request regardless of
   * who/what decided it.
   */
  async autoApprove(id: string, reviewedAt: Date, executor: Executor = this.db): Promise<DataDeletionRequestRow | null> {
    const [row] = await executor
      .update(dataDeletionRequestsTable)
      .set({ status: 'approved', reviewedAt })
      .where(and(eq(dataDeletionRequestsTable.id, id), inArray(dataDeletionRequestsTable.status, ['requested', 'in_review'])))
      .returning();
    return row ?? null;
  }

  /**
   * ADDITIVE (M-21/data rights execution). *** THE ONLY WRITE TO
   * `executed_at`/`execution_outcome` IN THIS REPOSITORY. *** Deliberately a
   * sibling of `updateReview`, not a widening of it — `updateReview`'s own
   * header says those two columns "are not parameters here on purpose".
   *
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

  /**
   * ADDITIVE (account-deletion lifecycle round). *** THE SWEEP'S OWN QUERY. ***
   * Every request whose grace period has elapsed (`scheduled_for <= now`, or
   * never set — a defensive `OR isNull` for any row written before this
   * column existed) and is still in a state the sweep may act on:
   * `requested`/`in_review` (needs `autoApprove` first) or already
   * `approved` (ready for `executeForRequest` directly). Never
   * `cancelled`/`rejected`/`executed`/`failed` — those are terminal from the
   * sweep's perspective, the same as from an admin's.
   */
  async listDueForSweep(now: Date, limit: number, executor: Executor = this.db): Promise<DataDeletionRequestRow[]> {
    return executor
      .select()
      .from(dataDeletionRequestsTable)
      .where(
        and(
          or(lte(dataDeletionRequestsTable.scheduledFor, now), isNull(dataDeletionRequestsTable.scheduledFor)),
          inArray(dataDeletionRequestsTable.status, ['requested', 'in_review', 'approved']),
        ),
      )
      .orderBy(dataDeletionRequestsTable.scheduledFor)
      .limit(limit);
  }
}
