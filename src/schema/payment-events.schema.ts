import { bigserial, index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { paymentsTable } from './payments.schema';

/**
 * Every signature-verified Razorpay webhook delivery, kept durably —
 * MODULES M-12 names "gateway events" as owned data, and its done-when is
 * "a repeated webhook cannot double-charge or double-refund."
 * `payments.gateway_payment_id`/`gateway_refund_id` already give idempotency
 * for the two events that resolve a `payments` row, but nothing durably
 * captures an event that arrives before its row is resolvable, or one that
 * fails mid-processing — this table is that durable capture, independent of
 * `payments`' own state.
 *
 * Only signature-verified payloads are ever inserted; an unverified body is
 * rejected at the controller and never reaches this table.
 */
export const paymentEventsTable = pgTable(
  'payment_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Razorpay's `x-razorpay-event-id`. The unique constraint IS the idempotency guarantee — a violating insert is the "already handled" branch, decided by the database. */
    gatewayEventId: varchar('gateway_event_id', { length: 120 }).notNull().unique(),
    /** payment.captured, payment.failed, refund.processed, ... Not an enum: the gateway owns this vocabulary, same reasoning as consultation_participants.disconnect_reason. */
    eventType: varchar('event_type', { length: 60 }).notNull(),
    /** Nullable so an out-of-order or unmatched event is still durably captured rather than dropped on the floor. */
    paymentId: uuid('payment_id').references(() => paymentsTable.id),
    gatewayOrderId: varchar('gateway_order_id', { length: 120 }),
    /** Raw verified webhook body. */
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Set = the handler ran to completion. Null = still pending or it threw. */
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    processingError: varchar('processing_error', { length: 200 }),
  },
  (table) => [
    index().on(table.paymentId),
    index().on(table.eventType, table.receivedAt),
    index().on(table.processedAt),
  ],
);

export type PaymentEventRow = typeof paymentEventsTable.$inferSelect;
export type NewPaymentEventRow = typeof paymentEventsTable.$inferInsert;
