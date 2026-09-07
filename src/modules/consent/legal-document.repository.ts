import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import type { LegalAudience, LegalDocumentType } from '../../schema/enums.schema';
import { legalDocumentsTable, type LegalDocumentRow } from '../../schema/legal-documents.schema';
import { LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX } from './consent.constants';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/** `legal_documents` CRUD. A version is never edited in place — see the table's own doc comment. */
@Injectable()
export class LegalDocumentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<LegalDocumentRow | null> {
    const [row] = await executor.select().from(legalDocumentsTable).where(eq(legalDocumentsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByTypeAndVersion(
    documentType: LegalDocumentType,
    audience: LegalAudience,
    version: string,
    executor: Executor = this.db,
  ): Promise<LegalDocumentRow | null> {
    const [row] = await executor
      .select()
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.documentType, documentType),
          eq(legalDocumentsTable.audience, audience),
          eq(legalDocumentsTable.version, version),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The one published version of a `(document_type, audience)` pair, or
   * null. `limit 1` is safe because `publish` holds the advisory lock while
   * it demotes and promotes (`consent.constants.ts`), so at most one row per
   * `(document_type, audience)` carries `is_current`. Served by
   * `legal_documents_document_type_audience_is_current_index`.
   */
  async findCurrent(documentType: LegalDocumentType, audience: LegalAudience, executor: Executor = this.db): Promise<LegalDocumentRow | null> {
    const [row] = await executor
      .select()
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.documentType, documentType),
          eq(legalDocumentsTable.audience, audience),
          eq(legalDocumentsTable.isCurrent, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every published document — the app's legal section index. May carry both an `'all'` row and a per-app override row for the same type. */
  async listCurrent(executor: Executor = this.db): Promise<LegalDocumentRow[]> {
    return executor
      .select()
      .from(legalDocumentsTable)
      .where(eq(legalDocumentsTable.isCurrent, true))
      .orderBy(legalDocumentsTable.documentType, legalDocumentsTable.audience);
  }

  /** The admin history: every version, newest first, optionally narrowed to one type. */
  async list(documentType: LegalDocumentType | undefined, executor: Executor = this.db): Promise<LegalDocumentRow[]> {
    const query = executor.select().from(legalDocumentsTable);
    if (documentType) {
      return query
        .where(eq(legalDocumentsTable.documentType, documentType))
        .orderBy(legalDocumentsTable.audience, desc(legalDocumentsTable.createdAt));
    }
    return query.orderBy(legalDocumentsTable.documentType, legalDocumentsTable.audience, desc(legalDocumentsTable.createdAt));
  }

  async create(
    data: {
      documentType: LegalDocumentType;
      audience: LegalAudience;
      version: string;
      title: string;
      body: string;
      contentFormat: 'markdown' | 'plain_text';
      isCurrent?: boolean;
    },
    executor: Executor = this.db,
  ): Promise<LegalDocumentRow> {
    const [row] = await executor.insert(legalDocumentsTable).values(data).returning();
    if (!row) {
      throw new Error('legal_documents insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * *** TAKE THIS BEFORE READING OR WRITING `is_current` FOR A `(document_type,
   * audience)` PAIR. *** Held for the lifetime of the caller's transaction.
   * See `LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX` for why a row lock cannot stand
   * in, and for why `audience` is now part of the lock key.
   */
  async lockDocumentTypeGuard(documentType: LegalDocumentType, audience: LegalAudience, tx: DatabaseTransaction): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX}:${documentType}:${audience}`}))`,
    );
  }

  /**
   * Demotes every current row of this `(document_type, audience)` pair
   * except `exceptId`, returning what it demoted so the publish audit
   * records which version was superseded. Excluding the row being promoted
   * keeps re-publishing an already-current version a genuine no-op rather
   * than a demote-then-promote flap.
   */
  async clearCurrent(
    documentType: LegalDocumentType,
    audience: LegalAudience,
    exceptId: string,
    tx: DatabaseTransaction,
  ): Promise<LegalDocumentRow[]> {
    return tx
      .update(legalDocumentsTable)
      .set({ isCurrent: false })
      .where(
        and(
          eq(legalDocumentsTable.documentType, documentType),
          eq(legalDocumentsTable.audience, audience),
          eq(legalDocumentsTable.isCurrent, true),
          ne(legalDocumentsTable.id, exceptId),
        ),
      )
      .returning();
  }

  async setCurrent(id: string, tx: DatabaseTransaction): Promise<LegalDocumentRow | null> {
    const [row] = await tx
      .update(legalDocumentsTable)
      .set({ isCurrent: true })
      .where(eq(legalDocumentsTable.id, id))
      .returning();
    return row ?? null;
  }
}
