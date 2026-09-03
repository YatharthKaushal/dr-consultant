import { check, index, integer, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { adminsTable } from './admins.schema';
import { affiliatePartnersTable } from './affiliate-partners.schema';
import { affiliateSettlementMethodEnum } from './enums.schema';

/**
 * *** A RECORD THAT A HUMAN PAID A PARTNER. THE SYSTEM NEVER MOVES THE MONEY. ***
 *
 * Automated payouts are out of scope this release (`docs/SRS.md` §11: "payouts
 * are reported in the dashboard and paid by the client"), and
 * `payments.payout_paid_at` already establishes the shape — the system records
 * and reports, a person transfers. `method` makes that unambiguous rather than
 * implied: `off_system` is a first-class value, because a bank transfer made
 * outside the platform is the EXPECTED case, not an exception.
 *
 * ── WHY THIS TABLE HAS A `reference` COLUMN WHEN `payments` FORBIDS ONE ─────
 *
 * `payments.schema.ts` says explicitly: "No `payout_reference`: the admin who
 * marks a payout paid puts the reference in the `metadata` of that `audit_log`
 * row instead." That rule is about `payments`, where a payout is one nullable
 * timestamp bolted onto a row owned by something else, and where a bank
 * reference would be financial data smuggled into a patient-facing table.
 *
 * Here the settlement IS the record. A settlements table that cannot state its
 * own reference is not a record of anything. The reference is ALSO written to
 * the audit metadata, so nothing the `payments` rule protects is lost — the
 * audit trail is identical, and this table additionally stands on its own.
 *
 * ── HOW A BATCH IS BUILT, AND WHY IT CANNOT DOUBLE-PAY ─────────────────────
 *
 * Settling is one transaction: insert this row, then
 * `UPDATE affiliate_commissions SET settlement_id = <new>, status = 'settled'
 * WHERE partner_id = ? AND status = 'accrued' AND settlement_id IS NULL
 * RETURNING id`. That last predicate is the status guard, exactly as
 * `updateStatusIfIn`'s `WHERE status IN (...)` is elsewhere. Two admins settling
 * one partner concurrently: the second UPDATE matches zero rows, the service
 * refuses an empty settlement, and no commission is ever paid twice.
 *
 * `amount` and `commission_count` are written from the RETURNING set, never
 * from a prior read, so this row cannot disagree with the commissions it claims.
 */
export const affiliateSettlementsTable = pgTable(
  'affiliate_settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => affiliatePartnersTable.id),
    method: affiliateSettlementMethodEnum('method').notNull(),
    /** numeric(12,2), not (10,2): this is a SUM of many commissions and can exceed one bill's ceiling. */
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    commissionCount: integer('commission_count').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }),
    /** Bank/UTR reference or equivalent. Also mirrored into the audit row — see the header. */
    reference: varchar('reference', { length: 120 }),
    note: varchar('note', { length: 400 }),
    settledByAdminId: uuid('settled_by_admin_id')
      .notNull()
      .references(() => adminsTable.id),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** `recorded` | `voided`. Voiding returns its commissions to `accrued`. */
    status: varchar('status', { length: 20 }).notNull().default('recorded'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.partnerId, table.settledAt),
    /** A settlement of nothing is a mistake, not a record. */
    check(
      'affiliate_settlements_amount_check',
      sql`${table.amount} >= 0 AND ${table.commissionCount} > 0`,
    ),
  ],
);

export type AffiliateSettlementRow = typeof affiliateSettlementsTable.$inferSelect;
export type NewAffiliateSettlementRow = typeof affiliateSettlementsTable.$inferInsert;
