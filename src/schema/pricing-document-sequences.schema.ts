import { check, integer, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * *** INVOICE AND CREDIT-NOTE SERIALS. ***
 *
 * The platform issues no invoice numbers today, which is a gap rather than a
 * simplification: under s.31 CGST a tax invoice carries a consecutive serial
 * unique within a financial year, and under s.34 a refund of a supply needs a
 * credit note with its own serial referencing that invoice. Storing tax heads on
 * a refund without the serial gives the arithmetic and none of the compliance.
 *
 * ── WHY A TABLE AND NOT A POSTGRES SEQUENCE ────────────────────────────────
 *
 * A `SEQUENCE` is explicitly non-transactional: `nextval` does not roll back, so
 * an aborted transaction burns a number permanently. A gap in a statutory series
 * is itself a compliance question — "what happened to invoice 41?" is a
 * reasonable thing for an auditor to ask and an unpleasant one to have no answer
 * to. A row incremented under `SELECT ... FOR UPDATE` rolls back with its
 * transaction, so the series stays gapless.
 *
 * That serialises allocation per (series, year), which is correct and cheap:
 * the lock is held for one read and one increment, and invoices are issued at
 * payment capture, not in a loop.
 *
 * ── ALLOCATE AT SETTLEMENT, NOT AT INTENT ──────────────────────────────────
 *
 * A number is taken when a document genuinely exists — an invoice when the
 * payment is captured, a credit note when the refund reaches `processed`. A
 * refund that is merely requested, or that the gateway rejects, never burns one.
 * Idempotent on replay because the target column is UNIQUE and the write is
 * conditioned on it still being null.
 */
export const pricingDocumentSequencesTable = pgTable(
  'pricing_document_sequences',
  {
    /** `INV` for invoices, `CRN` for credit notes. */
    series: varchar('series', { length: 10 }).notNull(),
    /** Indian financial year, `2026-27`. The series restarts each year, as the rules require. */
    financialYear: varchar('financial_year', { length: 7 }).notNull(),
    /** The next number to hand out. Read and incremented under a row lock. */
    nextValue: integer('next_value').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.series, table.financialYear] }),
    check('pricing_document_sequences_next_value_positive', sql`${table.nextValue} > 0`),
  ],
);

export type PricingDocumentSequenceRow = typeof pricingDocumentSequencesTable.$inferSelect;
export type NewPricingDocumentSequenceRow = typeof pricingDocumentSequencesTable.$inferInsert;
