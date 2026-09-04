import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { SearchSource } from '../../schema/enums.schema';
import { searchQueriesTable, type SearchQueryRow } from '../../schema/search-queries.schema';
import { searchRateLimitsTable } from '../../schema/search-rate-limits.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface SearchQueryLogEntry {
  /** `null` for an unattributed source — see `search-queries.schema.ts`. */
  patientId: string | null;
  source: SearchSource;
  queryText: string;
  isVoiceInput: boolean;
  matchedConcernIds: string[];
  resultCount: number;
  crisisGuardrailFired: boolean;
}

export interface AdminQueryLogFilter {
  /** FR-5.7's whole point: `0` finds the phrasings that returned nothing. Inclusive ceiling. */
  maxResultCount?: number;
  source?: SearchSource;
  crisisGuardrailFired?: boolean;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

/** `search_queries` and `search_rate_limits` access. Both tables are M-09-owned. */
@Injectable()
export class SearchRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* search_queries                                                          */
  /* ---------------------------------------------------------------------- */

  /** `query_text` is `varchar(500)`; the DTO caps below that, and this truncates defensively so a facade caller (MCP) can never overflow the column. */
  async logQuery(entry: SearchQueryLogEntry, executor: Executor = this.db): Promise<void> {
    await executor.insert(searchQueriesTable).values({
      patientId: entry.patientId,
      source: entry.source,
      queryText: entry.queryText.slice(0, 500),
      isVoiceInput: entry.isVoiceInput,
      matchedConcernIds: entry.matchedConcernIds,
      resultCount: Math.max(0, Math.min(32_767, entry.resultCount)),
      crisisGuardrailFired: entry.crisisGuardrailFired,
    });
  }

  /**
   * FR-5.11's recent searches, for ONE patient. Two deliberate exclusions:
   *
   *   - `patient_id = :id` and never a null, so an unattributed MCP/WhatsApp
   *     query can never surface in someone's history (the reason `source`
   *     exists at all);
   *   - `crisis_guardrail_fired = false`. A patient does not need their own
   *     crisis wording offered back to them as a tappable chip the next time
   *     they open the app. Flagged as a judgement call, not a requirement.
   *
   * Over-fetches so the caller can de-duplicate by text and still fill a row
   * of chips.
   */
  async listRecentByPatient(patientId: string, limit: number, executor: Executor = this.db): Promise<SearchQueryRow[]> {
    return executor
      .select()
      .from(searchQueriesTable)
      .where(and(eq(searchQueriesTable.patientId, patientId), eq(searchQueriesTable.crisisGuardrailFired, false)))
      .orderBy(desc(searchQueriesTable.createdAt))
      .limit(limit);
  }

  /** FR-5.7's admin feedback loop — see `AdminQueryLogFilter`. Newest first. */
  async listForAdmin(filter: AdminQueryLogFilter, executor: Executor = this.db): Promise<SearchQueryRow[]> {
    const conditions = [];
    if (filter.maxResultCount !== undefined) conditions.push(lte(searchQueriesTable.resultCount, filter.maxResultCount));
    if (filter.source !== undefined) conditions.push(eq(searchQueriesTable.source, filter.source));
    if (filter.crisisGuardrailFired !== undefined) {
      conditions.push(eq(searchQueriesTable.crisisGuardrailFired, filter.crisisGuardrailFired));
    }
    if (filter.from !== undefined) conditions.push(gte(searchQueriesTable.createdAt, filter.from));
    if (filter.to !== undefined) conditions.push(lte(searchQueriesTable.createdAt, filter.to));

    const query = executor.select().from(searchQueriesTable);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

    return filtered.orderBy(desc(searchQueriesTable.createdAt), desc(searchQueriesTable.id)).limit(filter.limit).offset(filter.offset);
  }

  /**
   * ADDITIVE (M-21/data rights execution). `SearchContract.deleteSearch
   * QueriesForPatient`'s implementation — see that contract doc comment for
   * why this table (and only this table) is hard-deleted. `.returning()`
   * makes the deleted count exact from the delete itself rather than a
   * separate count-then-delete race, the same idiom as
   * `doctor-specialty.repository.ts#remove` / `carehub.repository.ts#remove
   * Recommendation`. Idempotent: an empty match returns `0`, never throws.
   */
  async deleteAllForPatient(patientId: string, executor: Executor = this.db): Promise<{ deletedCount: number }> {
    const deleted = await executor
      .delete(searchQueriesTable)
      .where(eq(searchQueriesTable.patientId, patientId))
      .returning({ id: searchQueriesTable.id });
    return { deletedCount: deleted.length };
  }

  /* ---------------------------------------------------------------------- */
  /* search_rate_limits                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Written immediately BEFORE an AI call is attempted, exactly as
   * `otp_request_attempts` is written before Slide is called — so a call
   * that fails still counts against the budget it was about to spend, and a
   * caller cannot mine free retries out of provider errors.
   */
  async recordAiAttempt(patientId: string | null, source: SearchSource, executor: Executor = this.db): Promise<void> {
    await executor.insert(searchRateLimitsTable).values({ patientId, source });
  }

  /**
   * Counts attempts in the window. An attributed caller is counted by
   * `patient_id`; an unattributed one by `source` (every MCP client
   * currently shares one bucket — see the table's own doc comment).
   */
  async countAiAttempts(patientId: string | null, source: SearchSource, since: Date, executor: Executor = this.db): Promise<number> {
    const subject = patientId === null ? isNull(searchRateLimitsTable.patientId) : eq(searchRateLimitsTable.patientId, patientId);
    const scope = patientId === null ? and(subject, eq(searchRateLimitsTable.source, source)) : subject;

    const [result] = await executor
      .select({ total: sql<string>`count(*)` })
      .from(searchRateLimitsTable)
      .where(and(scope, gte(searchRateLimitsTable.createdAt, since)));
    return Number(result?.total ?? 0);
  }

  /**
   * ADDITIVE (M-21/data rights execution). `SearchContract.countDataRights
   * RowsForPatient`'s implementation — READ ONLY, no write. Counts both
   * tables for this one patient: `search_queries` (every source, unlike
   * `listRecentByPatient`, which excludes crisis-fired rows — a deletion
   * preview must account for ALL rows, not just the ones a patient's own UI
   * would show them) and `search_rate_limits` (bare `patient_id` pointer,
   * counted here for visibility only — it is never written or deleted by
   * this module's M-21 surface, see `deleteAllForPatient`'s doc comment).
   */
  async countDataRightsRows(patientId: string, executor: Executor = this.db): Promise<{ searchQueries: number; searchRateLimits: number }> {
    const [[queries], [rateLimits]] = await Promise.all([
      executor.select({ total: sql<string>`count(*)` }).from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patientId)),
      executor.select({ total: sql<string>`count(*)` }).from(searchRateLimitsTable).where(eq(searchRateLimitsTable.patientId, patientId)),
    ]);
    return { searchQueries: Number(queries?.total ?? 0), searchRateLimits: Number(rateLimits?.total ?? 0) };
  }
}
