import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  refundComponentsTable,
  type NewRefundComponentRow,
  type RefundComponentRow,
} from '../../schema/refund-components.schema';

type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `refund_components` — the per-line tax reversal behind a
 * credit note.
 *
 * *** THE TABLE IS OWNED HERE, NOT IN `modules/payment`, EVEN THOUGH IT HANGS
 * OFF `refunds`. *** The apportionment is a PRICING decision: it reads the
 * quote's components, its snapshotted rates and its place-of-supply kind, none
 * of which payment knows about. Payment owns the `refunds` row and the money
 * movement; pricing owns the tax arithmetic underneath it. The FK crosses that
 * seam in the direction the schema already allows, and payment reaches this
 * table only through `PricingFacade`.
 *
 * `refund_components_balances` enforces `amount = taxable + cgst + sgst + igst`
 * on every row, so a mis-apportioned refund is rejected by the database rather
 * than printed on a credit note.
 */
@Injectable()
export class RefundComponentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Writes one refund's whole apportionment. All rows or none — a half-written credit note is not a lesser one. */
  async insertMany(
    rows: readonly NewRefundComponentRow[],
    executor: Executor = this.db,
  ): Promise<RefundComponentRow[]> {
    if (rows.length === 0) return [];
    return executor.insert(refundComponentsTable).values([...rows]).returning();
  }

  async listByRefundId(refundId: string, executor: Executor = this.db): Promise<RefundComponentRow[]> {
    return executor.select().from(refundComponentsTable).where(eq(refundComponentsTable.refundId, refundId));
  }

  /**
   * *** HOW MUCH HAS ALREADY GONE BACK, PER COMPONENT CODE. ***
   *
   * The weights for the next apportionment are "this line's captured total less
   * whatever has already been refunded against it" — so a second partial refund
   * cannot take more from a line than that line still has, and "refund the rest"
   * lands exactly on zero.
   *
   * Takes the refund IDs rather than a payment id because `refunds` belongs to
   * `modules/payment`: joining to it from here would be the cross-module read
   * `backend/README.md` §2 forbids. The caller, which owns those rows, supplies
   * them.
   */
  async sumByCodeForRefunds(
    refundIds: readonly string[],
    executor: Executor = this.db,
  ): Promise<Map<string, string[]>> {
    if (refundIds.length === 0) return new Map();

    const rows = await executor
      .select({ code: refundComponentsTable.code, amount: refundComponentsTable.amount })
      .from(refundComponentsTable)
      .where(inArray(refundComponentsTable.refundId, [...refundIds]));

    const byCode = new Map<string, string[]>();
    for (const row of rows) {
      const existing = byCode.get(row.code);
      if (existing) existing.push(row.amount);
      else byCode.set(row.code, [row.amount]);
    }
    return byCode;
  }
}
