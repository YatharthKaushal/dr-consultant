import { boolean, index, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { refundStatusEnum } from './enums.schema';
import { paymentsTable } from './payments.schema';

/**
 * One row per refund ATTEMPT against a payment — many per payment, which is
 * the whole reason this table exists.
 *
 * `payments` originally carried refunds as inline columns (`refund_amount`,
 * `gateway_refund_id`, `refunded_at`), which made exactly one refund per
 * payment representable. That was wrong on three counts: Razorpay itself
 * permits multiple partial refunds against a single payment; `docs/SRS.md` 5.1
 * names "refunds" as a first-class entity alongside payments; and a corrective
 * second refund after an error would have been impossible without a migration
 * and a data backfill. Those columns are now `@deprecated` and unwritten; this
 * table is the source of truth.
 *
 * IDEMPOTENCY, and why `gateway_refund_id` is nullable-but-unique: the row is
 * created BEFORE the gateway call (so a crash mid-call leaves evidence rather
 * than a silent gap), then updated with the id the gateway returns. A replayed
 * `refund.processed` webhook therefore finds the id already set and no-ops —
 * the same two-layer design `payments.gateway_payment_id` uses for captures,
 * with `payment_events` durably capturing every delivery underneath both.
 *
 * There is no `amount_paise` column: `numeric(10,2)` in rupees matches
 * `payments`, and the paise conversion belongs at the gateway boundary where
 * Razorpay's integer-paise API is spoken, not in storage. Rounding happens
 * once, on the way in.
 */
export const refundsTable = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => paymentsTable.id),
    /**
     * This refund alone, NOT the running total. The sum of `processed` rows
     * for a payment is what must never exceed what was captured — enforced in
     * the service inside a `SELECT ... FOR UPDATE` on the payment, because a
     * CHECK constraint cannot see sibling rows.
     */
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    /** Shown to the patient alongside the refund status (FR-7.7). */
    reason: varchar('reason', { length: 200 }),
    status: refundStatusEnum('status').notNull().default('pending'),
    /**
     * NULL for an automatic in-policy refund — that is what distinguishes it
     * from an admin-raised one, together with `is_automatic`. Both are kept:
     * the FK answers "who", the boolean answers "was a human involved at all",
     * and a NULL FK alone could not tell an auto-refund apart from a legacy row.
     */
    initiatedByAdminId: uuid('initiated_by_admin_id').references(() => adminsTable.id),
    /** True = raised by the cancellation policy without human involvement. */
    isAutomatic: boolean('is_automatic').notNull().default(false),
    /** IDEMPOTENCY — set once the gateway accepts; a replayed webhook finds it and no-ops. */
    gatewayRefundId: varchar('gateway_refund_id', { length: 120 }).unique(),
    /** Gateway's own reason, on `status = failed`. Never shown verbatim to a patient. */
    failureReason: varchar('failure_reason', { length: 200 }),

    /**
     * *** HOW MUCH OF `amount` WAS TAX, REVERSED PROPORTIONALLY. ***
     *
     * `amount = taxable_value + cgst + sgst + igst`. The per-component
     * apportionment behind these totals is in `refund_components`.
     *
     * Summary columns rather than a join for the common read, because there are
     * exactly three heads and a credit note prints all three. Defaulted to zero
     * so this is a non-destructive add: rows written before the pricing engine
     * existed keep a positive `amount` with zero heads, which is exactly what
     * they were — a refund whose tax reversal was never reported. THE BALANCING
     * CHECK LIVES ON `refund_components`, NOT HERE, precisely because those
     * legacy rows would fail it, and back-filling a reversal that never happened
     * would be worse than leaving them at zero.
     */
    taxableValue: numeric('taxable_value', { precision: 10, scale: 2 }).notNull().default('0.00'),
    cgstAmount: numeric('cgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    sgstAmount: numeric('sgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    igstAmount: numeric('igst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),

    /**
     * s.34 CGST serial, from `pricing_document_sequences`. Allocated when the
     * refund reaches `processed` — a refund the gateway rejects must not burn a
     * number, because a gap in a statutory series is its own compliance
     * question.
     */
    creditNoteNumber: varchar('credit_note_number', { length: 40 }).unique(),
    creditNoteIssuedAt: timestamp('credit_note_issued_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Every read is "the refunds for this payment", almost always ordered.
    index().on(table.paymentId, table.createdAt),
    // The worker queue: rows recorded but not yet sent to the gateway.
    index().on(table.status, table.createdAt),
  ],
);

export type RefundRow = typeof refundsTable.$inferSelect;
export type NewRefundRow = typeof refundsTable.$inferInsert;
