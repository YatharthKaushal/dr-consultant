import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { PaymentStatus } from '../../schema/enums.schema';
import { paymentsTable, type PaymentRow } from '../../schema/payments.schema';

/** A Drizzle db handle or an open transaction. Every method takes either, so a caller can compose a money mutation into one transaction. */
type Executor = Database | DatabaseTransaction;

export interface PaymentListFilter {
  status?: PaymentStatus;
  consultationId?: string;
  /** `payments.paid_at` window — the one an accountant reconciles against. */
  paidFrom?: Date;
  paidTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
  /** `true` = payout still owed, `false` = already transferred. */
  payoutPending?: boolean;
  limit: number;
  offset: number;
}

/**
 * All SQL against `payments`. No other module reads or writes this table
 * (`backend/README.md` §2), and nothing in this module writes it except
 * through here.
 *
 * *** THE `@deprecated` COLUMNS ARE NEVER WRITTEN. *** `payments.refund_amount`,
 * `refund_reason`, `refund_initiated_by_admin_id`, `gateway_refund_id` and
 * `refunded_at` are legacy inline-refund columns superseded by the `refunds`
 * table; `payments.schema.ts` marks each `@deprecated ... Do not write.` Not
 * one appears in any `values()` or `set()` below, and
 * `refund.service.ts` computes every refund total from `refunds` instead.
 */
