import {
  boolean,
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
import { consultationsTable } from './consultations.schema';
import { discountInstrumentsTable } from './discount-instruments.schema';
import { discountRedemptionStatusEnum, discountValueKindEnum } from './enums.schema';
import { patientsTable } from './patients.schema';
import { paymentsTable } from './payments.schema';

/**
 * *** ONE USE OF ONE INSTRUMENT. THE RESERVATION IS THE LOCK. ***
 *
 * A coupon capped at 100 uses, raced by concurrent checkouts, is the
 * slot-booking problem wearing different clothes — and it gets the same
 * treatment. A row is written `reserved` when the price is pinned, flipped to
 * `consumed` when the payment is captured, and `released` when the checkout is
 * abandoned or fails. A `reserved` row COUNTS against every cap, so the coupon
 * cannot be spent twice in the window between quoting and paying.
 *
 * The parallel is exact: `consultations` in `pending_payment` with a live
 * `hold_expires_at` IS the slot hold, and the same sweep-with-a-backstop shape
 * releases both.
 *
 * ── WHY THE RULES ARE COPIED ONTO EVERY ROW ────────────────────────────────
 *
 * `value_kind`, the amounts and the base are SNAPSHOTS taken at reserve time,
 * never recomputed. `payments.convenience_fee`'s comment gives the principle —
 * "stored because rounding must not be recomputed" — and here it also means an
 * admin editing a campaign tomorrow cannot restate what a redemption was worth
 * today. The finance report is reproducible from these columns alone.
 */
export const discountRedemptionsTable = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => discountInstrumentsTable.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    /** NOT NULL: a discount with no order is a preview, and previews are not stored. */
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    /** Set at confirm, when the capture is known. */
    paymentId: uuid('payment_id').references(() => paymentsTable.id),

    status: discountRedemptionStatusEnum('status').notNull().default('reserved'),

    /* ---- The rule snapshot. See the header. ---- */
    valueKind: discountValueKindEnum('value_kind').notNull(),
    flatAmount: numeric('flat_amount', { precision: 10, scale: 2 }),
    percentRate: numeric('percent_rate', { precision: 5, scale: 2 }),
    maxDiscountAmount: numeric('max_discount_amount', { precision: 10, scale: 2 }),
    /** What the percentage was taken of, and what the minimum-order rule was tested against. */
    discountableBase: numeric('discountable_base', { precision: 10, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    /**
     * The captured bill, handed over at confirm time by the caller that already
     * holds it. Backs the affiliate commission base with NO cross-module read
     * into `payments`.
     */
    capturedConsultationFee: numeric('captured_consultation_fee', { precision: 10, scale: 2 }),
    capturedConvenienceFee: numeric('captured_convenience_fee', { precision: 10, scale: 2 }),

    /** Attribution frozen here, so a later partner edit cannot rewrite history. */
    affiliatePartnerId: uuid('affiliate_partner_id').references(() => affiliatePartnersTable.id),
    /** `code` | `link` | null. */
    attributionSource: varchar('attribution_source', { length: 20 }),

    /**
     * Denormalised from the instrument at insert time, ONLY so the partial unique
     * index below can condition on it — a partial index predicate cannot read the
     * parent row.
     *
     * Deliberately a SNAPSHOT: raising a cap from 1 to 3 later must not
     * retroactively unlock an already-reserved row, or the index would start
     * permitting what it previously refused for rows written under the old rule.
     */
    enforcesSingleUsePerUser: boolean('enforces_single_use_per_user').notNull(),

    /**
     * Reserved until this instant. Set from BOOKING's own hold expiry plus a
     * configured grace, so a discount is never released while the slot it was
     * priced for is still held.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    releaseReason: varchar('release_reason', { length: 80 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * *** ONE LIVE DISCOUNT PER CONSULTATION. NO STACKING, RACE-PROOF. ***
     *
     * The direct analogue of `consultations_doctor_slot_unique_idx`. It makes
     * "only one coupon per booking" and "re-applying is a 409, not a second row"
     * structural rather than a service check with a read-then-write window.
     *
     * A `released` row and a later `reserved` row for one consultation coexist
     * legitimately — the patient removed one coupon and applied another —
     * exactly as a cancelled and a live consultation coexist at one slot.
     */
    uniqueIndex('discount_redemptions_live_consultation_unique_idx')
      .on(table.consultationId)
      .where(sql`${table.status} IN ('reserved','consumed')`),

    /**
     * The database-level guarantee for the overwhelmingly common cap — a
     * voucher, a referral reward, a one-per-customer coupon. The counted caps are
     * lock-enforced; this one is index-enforced and survives a bug in the
     * counting logic. Second line of defence, same discipline as
     * `updateStatusIfIn`'s status guard.
     */
    uniqueIndex('discount_redemptions_single_use_per_user_idx')
      .on(table.instrumentId, table.patientId)
      .where(sql`${table.status} IN ('reserved','consumed') AND ${table.enforcesSingleUsePerUser}`),

    /** Backs the counted caps. Bounded: a count is only taken when a cap exists, and the cap bounds the rows. */
    index().on(table.instrumentId, table.status),
    index().on(table.instrumentId, table.patientId, table.status),
    /** The sweep's candidate query. */
    index().on(table.status, table.expiresAt),
    index().on(table.patientId, table.createdAt),

    /** A discount can zero an order but never invert it, and never exceed the base it was quoted against. */
    check(
      'discount_redemptions_amount_check',
      sql`${table.discountAmount} >= 0 AND ${table.discountAmount} <= ${table.discountableBase}`,
    ),
  ],
);

export type DiscountRedemptionRow = typeof discountRedemptionsTable.$inferSelect;
export type NewDiscountRedemptionRow = typeof discountRedemptionsTable.$inferInsert;
