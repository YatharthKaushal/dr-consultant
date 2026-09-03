import { check, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { refundsTable } from './refunds.schema';

/**
 * *** HOW MUCH OF A REFUND WAS TAX, AND WHICH HEAD IT CAME BACK OUT OF. ***
 *
 * A refund used to be a bare amount. That was survivable only while every bill
 * had one flat GST figure and refunds were computed against the consultation
 * fee alone. Two things break it:
 *
 *   1. Under s.34 CGST a refund of a supply needs a CREDIT NOTE with
 *      proportional tax reversal. "We gave 618.00 back" does not say how much
 *      GST was reversed, so it cannot support a credit note or a return.
 *   2. With per-component tax treatments, the same rupee refunded against an
 *      exempt line and a taxable line reverses different amounts of tax. The
 *      apportionment has to be recorded, not re-derived — re-deriving it later
 *      against a since-edited catalogue would produce a different answer.
 *
 * ── THE APPORTIONMENT ──────────────────────────────────────────────────────
 *
 * A refund is split across the original quote's components by largest
 * remainder, weighted by each line's captured total less whatever has already
 * been refunded against it, so the shares sum to the refund EXACTLY. Within
 * each share the tax is backed out at that line's snapshotted rate and split
 * into heads the same way the original invoice was.
 *
 * The split is deterministic — ties break on ascending component position — so
 * a retried refund cannot produce a second, different credit note for one
 * event.
 *
 * ── WHY THE BALANCING CHECK IS HERE AND NOT ON `refunds` ───────────────────
 *
 * `refunds` predates this and holds rows with a positive `amount` and no head
 * breakdown. A balancing constraint on that table would fail to validate
 * against them, and back-filling a tax reversal that was never actually
 * reported would be worse than leaving those rows at zero. This table has no
 * legacy rows, so it can carry the constraint honestly.
 */
export const refundComponentsTable = pgTable(
  'refund_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refundsTable.id, { onDelete: 'cascade' }),
    /** Matches `price_quote_components.code` on the quote this payment was priced from. */
    code: varchar('code', { length: 40 }).notNull(),
    taxableValue: numeric('taxable_value', { precision: 10, scale: 2 }).notNull(),
    /** The rate that applied on the ORIGINAL invoice, not today's. */
    taxRatePct: numeric('tax_rate_pct', { precision: 5, scale: 2 }).notNull().default('0.00'),
    cgstAmount: numeric('cgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    sgstAmount: numeric('sgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    igstAmount: numeric('igst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    /** This line's share of the refund. The shares sum to `refunds.amount`. */
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.refundId, table.code),
    check(
      'refund_components_balances',
      sql`${table.amount} = ${table.taxableValue} + ${table.cgstAmount} + ${table.sgstAmount} + ${table.igstAmount}`,
    ),
  ],
);

export type RefundComponentRow = typeof refundComponentsTable.$inferSelect;
export type NewRefundComponentRow = typeof refundComponentsTable.$inferInsert;
