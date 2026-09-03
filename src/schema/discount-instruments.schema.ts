import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { adminsTable } from './admins.schema';
import { affiliatePartnersTable } from './affiliate-partners.schema';
import { patientsTable } from './patients.schema';
import { referralEventsTable } from './referral-events.schema';
import {
  discountInstrumentKindEnum,
  discountInstrumentStatusEnum,
  discountValueKindEnum,
  referralRewardRoleEnum,
} from './enums.schema';

/**
 * *** EVERY REDEEMABLE CODE, IN ONE TABLE AND ONE NAMESPACE. ***
 *
 * The product requirement is a SINGLE input box that resolves whatever the
 * patient types — a coupon, a voucher, a friend's referral code, a doctor's
 * affiliate code — to the right rules.
 *
 * ── WHY ONE TABLE AND NOT FOUR ─────────────────────────────────────────────
 *
 * The requirement is not "resolve a code", it is "resolve a code WITHOUT
 * COLLISION ACROSS KINDS". With four tables, resolution is a `UNION ALL` over
 * four `code` columns — and a UNION cannot be backed by a unique index, so
 * uniqueness would need a separate registry mapping code to (kind, id). That
 * registry IS this table, with an extra join and an extra write to keep in sync.
 * One table with `UNIQUE(code)` makes the collision guarantee a database
 * constraint instead of a service convention.
 *
 * The rules are byte-identical across kinds too — flat/percent, minimum order,
 * validity window, three caps, visibility. What actually differs is which
 * ownership column is set, which is a discriminated union, enforced by
 * `discount_instruments_kind_shape_check` below.
 *
 * *** `kind` IS A LABEL PLUS INVARIANTS, NOT A DIFFERENT CODE PATH. *** A
 * voucher is a coupon with an assigned patient. A referral code is one owned by
 * a patient. An affiliate code is one with a partner attached. Stated here so
 * nobody later "refactors" this into four services.
 *
 * ── THE CODE IS STORED ALREADY NORMALISED ──────────────────────────────────
 *
 * Upper case, `A-Z0-9` only, enforced by CHECK. That is what lets a plain
 * `UNIQUE` be case-insensitive without `citext` (an extension) or a functional
 * index. One normaliser is used by BOTH the admin writer and the patient
 * resolver, so the two cannot drift and `saveme` can never fail to match
 * `SAVEME`.
 */
