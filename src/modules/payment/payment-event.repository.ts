import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { paymentEventsTable, type PaymentEventRow } from '../../schema/payment-events.schema';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';

type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `payment_events` — the durable capture of every
 * signature-verified webhook delivery.
 *
 * `payment-events.schema.ts` states the design this repository implements, and
 * it is binding: "`payments.gateway_payment_id`/`gateway_refund_id` already
 * give idempotency for the two events that resolve a `payments` row, but
 * nothing durably captures an event that arrives before its row is resolvable,
 * or one that fails mid-processing — this table is that durable capture,
 * independent of `payments`' own state."
 *
 * And on the unique constraint: "Razorpay's `x-razorpay-event-id`. The unique
 * constraint IS the idempotency guarantee — a violating insert is the 'already
 * handled' branch, decided by the database."
 */
@Injectable()
export class PaymentEventRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * *** THE IDEMPOTENCY GATE. ***
   *
   * Inserts one verified delivery, keyed on `gateway_event_id`. Returns the
   * new row, or `null` when the event id has already been recorded.
   *
   * The duplicate branch is decided BY THE DATABASE, not by a preceding
   * SELECT. A "check then insert" would let two concurrent deliveries of the
   * same event both pass the check and both process — the exact double-charge
   * `docs/MODULES.md` M-12's done-when forbids. `onConflictDoNothing` makes
   * the race impossible rather than unlikely: Postgres serialises the two
   * inserts on the unique index and exactly one of them returns a row.
   *
   * `isUniqueConstraintViolation` is caught as well as `onConflictDoNothing`
   * being used, because the FK on `payment_id` can also fire here and the two
   * must not be confused — a 23505 is "already handled" (a no-op), anything
   * else is a real failure that must propagate.
   */
  async insertIfNew(
    values: {
      gatewayEventId: string;
      eventType: string;
      paymentId: string | null;
      gatewayOrderId: string | null;
      payload: unknown;
    },
    executor: Executor = this.db,
  ): Promise<PaymentEventRow | null> {
    try {
      const [row] = await executor
        .insert(paymentEventsTable)
        .values(values)
        .onConflictDoNothing({ target: paymentEventsTable.gatewayEventId })
        .returning();
      return row ?? null;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return null;
      throw error;
    }
  }

  async findByGatewayEventId(gatewayEventId: string, executor: Executor = this.db): Promise<PaymentEventRow | null> {
    const [row] = await executor
      .select()
      .from(paymentEventsTable)
      .where(eq(paymentEventsTable.gatewayEventId, gatewayEventId))
      .limit(1);
    return row ?? null;
  }

  /** The handler ran to completion. `processed_at` set, `processing_error` cleared. */
  async markProcessed(id: number, executor: Executor = this.db): Promise<void> {
    await executor
      .update(paymentEventsTable)
      .set({ processedAt: new Date(), processingError: null })
      .where(eq(paymentEventsTable.id, id));
  }

  /**
   * The handler threw, or deferred.
   *
   * `processed_at` is deliberately LEFT NULL — that is what puts the row in
   * `listUnprocessed`'s retry sweep. The webhook still answers 2xx to
   * Razorpay: a non-2xx would make it retry, and a retry storm on a poison
   * event helps nobody. The failure is durable here instead.
   *
   * `processing_error` is `varchar(200)`, so the message is truncated rather
   * than allowed to fail the very write that records the failure.
   */
  async markFailed(id: number, processingError: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(paymentEventsTable)
      .set({ processedAt: null, processingError: processingError.slice(0, 200) })
      .where(eq(paymentEventsTable.id, id));
  }

  /** Links an event to its payment once the row becomes resolvable — the out-of-order case `payment_id` is nullable for. */
  async attachPaymentId(id: number, paymentId: string, executor: Executor = this.db): Promise<void> {
    await executor.update(paymentEventsTable).set({ paymentId }).where(eq(paymentEventsTable.id, id));
  }

  /**
   * The retry sweep's feed: verified, durably recorded, not yet processed.
   *
   * Two kinds of row land here and both are meant to — an event whose handler
   * threw, and an event that arrived before its `payments` row was resolvable.
   * Oldest first, so an out-of-order pair is replayed in the order it was sent.
   */
  async listUnprocessed(olderThan: Date, limit: number, executor: Executor = this.db): Promise<PaymentEventRow[]> {
    return executor
      .select()
      .from(paymentEventsTable)
      .where(and(isNull(paymentEventsTable.processedAt), lte(paymentEventsTable.receivedAt, olderThan)))
      .orderBy(asc(paymentEventsTable.receivedAt))
      .limit(limit);
  }

  /** Every recorded delivery for one payment — the admin's audit view of what the gateway actually told us. */
  async listByPaymentId(paymentId: string, executor: Executor = this.db): Promise<PaymentEventRow[]> {
    return executor
      .select()
      .from(paymentEventsTable)
      .where(eq(paymentEventsTable.paymentId, paymentId))
      .orderBy(asc(paymentEventsTable.receivedAt));
  }
}
