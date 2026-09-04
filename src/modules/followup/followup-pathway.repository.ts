import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import { followupPathwaysTable, type FollowupPathwayRow, type NewFollowupPathwayRow } from '../../schema/followup-pathways.schema';
import { FOLLOWUP_PATHWAY_CURRENT_LOCK_PREFIX } from './followup.constants';

type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL against `followup_pathways` (`backend/README.md`
 * §2: "repositories hold the SQL"). Admin write rules — validating the
 * question/rule shape, deciding whether a publish takes the advisory lock —
 * live in `followup-pathway.service.ts`, never here.
 *
 * The "exactly one current version per code" invariant and its advisory-lock
 * guard are the SAME pattern `legal-document.repository.ts` uses for
 * `legal_documents` — read that file's `lockDocumentTypeGuard`/`clearCurrent`
 * /`setCurrent` before changing any of the three methods below; the reasoning
 * is identical, just keyed by `code` instead of `document_type`.
 */
@Injectable()
export class FollowupPathwayRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<FollowupPathwayRow | null> {
    const [row] = await executor.select().from(followupPathwaysTable).where(eq(followupPathwaysTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByCodeAndVersion(code: string, version: number, executor: Executor = this.db): Promise<FollowupPathwayRow | null> {
    const [row] = await executor
      .select()
      .from(followupPathwaysTable)
      .where(and(eq(followupPathwaysTable.code, code), eq(followupPathwaysTable.version, version)))
      .limit(1);
    return row ?? null;
  }

  /** The row a NEW assignment pins to — the current version for this code, or `null` if none has ever been published. */
  async findCurrentByCode(code: string, executor: Executor = this.db): Promise<FollowupPathwayRow | null> {
    const [row] = await executor
      .select()
      .from(followupPathwaysTable)
      .where(and(eq(followupPathwaysTable.code, code), eq(followupPathwaysTable.isCurrent, true)))
      .limit(1);
    return row ?? null;
  }

  /** Every version of one pathway code, newest first — the admin version-history view. */
  async listByCode(code: string, executor: Executor = this.db): Promise<FollowupPathwayRow[]> {
    return executor
      .select()
      .from(followupPathwaysTable)
      .where(eq(followupPathwaysTable.code, code))
      .orderBy(desc(followupPathwaysTable.version));
  }

  /** One row per distinct code — whichever is current, or (if a code was created but never published) its highest version. Plain admin index, no pagination: there are five pathway codes by design (FR-13.1). */
  async listLatestPerCode(executor: Executor = this.db): Promise<FollowupPathwayRow[]> {
    const rows = await executor.select().from(followupPathwaysTable).orderBy(desc(followupPathwaysTable.version));
    const byCode = new Map<string, FollowupPathwayRow>();
    for (const row of rows) {
      const existing = byCode.get(row.code);
      if (!existing || (row.isCurrent && !existing.isCurrent) || (row.isCurrent === existing.isCurrent && row.version > existing.version)) {
        byCode.set(row.code, row);
      }
    }
    return [...byCode.values()];
  }

  async create(data: NewFollowupPathwayRow, executor: Executor = this.db): Promise<FollowupPathwayRow> {
    const [row] = await executor.insert(followupPathwaysTable).values(data).returning();
    if (!row) throw new Error('followup_pathways insert returned no row.');
    return row;
  }

  /**
   * Serializes every publish decision for one `code` behind a session-level
   * (transaction-scoped: `pg_advisory_xact_lock`) advisory lock, taken BEFORE
   * the read that decides who is current — otherwise two admins publishing
   * for the same code at once can both read "no current row" (or the same
   * stale current row) and both write, leaving two rows `is_current = true`.
   * `hashtext` turns the lock name into the 32-bit key `pg_advisory_xact_lock`
   * takes; the prefix keeps this namespace from colliding with any other
   * advisory lock in the codebase (`legal-document.repository.ts`'s own key
   * is `LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX`, a different string).
   */
  async lockCodeGuard(code: string, tx: DatabaseTransaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${FOLLOWUP_PATHWAY_CURRENT_LOCK_PREFIX}:${code}`}))`);
  }

  /** Demotes every OTHER current row of this code. Excludes `exceptId` so re-publishing an already-current version is a genuine no-op. */
  async clearCurrent(code: string, exceptId: string, tx: DatabaseTransaction): Promise<FollowupPathwayRow[]> {
    return tx
      .update(followupPathwaysTable)
      .set({ isCurrent: false })
      .where(and(eq(followupPathwaysTable.code, code), eq(followupPathwaysTable.isCurrent, true), ne(followupPathwaysTable.id, exceptId)))
      .returning();
  }

  async setCurrent(id: string, tx: DatabaseTransaction): Promise<FollowupPathwayRow | null> {
    const [row] = await tx.update(followupPathwaysTable).set({ isCurrent: true }).where(eq(followupPathwaysTable.id, id)).returning();
    return row ?? null;
  }
}
