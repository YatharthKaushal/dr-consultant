import { index, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { consultationsTable } from './consultations.schema';
import { paymentStatusEnum } from './enums.schema';

/**
 * Becomes `paid` ONLY on a webhook whose HMAC signature verifies, never on a
 * client result. No `gateway` column: Razorpay is the only one this release
 * integrates. No `payout_reference`: the admin who marks a payout paid puts
 * the reference in the `metadata` of that `audit_log` row instead.
 *
 * `consultation_id` references `consultations.id` and is UNIQUE, so the
 * relationship is 1:1. Migration 0006 corrected this direction: `docs/erd.sql`
 * declared it inverted (`consultations.id -> payments.consultation_id`) and
 * migration 0000 applied that non-deferrably, which made inserting a
 * consultation impossible and — because no forward FK existed — left orphan
 * payments entirely unguarded. See `consultations.schema.ts`.
 *
 * Webhook idempotency has two layers: `gateway_payment_id` below resolves THIS
 * row; `payment_events` durably captures every verified delivery, including
 * ones that arrive before this row is resolvable. Same design, two tables.
 *
 * REFUNDS MOVED OUT (M-12). The `refund_*` columns below are LEGACY and must
 * not be written by new code — a payment can now carry MANY refunds, which
 * inline columns cannot express (Razorpay itself permits multiple partial
 * refunds against one payment, and SRS 5.1 names "refunds" as its own entity).
 * `refunds.schema.ts` is the source of truth; these columns stay only so the
 * change is non-destructive, and a later migration drops them once nothing
 * reads them.
 */
export const paymentsTable = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id')
      .notNull()
      .unique()
      .references(() => consultationsTable.id),
    /**
     * ISO 4217. Razorpay requires a currency on every order and this column
     * did not exist — INR was implied only by the NAME of
     * `doctors.consultation_fee_inr`, which is not something code can read.
     * Defaulted rather than hardcoded at the call site so a future
     * multi-currency change is a data change, not a code change.
     */
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    /** Frozen at checkout — the doctor keeps all of it. */
    consultationFee: numeric('consultation_fee', { precision: 10, scale: 2 }).notNull(),
    /** The rate in force at checkout — app_config may have moved on since. */
    convenienceFeePct: numeric('convenience_fee_pct', { precision: 5, scale: 2 }).notNull(),
    /** Stored because rounding must not be recomputed. */
    convenienceFee: numeric('convenience_fee', { precision: 10, scale: 2 }).notNull(),
    gstPct: numeric('gst_pct', { precision: 5, scale: 2 }).notNull(),
    gstAmount: numeric('gst_amount', { precision: 10, scale: 2 }).notNull(),
    status: paymentStatusEnum('status').notNull().default('created'),
    gatewayOrderId: varchar('gateway_order_id', { length: 120 }).unique(),
    /** IDEMPOTENCY — a replayed capture webhook finds this set and no-ops. */
    gatewayPaymentId: varchar('gateway_payment_id', { length: 120 }).unique(),
    /** upi, card, netbanking, wallet. */
    paymentMethod: varchar('payment_method', { length: 40 }),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    failureReason: varchar('failure_reason', { length: 200 }),
    /** @deprecated LEGACY — superseded by the `refunds` table. Do not write. */
    refundAmount: numeric('refund_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    /** @deprecated LEGACY — superseded by `refunds.reason`. Do not write. */
    refundReason: varchar('refund_reason', { length: 200 }),
    /** @deprecated LEGACY — superseded by `refunds.initiated_by_admin_id`. Do not write. */
    refundInitiatedByAdminId: uuid('refund_initiated_by_admin_id').references(() => adminsTable.id),
    /** @deprecated LEGACY — superseded by `refunds.gateway_refund_id`, which is where per-refund idempotency now lives. Do not write. */
    gatewayRefundId: varchar('gateway_refund_id', { length: 120 }).unique(),
    /** @deprecated LEGACY — superseded by `refunds.updated_at` on the processed row. Do not write. */
    refundedAt: timestamp('refunded_at', { withTimezone: true, mode: 'date' }),
    /** NULL until the transfer is made — this IS the payout status. Payouts are manual this release. */
    payoutPaidAt: timestamp('payout_paid_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.status, table.createdAt), index().on(table.paidAt)],
);

export type PaymentRow = typeof paymentsTable.$inferSelect;
export type NewPaymentRow = typeof paymentsTable.$inferInsert;
