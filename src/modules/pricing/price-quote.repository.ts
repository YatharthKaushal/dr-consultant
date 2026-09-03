import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  priceQuoteComponentsTable,
  type NewPriceQuoteComponentRow,
  type PriceQuoteComponentRow,
} from '../../schema/price-quote-components.schema';
import {
  priceQuotesTable,
  type NewPriceQuoteRow,
  type PriceQuoteRow,
} from '../../schema/price-quotes.schema';

/** A Drizzle db handle or an open transaction. Every method takes either, so a caller can compose a money mutation into one transaction. */
type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `price_quotes` and `price_quote_components`. No other module
 * reads or writes these tables (`backend/README.md` §2), and nothing in this
 * module writes them except through here.
 *
 * *** A QUOTE'S MONEY IS IMMUTABLE. *** `price-quotes.schema.ts` rests its whole
 * case for storing a total on that: "Nothing updates a quote's money after it is
 * written — the only permitted transitions are `status` and its timestamps — so
 * the drift that comment feared cannot occur here." There is deliberately NO
 * method below that updates an amount, and adding one would invalidate the
 * schema's argument for having a `total_payable` column at all.
 */
@Injectable()
export class PriceQuoteRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Writes a quote and its components as ONE unit.
   *
   * A quote without its components is not a lesser quote, it is a corrupt one:
   * the total would be unexplainable and a refund could not apportion. Both
   * inserts therefore share a transaction, opened here when the caller has not
   * already provided one.
   */
  async insertQuote(
    quote: NewPriceQuoteRow,
    components: readonly Omit<NewPriceQuoteComponentRow, 'priceQuoteId'>[],
    executor: Executor = this.db,
  ): Promise<{ quote: PriceQuoteRow; components: PriceQuoteComponentRow[] }> {
    const write = async (tx: Executor) => {
      const [row] = await tx.insert(priceQuotesTable).values(quote).returning();
      const componentRows = await tx
        .insert(priceQuoteComponentsTable)
        .values(components.map((component) => ({ ...component, priceQuoteId: row.id })))
        .returning();
      return { quote: row, components: componentRows };
    };

    // Already inside a caller's transaction? Join it. Otherwise open one.
    if (executor !== this.db) return write(executor);
    return this.db.transaction(write);
  }

  async findById(id: string, executor: Executor = this.db): Promise<PriceQuoteRow | null> {
    const [row] = await executor.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id)).limit(1);
    return row ?? null;
  }

  /** Components in POSITION order — display order, apportionment order, and the deterministic refund tie-break. */
  async findComponents(quoteId: string, executor: Executor = this.db): Promise<PriceQuoteComponentRow[]> {
    return executor
      .select()
      .from(priceQuoteComponentsTable)
      .where(eq(priceQuoteComponentsTable.priceQuoteId, quoteId))
      .orderBy(asc(priceQuoteComponentsTable.position));
  }

  /**
   * The authoritative totals for a set of quotes, in one query.
   *
   * *** THIS IS WHAT COLLAPSES THE FOUR RE-DERIVATIONS OF THE CAPTURED TOTAL. ***
   * `payment.mapper.ts`, `payment-webhook.service.ts`, `refund.service.ts` and
   * `payment.service.ts` all need "what was this payment actually billed", and
   * for a quoted payment the answer is exactly one column. Batched because the
   * admin transactions list reads a page of payments at a time and must not run
   * one query per row.
   */
  async findTotalsByIds(ids: readonly string[], executor: Executor = this.db): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await executor
      .select({ id: priceQuotesTable.id, totalPayable: priceQuotesTable.totalPayable })
      .from(priceQuotesTable)
      .where(inArray(priceQuotesTable.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.totalPayable]));
  }

  /**
   * *** THE PIN. ONE CONDITIONAL UPDATE, AND NOTHING ELSE. ***
   *
   * `SET status='pinned' WHERE id=$1 AND status='draft' AND expires_at > now()`.
   *
   * Expiry is checked INSIDE the statement, against the DATABASE's clock, which
   * is why *** NOBODY NEEDS A TIMER FOR CORRECTNESS ***. A quote that went stale
   * one millisecond ago cannot be pinned, whether or not any sweep has run,
   * whether or not this process's clock agrees with any other's, and whether or
   * not two callers raced. The sweep exists only to release discount
   * reservations (see `pricing-quote-sweep.service.ts`).
   *
   * Reading the row first and then updating it would be a check-then-act race:
   * two concurrent pins would both read `draft` and both proceed. The guard has
   * to be in the WHERE clause.
   *
   * Returns the pinned row, or `null` when zero rows matched — which the service
   * turns into `PRICING_QUOTE_EXPIRED`.
   */
  async pinIfDraft(
    id: string,
    values: { consultationId: string; patientId?: string | null },
    executor: Executor = this.db,
  ): Promise<PriceQuoteRow | null> {
    const [row] = await executor
      .update(priceQuotesTable)
      .set({
        status: 'pinned',
        pinnedAt: new Date(),
        consultationId: values.consultationId,
        ...(values.patientId != null ? { patientId: values.patientId } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(priceQuotesTable.id, id),
          eq(priceQuotesTable.status, 'draft'),
          // The database's `now()`, not this process's. A quote must not become
          // pinnable because one node's clock drifted.
          sql`${priceQuotesTable.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Marks a pinned quote consumed at capture. Guarded on `status = 'pinned'` so a
   * replayed capture webhook changes nothing and the caller can tell — the same
   * "did I do it, or had somebody already" signal `markPaidIfUnpaid` returns.
   */
  async markConsumedIfPinned(id: string, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(priceQuotesTable)
      .set({ status: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(priceQuotesTable.id, id), eq(priceQuotesTable.status, 'pinned')))
      .returning({ id: priceQuotesTable.id });
    return result.length;
  }

  /**
   * Takes a quote out of play without consuming it.
   *
   * Guarded so it can NEVER reverse a capture: a `consumed` quote is one a
   * payment was taken against, and an abandonment arriving late (a cancelled
   * checkout whose payment then succeeded) must not rewrite that.
   */
  async abandonIfOpen(
    id: string,
    status: 'expired' | 'superseded',
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor
      .update(priceQuotesTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(priceQuotesTable.id, id), inArray(priceQuotesTable.status, ['draft', 'pinned'])))
      .returning({ id: priceQuotesTable.id });
    return result.length;
  }

  /** The quote a payment was priced from, by consultation. Used to re-price nothing and to read everything. */
  async findLatestByConsultationId(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<PriceQuoteRow | null> {
    const [row] = await executor
      .select()
      .from(priceQuotesTable)
      .where(eq(priceQuotesTable.consultationId, consultationId))
      .orderBy(sql`${priceQuotesTable.createdAt} desc`)
      .limit(1);
    return row ?? null;
  }

  /**
   * *** THE SWEEP'S FEED. ***
   *
   * Stale DRAFTS that are still holding a discount reservation — which is the
   * only reason the sweep exists. A draft with no `consultation_id` never took a
   * reservation (the port keys on the consultation), so there is nothing to
   * release and it is left alone rather than churned through an UPDATE for no
   * reason.
   *
   * `pinned` quotes are deliberately NOT swept: a pinned quote has a live
   * gateway order behind it, and releasing its coupon while a payment may still
   * capture would let the same code be spent twice. Those are released by the
   * explicit `abandon` call on a failed or abandoned checkout.
   */
  async findStaleDraftsHoldingReservations(
    now: Date,
    limit: number,
    executor: Executor = this.db,
  ): Promise<Array<{ id: string; consultationId: string }>> {
    const rows = await executor
      .select({ id: priceQuotesTable.id, consultationId: priceQuotesTable.consultationId })
      .from(priceQuotesTable)
      .where(
        and(
          eq(priceQuotesTable.status, 'draft'),
          lt(priceQuotesTable.expiresAt, now),
          isNotNull(priceQuotesTable.consultationId),
        ),
      )
      .orderBy(asc(priceQuotesTable.expiresAt))
      .limit(limit);

    // `isNotNull` above already guarantees this; the narrowing is for the type.
    return rows.flatMap((row) => (row.consultationId === null ? [] : [{ id: row.id, consultationId: row.consultationId }]));
  }

  /** Stale drafts with no reservation to release — expired in bulk so the table does not fill with permanent `draft` rows. */
  async expireStaleDraftsWithoutReservations(now: Date, limit: number, executor: Executor = this.db): Promise<number> {
    const result = await executor
      .update(priceQuotesTable)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(priceQuotesTable.status, 'draft'),
          lt(priceQuotesTable.expiresAt, now),
          sql`${priceQuotesTable.consultationId} is null`,
          sql`${priceQuotesTable.id} in (
            select id from price_quotes
            where status = 'draft' and expires_at < ${now} and consultation_id is null
            order by expires_at asc
            limit ${limit}
          )`,
        ),
      )
      .returning({ id: priceQuotesTable.id });
    return result.length;
  }
}
