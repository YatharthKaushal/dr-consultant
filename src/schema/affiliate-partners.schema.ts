import { check, index, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { adminsTable } from './admins.schema';
import { doctorsTable } from './doctors.schema';
import {
  affiliateCommissionBaseEnum,
  affiliatePartnerStatusEnum,
  discountValueKindEnum,
} from './enums.schema';

/**
 * *** A DOCTOR'S AFFILIATE ARRANGEMENT. READ THE WARNING BEFORE ENABLING IT. ***
 *
 * ── REGULATORY EXPOSURE ────────────────────────────────────────────────────
 *
 * India's NMC Registered Medical Practitioner (Professional Conduct)
 * Regulations, 2023 prohibit a registered practitioner from giving, soliciting
 * or receiving any gift, gratuity, COMMISSION or bonus in consideration of, or
 * return for, referring, recommending or procuring a patient. The NMC issued a
 * specific crackdown on referral commissions; the stated penalty is suspension,
 * up to removal from the register.
 *
 * Paying a doctor a commission when a patient they referred books a consult is,
 * on its face, the arrangement that regulation names — and the exposure lands on
 * the DOCTOR, not only the platform.
 *
 * The mechanism is therefore built but SHIPPED OFF: `promotion.affiliate_enabled`
 * defaults to `false` and every partner row defaults to `paused`. Enabling it is
 * the client's legal advisor's decision, recorded in writing, in the same way
 * `docs/SRS.md` §8 assigns the GST treatment to the client's CA. It is not a
 * developer's call, and it must not become one by default.
 *
 * ── THE COMMISSION BASE, AND WHY THE DEFAULT IS THE ONE THAT KEEPS FR-7.4 TRUE ──
 *
 * `net_platform_margin` — the convenience fee less any discount the platform
 * absorbed, excluding tax — is the only base that structurally cannot pay out
 * more than the booking earned, and the only one that never reads the doctor's
 * consultation fee. That distinction matters: FR-7.4 constrains DEDUCTION, not
 * basis, so a commission computed off platform revenue is a platform expense and
 * "consultation fee 500, platform deduction 0, doctor earning 500" stays
 * literally true.
 *
 * The other two bases exist for deals struck differently and both REQUIRE a
 * ceiling — either can exceed margin and make an affiliate booking loss-making.
 * GST is never a base: paying commission out of collected tax is not ours to do.
 */
export const affiliatePartnersTable = pgTable(
  'affiliate_partners',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    doctorId: uuid('doctor_id')
      .notNull()
      .unique()
      .references(() => doctorsTable.id),
    status: affiliatePartnerStatusEnum('status').notNull().default('paused'),

    /**
     * THE LINK half of "a doctor may have either or both". A deliberately
     * SEPARATE namespace from `discount_instruments.code`: a slug lives in a URL
     * and a code is typed into a box. A slug typed into the code box resolves to
     * nothing, which is correct — a link carries attribution, not a discount.
     */
    linkSlug: varchar('link_slug', { length: 40 }).unique(),

    commissionValueKind: discountValueKindEnum('commission_value_kind').notNull(),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 2 }),
    commissionFlat: numeric('commission_flat', { precision: 10, scale: 2 }),
    commissionBase: affiliateCommissionBaseEnum('commission_base')
      .notNull()
      .default('net_platform_margin'),
    /** Per-booking ceiling. Required for any base other than the platform's own margin. */
    commissionMax: numeric('commission_max', { precision: 10, scale: 2 }),

    /** The signed arrangement this row implements. The paper trail the regulation makes necessary. */
    agreementReference: varchar('agreement_reference', { length: 120 }),
    note: varchar('note', { length: 400 }),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => adminsTable.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.status),

    /** Exactly one of flat/percent is populated, and a percentage is a real percentage. */
    check(
      'affiliate_partners_commission_check',
      sql`(${table.commissionValueKind} = 'flat' AND ${table.commissionFlat} IS NOT NULL AND ${table.commissionFlat} >= 0 AND ${table.commissionRate} IS NULL)
       OR (${table.commissionValueKind} = 'percent' AND ${table.commissionRate} IS NOT NULL AND ${table.commissionRate} > 0 AND ${table.commissionRate} <= 100 AND ${table.commissionFlat} IS NULL)`,
    ),
    /** A base other than net margin can outrun what the booking earned. Permitted, but only with a stated ceiling. */
    check(
      'affiliate_partners_nondefault_base_needs_cap',
      sql`${table.commissionBase} = 'net_platform_margin' OR ${table.commissionMax} IS NOT NULL`,
    ),
    /** URL-safe, and long enough not to be guessable by hand. */
    check(
      'affiliate_partners_link_slug_shape',
      sql`${table.linkSlug} IS NULL OR ${table.linkSlug} ~ '^[a-z0-9-]{6,40}$'`,
    ),
  ],
);

export type AffiliatePartnerRow = typeof affiliatePartnersTable.$inferSelect;
export type NewAffiliatePartnerRow = typeof affiliatePartnersTable.$inferInsert;
