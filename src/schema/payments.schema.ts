import { index, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { paymentStatusEnum } from './enums.schema';

/**
 * Becomes `paid` ONLY on a webhook whose HMAC signature verifies, never on a
 * client result. No `gateway` column: Razorpay is the only one this release
 * integrates. No `payout_reference`: the admin who marks a payout paid puts
 * the reference in the `metadata` of that `audit_log` row instead.
 *
 * `payments.consultation_id` is the FK target for `consultations.id` (see
 * `consultations.schema.ts`) — the reverse of the usual direction, exactly as
 * `docs/erd.sql` declares it, so this file itself needs no reference to
 * `consultations`.
 *
 * Webhook idempotency has two layers: `gateway_payment_id`/`gateway_refund_id`
 * below resolve THIS row; `payment_events` durably captures every verified
 * delivery, including ones that arrive before this row is resolvable. Same
 * design, two tables.
 */
export const paymentsTable = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    consultationId: uuid('consultation_id').notNull().unique(),
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
    refundAmount: numeric('refund_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    refundReason: varchar('refund_reason', { length: 200 }),
    /** Refunds are raised from the panel only, FR-7.7. */
    refundInitiatedByAdminId: uuid('refund_initiated_by_admin_id').references(() => adminsTable.id),
    /** IDEMPOTENCY — stops a replayed refund webhook double-refunding. */
    gatewayRefundId: varchar('gateway_refund_id', { length: 120 }).unique(),
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