@Injectable()
export class PaymentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(
    values: {
      consultationId: string;
      currency: string;
      consultationFee: string;
      convenienceFeePct: string;
      convenienceFee: string;
      gstPct: string;
      gstAmount: string;
    },
    executor: Executor = this.db,
  ): Promise<PaymentRow> {
    const [row] = await executor.insert(paymentsTable).values(values).returning();
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<PaymentRow | null> {
    const [row] = await executor.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByConsultationId(consultationId: string, executor: Executor = this.db): Promise<PaymentRow | null> {
    const [row] = await executor
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.consultationId, consultationId))
      .limit(1);
    return row ?? null;
  }

  async findByGatewayOrderId(orderId: string, executor: Executor = this.db): Promise<PaymentRow | null> {
    const [row] = await executor
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.gatewayOrderId, orderId))
      .limit(1);
    return row ?? null;
  }

  async findByGatewayPaymentId(gatewayPaymentId: string, executor: Executor = this.db): Promise<PaymentRow | null> {
    const [row] = await executor
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.gatewayPaymentId, gatewayPaymentId))
      .limit(1);
    return row ?? null;
  }

  /**
   * *** THE ROW LOCK THE REFUND INVARIANT DEPENDS ON. ***
   *
   * `SELECT ... FOR UPDATE` on the payment. `refunds.schema.ts`: "The sum of
   * `processed` rows for a payment is what must never exceed what was captured
   * — enforced in the service inside a `SELECT ... FOR UPDATE` on the payment,
   * because a CHECK constraint cannot see sibling rows."
   *
   * Two concurrent refunds against one payment serialise here: the second
   * blocks until the first commits, then reads a total that already includes
   * it. Without this lock both would read the same "already refunded" total,
   * both would pass the check, and the payment would be over-refunded — which
   * is exactly what `refund.invariant.integration.spec.ts` proves against a
   * real database.
   *
   * MUST be called inside a transaction. Outside one, `pg` releases the lock
   * at the end of the implicit single-statement transaction and it protects
   * nothing, so this deliberately takes a `DatabaseTransaction` rather than an
   * `Executor`.
   */
  async findByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<PaymentRow | null> {
    const [row] = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1).for('update');
    return row ?? null;
  }

  /** Attaches the gateway's order id once it has been created. */
  async setGatewayOrderId(id: string, gatewayOrderId: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(paymentsTable)
      .set({ gatewayOrderId, status: 'pending', updatedAt: new Date() })
      .where(eq(paymentsTable.id, id));
  }

  /**
   * *** THE CAPTURE. The only place `status` becomes `paid`. ***
   *
   * Guarded on `gateway_payment_id IS NULL`, so a REPLAYED capture webhook
   * updates zero rows and the caller can tell the difference — the second
   * idempotency layer `payments.schema.ts` describes ("IDEMPOTENCY — a
   * replayed capture webhook finds this set and no-ops"), underneath
   * `payment_events`' unique constraint.
   *
   * Returns the number of rows changed: 1 = this delivery captured it, 0 =
   * somebody already had.
   */
  async markPaidIfUnpaid(
    id: string,
    values: { gatewayPaymentId: string; paymentMethod: string | null; paidAt: Date },
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor
      .update(paymentsTable)
      .set({
        status: 'paid',
        gatewayPaymentId: values.gatewayPaymentId,
        paymentMethod: values.paymentMethod,
        paidAt: values.paidAt,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentsTable.id, id), isNull(paymentsTable.gatewayPaymentId)))
      .returning({ id: paymentsTable.id });
    return result.length;
  }

  /**
   * Records a failure. Guarded so it can NEVER overwrite a captured payment:
   * a `payment.failed` for one attempt must not undo a `payment.captured` from
   * a later successful one, and the two can arrive out of order.
   */
  async markFailedIfNotPaid(id: string, failureReason: string | null, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(paymentsTable)
      .set({ status: 'failed', failureReason, updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, id), isNull(paymentsTable.paidAt)))
      .returning({ id: paymentsTable.id });
    return result.length;
  }

  /**
   * Moves a captured payment to `refunded` or `partially_refunded` as refunds
   * settle. Never touches the legacy inline `refund_*` columns.
   */
  async setRefundStatus(
    id: string,
    status: Extract<PaymentStatus, 'refunded' | 'partially_refunded'>,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(paymentsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(paymentsTable.id, id));
  }

  /**
   * Marks the manual payout transferred. Guarded on `payout_paid_at IS NULL`
   * so two admins cannot both record the same transfer — the returned count is
   * how the service tells "I marked it" from "somebody already had".
   *
   * The BANK REFERENCE is not written here: `payments.schema.ts` says "No
   * `payout_reference`: the admin who marks a payout paid puts the reference
   * in the `metadata` of that `audit_log` row instead."
   */
  async markPayoutPaidIfUnpaid(id: string, paidAt: Date, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(paymentsTable)
      .set({ payoutPaidAt: paidAt, updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, id), isNull(paymentsTable.payoutPaidAt)))
      .returning({ id: paymentsTable.id });
    return result.length;
  }

  /** The admin transactions list (FR-18.4). Newest first — an admin is looking for something recent. */
  async list(filter: PaymentListFilter, executor: Executor = this.db): Promise<PaymentRow[]> {
    return executor
      .select()
      .from(paymentsTable)
      .where(this.buildWhere(filter))
      .orderBy(desc(paymentsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countMatching(filter: PaymentListFilter, executor: Executor = this.db): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(paymentsTable).where(this.buildWhere(filter));
    return row?.value ?? 0;
  }

  /**
   * The CSV export feed (FR-18.4, SRS 6.7). Ordered ASCENDING by creation so
   * an export reads as a ledger rather than as a reversed screen, and capped
   * by the caller.
   */
  async listForExport(filter: PaymentListFilter, executor: Executor = this.db): Promise<PaymentRow[]> {
    return executor
      .select()
      .from(paymentsTable)
      .where(this.buildWhere(filter))
      .orderBy(paymentsTable.createdAt)
      .limit(filter.limit);
  }

  private buildWhere(filter: PaymentListFilter): SQL | undefined {
    const conditions: SQL[] = [];

    if (filter.status !== undefined) conditions.push(eq(paymentsTable.status, filter.status));
    if (filter.consultationId !== undefined) conditions.push(eq(paymentsTable.consultationId, filter.consultationId));
    if (filter.paidFrom !== undefined) conditions.push(gte(paymentsTable.paidAt, filter.paidFrom));
    if (filter.paidTo !== undefined) conditions.push(lte(paymentsTable.paidAt, filter.paidTo));
    if (filter.createdFrom !== undefined) conditions.push(gte(paymentsTable.createdAt, filter.createdFrom));
    if (filter.createdTo !== undefined) conditions.push(lte(paymentsTable.createdAt, filter.createdTo));

    if (filter.payoutPending === true) {
      // Owed = captured but not yet transferred. `payout_paid_at IS NULL` on
      // its own would also match every unpaid and failed payment, which are
      // not owed to anyone.
      conditions.push(isNull(paymentsTable.payoutPaidAt));
      conditions.push(isNotNull(paymentsTable.paidAt));
    } else if (filter.payoutPending === false) {
      conditions.push(isNotNull(paymentsTable.payoutPaidAt));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /**
   * The reconciliation sweep's feed: payments still sitting in a non-terminal
   * state past a cutoff. A checkout the patient abandoned, or one whose
   * capture webhook never arrived, both look like this — and only the gateway
   * can say which.
   */
  async listStale(olderThan: Date, limit: number, executor: Executor = this.db): Promise<PaymentRow[]> {
    return executor
      .select()
      .from(paymentsTable)
      .where(
        and(
          isNotNull(paymentsTable.gatewayOrderId),
          isNull(paymentsTable.paidAt),
          sql`${paymentsTable.status} in ('created', 'pending')`,
          lte(paymentsTable.createdAt, olderThan),
        ),
      )
      .orderBy(paymentsTable.createdAt)
      .limit(limit);
  }
}