export const discountInstrumentsTable = pgTable(
  'discount_instruments',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    /** THE ONE NAMESPACE. Normalised on write — see the header. */
    code: varchar('code', { length: 32 }).notNull().unique(),
    kind: discountInstrumentKindEnum('kind').notNull(),
    status: discountInstrumentStatusEnum('status').notNull().default('draft'),

    /** Patient-safe display copy. Never states a rule — rules are enforced, not advertised. */
    label: varchar('label', { length: 120 }).notNull(),
    description: varchar('description', { length: 400 }),

    /**
     * ADMIN-CONTROLLED VISIBILITY. `false` = hidden from any listing but still
     * redeemable if the patient has the code. This is the requirement that makes
     * `promotion_code_attempts`' throttle necessary rather than optional.
     */
    isPubliclyListed: boolean('is_publicly_listed').notNull().default(false),

    valueKind: discountValueKindEnum('value_kind').notNull(),
    flatAmount: numeric('flat_amount', { precision: 10, scale: 2 }),
    percentRate: numeric('percent_rate', { precision: 5, scale: 2 }),
    /**
     * REQUIRED for a percentage instrument, by CHECK. `doctors.consultation_fee_inr`
     * is admin-settable with no ceiling, so an uncapped "50% off" is an unbounded
     * liability against a number somebody can raise later.
     */
    maxDiscountAmount: numeric('max_discount_amount', { precision: 10, scale: 2 }),
    minOrderAmount: numeric('min_order_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Null = no expiry. */
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'date' }),

    /**
     * The three caps the requirement asks for. NULL = unlimited.
     *
     * *** THERE IS DELIBERATELY NO `redeemed_count` COLUMN. *** A denormalised
     * counter is a second source of truth that drifts from the redemption rows,
     * silently and unrecoverably. Instead the caps are checked by COUNTING
     * sibling `discount_redemptions` under this row's `FOR UPDATE` lock — the
     * same decision `RefundService` makes for the refund ceiling ("a unique index
     * cannot express a sum, so the total is read under the row lock").
     *
     * The cost objection dissolves on inspection: a count is only ever taken when
     * a cap EXISTS, and the cap bounds the number of matching rows. A
     * 100-redemption coupon means at most 100 index entries.
     */
    maxTotalRedemptions: integer('max_total_redemptions'),
    maxDistinctRedeemers: integer('max_distinct_redeemers'),
    maxRedemptionsPerUser: integer('max_redemptions_per_user').notNull().default(1),

    /** Set for `voucher` and `referral_reward` — the one patient who may redeem it. */
    assignedPatientId: uuid('assigned_patient_id').references(() => patientsTable.id),
    /** Set for `referral` — the patient who OWNS the code and whom rewards accrue to. */
    referrerPatientId: uuid('referrer_patient_id').references(() => patientsTable.id),
    affiliatePartnerId: uuid('affiliate_partner_id').references(() => affiliatePartnersTable.id),
    /** Set for `referral_reward` — which referral minted this, so it can be minted at most once. */
    referralEventId: uuid('referral_event_id').references((): AnyPgColumn => referralEventsTable.id),
    referralRewardRole: referralRewardRoleEnum('referral_reward_role'),

    /** NULL = system-minted. Exactly the distinction `refunds.initiated_by_admin_id` draws. */
    createdByAdminId: uuid('created_by_admin_id').references(() => adminsTable.id),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** One live referral code per patient, ever. Archived ones may coexist. */
    uniqueIndex('discount_instruments_one_referral_per_patient_idx')
      .on(table.referrerPatientId)
      .where(sql`${table.kind} = 'referral' AND ${table.status} <> 'archived'`),
    /**
     * A referral mints AT MOST ONE reward per side, however many times the mint
     * path runs. The idempotency guarantee is this index, not a flag — a replayed
     * event, a sweep pass and a manual retry can all race safely.
     */
    uniqueIndex('discount_instruments_referral_reward_once_idx')
      .on(table.referralEventId, table.referralRewardRole)
      .where(sql`${table.kind} = 'referral_reward'`),

    index().on(table.status, table.kind, table.createdAt),
    index().on(table.assignedPatientId, table.status),
    index().on(table.affiliatePartnerId),

    /** Normalised shape — what makes the plain UNIQUE case-safe. */
    check('discount_instruments_code_shape_check', sql`${table.code} ~ '^[A-Z0-9]{4,32}$'`),

    check(
      'discount_instruments_value_check',
      sql`(${table.valueKind} = 'flat' AND ${table.flatAmount} IS NOT NULL AND ${table.flatAmount} >= 0 AND ${table.percentRate} IS NULL AND ${table.maxDiscountAmount} IS NULL)
       OR (${table.valueKind} = 'percent' AND ${table.percentRate} IS NOT NULL AND ${table.percentRate} > 0 AND ${table.percentRate} <= 100 AND ${table.maxDiscountAmount} IS NOT NULL AND ${table.maxDiscountAmount} > 0 AND ${table.flatAmount} IS NULL)`,
    ),

    check(
      'discount_instruments_caps_check',
      sql`(${table.maxTotalRedemptions} IS NULL OR ${table.maxTotalRedemptions} > 0)
      AND (${table.maxDistinctRedeemers} IS NULL OR ${table.maxDistinctRedeemers} > 0)
      AND ${table.maxRedemptionsPerUser} > 0
      AND (${table.maxDistinctRedeemers} IS NULL OR ${table.maxTotalRedemptions} IS NULL OR ${table.maxDistinctRedeemers} <= ${table.maxTotalRedemptions})`,
    ),

    check(
      'discount_instruments_validity_check',
      sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`,
    ),

    /** THE DISCRIMINATOR, ENFORCED. This is what makes one table safe rather than merely convenient. */
    check(
      'discount_instruments_kind_shape_check',
      sql`CASE ${table.kind}
        WHEN 'coupon' THEN ${table.assignedPatientId} IS NULL AND ${table.referrerPatientId} IS NULL AND ${table.referralEventId} IS NULL AND ${table.affiliatePartnerId} IS NULL
        WHEN 'voucher' THEN ${table.assignedPatientId} IS NOT NULL AND ${table.referrerPatientId} IS NULL AND ${table.referralEventId} IS NULL
        WHEN 'referral' THEN ${table.referrerPatientId} IS NOT NULL AND ${table.assignedPatientId} IS NULL AND ${table.referralEventId} IS NULL AND ${table.affiliatePartnerId} IS NULL
        WHEN 'referral_reward' THEN ${table.assignedPatientId} IS NOT NULL AND ${table.referralEventId} IS NOT NULL AND ${table.referralRewardRole} IS NOT NULL AND ${table.affiliatePartnerId} IS NULL
        WHEN 'affiliate' THEN ${table.affiliatePartnerId} IS NOT NULL AND ${table.assignedPatientId} IS NULL AND ${table.referrerPatientId} IS NULL AND ${table.referralEventId} IS NULL
      END`,
    ),
  ],
);

export type DiscountInstrumentRow = typeof discountInstrumentsTable.$inferSelect;
export type NewDiscountInstrumentRow = typeof discountInstrumentsTable.$inferInsert;
