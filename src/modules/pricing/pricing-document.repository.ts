import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { pricingDocumentSequencesTable } from '../../schema/pricing-document-sequences.schema';
import { PRICING_DOCUMENT_SERIAL_PAD, type PricingDocumentSeries } from './pricing.constants';

type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `pricing_document_sequences` — the s.31 invoice and s.34
 * credit-note serials.
 *
 * *** WHY THIS IS A TABLE AND NOT A POSTGRES SEQUENCE. ***
 * `pricing-document-sequences.schema.ts` gives the argument in full: a
 * `SEQUENCE` is explicitly non-transactional, so `nextval` does not roll back
 * and an aborted transaction burns a number permanently. "A gap in a statutory
 * series is itself a compliance question — 'what happened to invoice 41?' is a
 * reasonable thing for an auditor to ask and an unpleasant one to have no answer
 * to." A row incremented under a lock rolls back with its transaction.
 */
@Injectable()
export class PricingDocumentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Takes the next number in a series, under a row lock.
   *
   * *** MUST RUN INSIDE A TRANSACTION, and the caller's write of the returned
   * number should be in the SAME transaction wherever the boundary allows it. ***
   * Outside one, `pg` releases the lock at the end of the implicit
   * single-statement transaction and the increment is no longer atomic with
   * whatever the caller does with the result — which is exactly how two invoices
   * end up with one number.
   *
   * The `INSERT ... ON CONFLICT DO NOTHING` first is what makes the first
   * document of a financial year work without a seed: the row is created if
   * absent, then locked and read like any other. Two callers racing on that
   * first document both attempt the insert, one wins, and both then serialise on
   * the same lock.
   */
  async allocate(
    series: PricingDocumentSeries,
    financialYear: string,
    tx: DatabaseTransaction,
  ): Promise<string> {
    await tx
      .insert(pricingDocumentSequencesTable)
      .values({ series, financialYear, nextValue: 1 })
      .onConflictDoNothing({
        target: [pricingDocumentSequencesTable.series, pricingDocumentSequencesTable.financialYear],
      });

    // *** THE LOCK. *** Everything below is serialised per (series, year).
    const [row] = await tx
      .select({ nextValue: pricingDocumentSequencesTable.nextValue })
      .from(pricingDocumentSequencesTable)
      .where(
        and(
          eq(pricingDocumentSequencesTable.series, series),
          eq(pricingDocumentSequencesTable.financialYear, financialYear),
        ),
      )
      .limit(1)
      .for('update');

    if (!row) {
      // Unreachable: the upsert above guarantees the row. Refusing loudly beats
      // inventing a number for a statutory series.
      throw new Error(`Document sequence ${series}/${financialYear} could not be created or locked.`);
    }

    await tx
      .update(pricingDocumentSequencesTable)
      .set({ nextValue: row.nextValue + 1, updatedAt: new Date() })
      .where(
        and(
          eq(pricingDocumentSequencesTable.series, series),
          eq(pricingDocumentSequencesTable.financialYear, financialYear),
        ),
      );

    return formatDocumentNumber(series, financialYear, row.nextValue);
  }

  /** Current position of a series, for the admin screen. Read without a lock — it is a display figure, not an allocation. */
  async peek(series: PricingDocumentSeries, financialYear: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ nextValue: pricingDocumentSequencesTable.nextValue })
      .from(pricingDocumentSequencesTable)
      .where(
        and(
          eq(pricingDocumentSequencesTable.series, series),
          eq(pricingDocumentSequencesTable.financialYear, financialYear),
        ),
      )
      .limit(1);
    return row?.nextValue ?? 1;
  }

  /** Runs `work` in a transaction, so a caller with no transaction of its own can still allocate under the lock. */
  async withTransaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** Escape hatch for the raw handle, used only by the sequence's own `sql` probes in tests. */
  get handle(): Database {
    return this.db;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * `INV/2026-27/000041`.
 *
 * Zero-padded so the series sorts lexically as well as numerically — an export
 * ordered by string is a thing finance teams do, and `INV/2026-27/10` sorting
 * before `INV/2026-27/9` is the kind of thing nobody notices until a
 * reconciliation is off.
 */
export function formatDocumentNumber(series: string, financialYear: string, value: number): string {
  return `${series}/${financialYear}/${String(value).padStart(PRICING_DOCUMENT_SERIAL_PAD, '0')}`;
}

/**
 * The Indian financial year containing `at`, as `2026-27`.
 *
 * Runs 1 April to 31 March, which is what s.31 means by "unique within a
 * financial year" — the series restarts each April, not each January.
 *
 * Computed from the UTC parts deliberately: `price_quotes` and `payments` store
 * `timestamptz`, so the instant is unambiguous, and deriving the year from the
 * SERVER'S local timezone would silently move every invoice issued in the last
 * five and a half hours of 31 March into the wrong year the day the process
 * moves region. A note for the CA review: if the client's books are kept in IST,
 * this boundary should be evaluated in IST rather than UTC — a one-line change,
 * but a decision to make explicitly rather than inherit.
 */
export function financialYearFor(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth(); // 0 = January
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Exported for the sweep and tests: a raw SQL probe of a sequence's current value. */
export const currentSequenceValueSql = (series: string, financialYear: string) =>
  sql`select next_value from pricing_document_sequences where series = ${series} and financial_year = ${financialYear}`;
