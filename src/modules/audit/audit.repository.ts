import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { auditLogTable, type AuditLogRow } from '../../schema/audit-log.schema';
import type { AuditAction } from '../../schema/enums.schema';
import type { AuditLogFilter } from './audit.types';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * `audit_log` READS, for this module only. `shared/audit/audit.service.ts`
 * owns the one and only WRITE (`AuditService.write`); this repository never
 * inserts a row through the ordinary path, and its one write method
 * (`deleteEligibleBatch`) is the narrow, name-restricted exception the
 * retention sweep uses — see `audit.constants.ts#AUDIT_PURGE_ELIGIBLE_
 * ACTIONS` for why it can only ever touch `login`/`verify` rows.
 */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** `GET /admin/audit/log` and the CSV export — same query, different row cap. Newest first, `id` as the tiebreaker (`created_at` is not unique). */
  async listForAdmin(filter: AuditLogFilter, executor: Executor = this.db): Promise<AuditLogRow[]> {
    const conditions = [];
    if (filter.actorType !== undefined) conditions.push(eq(auditLogTable.actorType, filter.actorType));
    if (filter.actorId !== undefined) conditions.push(eq(auditLogTable.actorId, filter.actorId));
    if (filter.entityType !== undefined) conditions.push(eq(auditLogTable.entityType, filter.entityType));
    if (filter.action !== undefined) conditions.push(eq(auditLogTable.action, filter.action));
    if (filter.from !== undefined) conditions.push(gte(auditLogTable.createdAt, filter.from));
    if (filter.to !== undefined) conditions.push(lte(auditLogTable.createdAt, filter.to));

    const query = executor.select().from(auditLogTable);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

    return filtered.orderBy(desc(auditLogTable.createdAt), desc(auditLogTable.id)).limit(filter.limit).offset(filter.offset);
  }

  /**
   * *** THE ONLY WRITE THIS REPOSITORY MAKES, AND IT IS A DELETE. ***
   *
   * One statement per call: a `DELETE ... WHERE id IN (subquery)`, the
   * subquery being the oldest `batchSize` rows older than `cutoff` whose
   * `action` is one of `eligibleActions`. This is a single atomic statement
   * rather than a read-then-delete pair, so there is no window in which a
   * concurrent sweeper (a second process, or the next tick racing a slow
   * pass) could read a row this call is about to delete and double-count it
   * — the `DELETE` itself is what decides which rows disappear, and a second
   * caller's subquery simply finds fewer of them.
   *
   * `eligibleActions` is accepted as a parameter (not read from
   * `audit.constants.ts` internally) so a test can exercise the query
   * against a deliberately WRONG action list and prove the WHERE clause is
   * what enforces the restriction — the same "policy in, mechanism here"
   * split `search.repository.ts#listForAdmin` uses for its filter object.
   *
   * Returns the ids actually deleted, so the caller can log a real count
   * without a second query.
   */
  async deleteEligibleBatch(
    cutoff: Date,
    eligibleActions: readonly AuditAction[],
    batchSize: number,
    executor: Executor = this.db,
  ): Promise<number[]> {
    if (eligibleActions.length === 0) return [];

    const candidateIds = executor
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(lte(auditLogTable.createdAt, cutoff), inArray(auditLogTable.action, [...eligibleActions])))
      .orderBy(asc(auditLogTable.createdAt), asc(auditLogTable.id))
      .limit(batchSize);

    const deleted = await executor
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, candidateIds))
      .returning({ id: auditLogTable.id });

    return deleted.map((row) => row.id);
  }
}
