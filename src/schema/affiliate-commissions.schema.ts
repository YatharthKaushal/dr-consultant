import {
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { affiliatePartnersTable } from './affiliate-partners.schema';
import { affiliateSettlementsTable } from './affiliate-settlements.schema';
import { consultationsTable } from './consultations.schema';
import { discountRedemptionsTable } from './discount-redemptions.schema';
import {
  affiliateCommissionBaseEnum,
  affiliateCommissionStatusEnum,
  discountValueKindEnum,
} from './enums.schema';
import { paymentsTable } from './payments.schema';

/**
 * *** WHAT A PARTNER IS OWED FOR ONE BOOKING. ***
 *
 * See `affiliate_partners` for the NMC regulatory warning that governs whether
 * any of this may be switched on at all.
 *
 * ── `pending` IS THE WHOLE ANTI-CLAWBACK DESIGN ────────────────────────────
 *
 * A row is created `pending` when the payment is captured, and becomes
 * `accrued` — actually owed — only once the consultation reaches a qualifying
 * status, the same gate the referral programme uses.
 *
 * Accruing at capture instead would need a "payment refunded" signal to claw
 * back, and no such event exists on `payment.contract.ts` today. Gating on the
 * qualifying status means a booking cancelled and refunded before completion
 * NEVER BECOMES PAYABLE IN THE FIRST PLACE — one sweep serves both consumers and
 * nothing has to poll another module's tables.
 *
 * ── EVERY TERM IS SNAPSHOTTED ──────────────────────────────────────────────
 *
 * The rate, the base and the ceiling are copied here at accrual. Renegotiating a
 * partner's deal next quarter must not restate what last quarter's bookings
 * earned. `base_amount` is stored too, even though it is derived, because that
 * is what makes the finance report reproducible without re-deriving a figure
 * from rows that may since have changed.
 */
export const affiliateCommissionsTable = pgTable(
  'affiliate_commissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => affiliatePartnersTable.id),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => paymentsTable.id),
    /** Null when attribution came from a LINK rather than a redeemed code. */
    redemptionId: uuid('redemption_id').references(() => discountRedemptionsTable.id),
    status: affiliateCommissionStatusEnum('status').notNull().default('pending'),
    /** `code` | `link`. A typed code beats a stored click — see the resolution table in the module docs. */
    attributionSource: varchar('attribution_source', { length: 20 }).notNull(),

    commissionValueKind: discountValueKindEnum('commission_value_kind').notNull(),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 2 }),
    commissionFlat: numeric('commission_flat', { precision: 10, scale: 2 }),
    commissionBase: affiliateCommissionBaseEnum('commission_base').notNull(),
    commissionMax: numeric('commission_max', { precision: 10, scale: 2 }),

    /** The figure the rate was applied to, under `commission_base`'s definition. */
    baseAmount: numeric('base_amount', { precision: 10, scale: 2 }).notNull(),
    commissionAmount: numeric('commission_amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    accruedAt: timestamp('accrued_at', { withTimezone: true, mode: 'date' }),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    voidReason: varchar('void_reason', { length: 120 }),
    settlementId: uuid('settlement_id').references(() => affiliateSettlementsTable.id),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * *** ONE COMMISSION PER CONSULTATION, EVER. ***
     *
     * A replayed `payment.captured` event, a sweep pass and an explicit confirm
     * can all race to create this row. The index decides and every writer uses
     * `ON CONFLICT DO NOTHING` against it — the same layered idempotency as
     * `payments.gateway_payment_id` plus `payment_events.gateway_event_id`.
     */
    uniqueIndex('affiliate_commissions_consultation_unique_idx').on(table.consultationId),

    index().on(table.partnerId, table.status, table.createdAt),
    index().on(table.status, table.createdAt),
    index().on(table.settlementId),

    check(
      'affiliate_commissions_amount_check',
      sql`${table.commissionAmount} >= 0 AND ${table.baseAmount} >= 0`,
    ),
  ],
);

export type AffiliateCommissionRow = typeof affiliateCommissionsTable.$inferSelect;
export type NewAffiliateCommissionRow = typeof affiliateCommissionsTable.$inferInsert;
