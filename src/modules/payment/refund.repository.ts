import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, ne, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { RefundStatus } from '../../schema/enums.schema';
import { refundsTable, type RefundRow } from '../../schema/refunds.schema';

type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `refunds` — the table that replaced `payments`' inline
 * `refund_*` columns so that one payment can carry MANY refunds
 * (`refunds.schema.ts`).
 *
 * The ordering this repository is built around, from that schema comment:
 * "the row is created BEFORE the gateway call (so a crash mid-call leaves
 * evidence rather than a silent gap), then updated with the id the gateway
 * returns." `create` therefore writes a `pending` row with a NULL
 * `gateway_refund_id`, and `attachGatewayRefundId` fills it in afterwards.
 */
@Injectable()
export class RefundRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The row that exists BEFORE the gateway is called. `status` defaults to `pending`, `gateway_refund_id` stays NULL until the gateway answers. */
  async create(
    values: {
      paymentId: string;
      amount: string;
      reason: string | null;
      initiatedByAdminId: string | null;
      isAutomatic: boolean;
    },
    executor: Executor = this.db,
  ): Promise<RefundRow> {
    const [row] = await executor.insert(refundsTable).values(values).returning();
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<RefundRow | null> {
    const [row] = await executor.select().from(refundsTable).where(eq(refundsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByGatewayRefundId(gatewayRefundId: string, executor: Executor = this.db): Promise<RefundRow | null> {
    const [row] = await executor
      .select()
      .from(refundsTable)
      .where(eq(refundsTable.gatewayRefundId, gatewayRefundId))
      .limit(1);
    return row ?? null;
  }

  async listByPaymentId(paymentId: string, executor: Executor = this.db): Promise<RefundRow[]> {
    return executor
      .select()
      .from(refundsTable)
      .where(eq(refundsTable.paymentId, paymentId))
      .orderBy(refundsTable.createdAt);
  }

  /**
   * *** THE INVARIANT'S INPUT. ***
   *
   * The amounts that count against what was captured. Deliberately NOT just
   * `processed`: a `pending` row (recorded, not yet sent) and a `processing`
   * row (the gateway accepted it, settlement pending) are both money already
   * committed. Counting only `processed` would let a second refund be approved
   * while a first was still in flight, and the two together could exceed the
   * capture — the exact double-refund this module exists to prevent.
   *
   * `failed` rows are excluded, because that money never left.
   *
   * MUST be read inside the same transaction that holds the payment's
   * `FOR UPDATE` lock, or the total can go stale between read and write.
   */
  async listCommittedAmounts(paymentId: string, executor: Executor = this.db): Promise<string[]> {
    const rows = await executor
      .select({ amount: refundsTable.amount })
      .from(refundsTable)
      .where(
        and(
          eq(refundsTable.paymentId, paymentId),
          inArray(refundsTable.status, ['pending', 'processing', 'processed']),
        ),
      );
    return rows.map((row) => row.amount);
  }

  /** Only the amounts that have actually settled — what decides `refunded` vs `partially_refunded` on the payment. */
  async listProcessedAmounts(paymentId: string, executor: Executor = this.db): Promise<string[]> {
    const rows = await executor
      .select({ amount: refundsTable.amount })
      .from(refundsTable)
      .where(and(eq(refundsTable.paymentId, paymentId), eq(refundsTable.status, 'processed')));
    return rows.map((row) => row.amount);
  }

  /**
   * Attaches the gateway's refund id and moves the row to `processing`.
   *
   * Guarded on `gateway_refund_id IS NULL` so it can only ever be set once —
   * the column is nullable-but-UNIQUE precisely so "a replayed
   * `refund.processed` webhook finds the id already set and no-ops"
   * (`refunds.schema.ts`).
   */
  async attachGatewayRefundId(
    id: string,
    gatewayRefundId: string,
    status: Extract<RefundStatus, 'processing' | 'processed'>,
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor
      .update(refundsTable)
      .set({ gatewayRefundId, status, updatedAt: new Date() })
      // The `IS NULL` guard is what makes this write-once. Without it a
      // retried gateway call could overwrite one refund's id with another's,
      // and the UNIQUE constraint would then reject a legitimate later refund
      // instead of the duplicate.
      .where(and(eq(refundsTable.id, id), isNull(refundsTable.gatewayRefundId)))
      .returning({ id: refundsTable.id });
    return result.length;
  }

  /**
   * Settles a refund. Guarded on the row not already being `processed`, so a
   * replayed `refund.processed` webhook changes nothing and the caller can
   * tell — the same "did I do it, or had somebody already" signal
   * `markPaidIfUnpaid` returns.
   */
  async markProcessedIfNot(id: string, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(refundsTable)
      .set({ status: 'processed', failureReason: null, updatedAt: new Date() })
      .where(and(eq(refundsTable.id, id), ne(refundsTable.status, 'processed')))
      .returning({ id: refundsTable.id });
    return result.length;
  }

  /**
   * Marks a refund failed. Guarded so it can never reverse a settled one — a
   * `refund.failed` for an earlier attempt must not undo a `refund.processed`,
   * and the two can arrive out of order.
   *
   * `failure_reason` holds the gateway's own words and is never shown verbatim
   * to a patient (`refunds.schema.ts`).
   */
  async markFailedIfNotProcessed(id: string, failureReason: string | null, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(refundsTable)
      .set({ status: 'failed', failureReason, updatedAt: new Date() })
      .where(and(eq(refundsTable.id, id), ne(refundsTable.status, 'processed')))
      .returning({ id: refundsTable.id });
    return result.length;
  }

  /**
   * *** RECORDS A FAILURE WITHOUT RELEASING THE RESERVATION. ***
   *
   * For the case where the gateway's outcome is UNKNOWN — a timeout, a reset
   * socket, a 5xx — and the refund may well be settling at Razorpay right now.
   *
   * `markFailedIfNotProcessed` would set `status = 'failed'`, and `failed` is
   * excluded from `listCommittedAmounts`, so the amount would go straight back
   * into the refundable balance and a second refund could be raised for money
   * that has already left. This writes the reason and NOTHING else: the row
   * stays `pending`, keeps counting against the invariant, and shows up in the
   * `status, created_at` index that `refunds.schema.ts` calls "the worker
   * queue: rows recorded but not yet sent to the gateway" — which is precisely
   * the queue a human or a reconciliation sweep should be working.
   *
   * Guarded on `status = 'pending'` so it cannot overwrite a row that a webhook
   * has meanwhile settled or failed.
   */
  async recordFailureReasonKeepingPending(
    id: string,
    failureReason: string | null,
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor
      .update(refundsTable)
      .set({ failureReason, updatedAt: new Date() })
      .where(and(eq(refundsTable.id, id), eq(refundsTable.status, 'pending')))
      .returning({ id: refundsTable.id });
    return result.length;
  }

  /**
   * Writes the tax reversal totals onto the refund.
   *
   * `amount = taxable_value + cgst + sgst + igst` for a refund the pricing engine
   * apportioned. The per-component detail is in `refund_components`, which
   * carries the balancing CHECK — `refunds` deliberately does not, because rows
   * written before the engine existed have a positive `amount` and zero heads,
   * and "back-filling a tax reversal that was never actually reported would be
   * worse than leaving those rows at zero" (`refunds.schema.ts`).
   */
  async setTaxBreakdown(
    id: string,
    values: { taxableValue: string; cgstAmount: string; sgstAmount: string; igstAmount: string },
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(refundsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(refundsTable.id, id));
  }

  /**
   * Attaches the s.34 credit-note serial once a refund has actually settled.
   *
   * Guarded on `credit_note_number IS NULL` so it can only ever be set once — a
   * replayed `refund.processed` webhook finds it present and no-ops, the same
   * write-once discipline `attachGatewayRefundId` uses. A refund the gateway
   * rejects never reaches this method at all, so it never burns a number.
   */
  async attachCreditNoteIfAbsent(
    id: string,
    creditNoteNumber: string,
    issuedAt: Date,
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor
      .update(refundsTable)
      .set({ creditNoteNumber, creditNoteIssuedAt: issuedAt, updatedAt: new Date() })
      .where(and(eq(refundsTable.id, id), isNull(refundsTable.creditNoteNumber)))
      .returning({ id: refundsTable.id });
    return result.length;
  }

  /** The admin refunds list and the CSV export feed. */
  async list(
    filter: { paymentId?: string; status?: RefundStatus; createdFrom?: Date; createdTo?: Date; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<RefundRow[]> {
    const conditions: SQL[] = [];
    if (filter.paymentId !== undefined) conditions.push(eq(refundsTable.paymentId, filter.paymentId));
    if (filter.status !== undefined) conditions.push(eq(refundsTable.status, filter.status));
    if (filter.createdFrom !== undefined) conditions.push(gte(refundsTable.createdAt, filter.createdFrom));
    if (filter.createdTo !== undefined) conditions.push(lte(refundsTable.createdAt, filter.createdTo));

    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    return executor
      .select()
      .from(refundsTable)
      .where(where)
      .orderBy(desc(refundsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /** Refunds for a set of payments in one query — the export path, which must not run one query per row. */
  async listByPaymentIds(paymentIds: readonly string[], executor: Executor = this.db): Promise<RefundRow[]> {
    if (paymentIds.length === 0) return [];
    return executor
      .select()
      .from(refundsTable)
      .where(inArray(refundsTable.paymentId, [...paymentIds]))
      .orderBy(refundsTable.createdAt);
  }
}
