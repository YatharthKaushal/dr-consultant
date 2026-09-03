import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { priceQuotesTable } from './price-quotes.schema';
import { taxModeEnum, taxTreatmentEnum } from './enums.schema';

/**
 * *** ONE LINE OF THE BILL. FR-7.2's "every component separately", made real. ***
 *
 * The old model had exactly two components hard-coded as columns on `payments`
 * — a consultation fee and a convenience fee — with one GST rate applied to
 * their sum. This table replaces that with an ordered list, each line carrying
 * its OWN tax treatment.
 *
 * That is what makes the GST question answerable without a migration. Seeded
 * today as: doctor fee `exempt`, convenience fee `taxable` at 18% — the
 * orthodox reading of Notification 12/2017 entry 74, which exempts healthcare
 * services by an authorised medical practitioner while leaving a platform's own
 * service fee taxable. Configure both components as `taxable` at 18% instead
 * and the engine reproduces FR-7.3's 708 exactly.
 *
 * ── THE SNAPSHOT RULE ──────────────────────────────────────────────────────
 *
 * Every rate, treatment and derivation input is COPIED here at pricing time,
 * never looked up later. `payments.convenience_fee`'s schema comment already
 * states the principle — "stored because rounding must not be recomputed" — and
 * it applies with more force now: an admin editing the component catalogue
 * tomorrow must not restate an invoice issued today.
 *
 * ── EVERY LINE BALANCES, BY CONSTRUCTION ───────────────────────────────────
 *
 * `line_total = taxable_value + cgst + sgst + igst`, always, enforced below.
 * The engine guarantees it by making tax a RESIDUAL rather than a second
 * rounding: for an inclusive component the taxable value is backed out and the
 * tax is `gross - taxable`. Rounding both halves independently would put lines
 * one paise out — at a gross of 100.00 and 18%, the backed-out taxable is 84.75
 * and the residual tax 15.25, where `round(84.75 x 18%)` would be 15.26 and the
 * line would total 100.01.
 */
export const priceQuoteComponentsTable = pgTable(
  'price_quote_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    priceQuoteId: uuid('price_quote_id')
      .notNull()
      .references(() => priceQuotesTable.id, { onDelete: 'cascade' }),
    /** Display and apportionment order. Also the deterministic tie-break when a refund is split across lines. */
    position: smallint('position').notNull(),
    /** Stable machine key, e.g. `doctor_fee`, `convenience_fee`. */
    code: varchar('code', { length: 40 }).notNull(),
    /** What the patient reads on the bill. */
    label: varchar('label', { length: 80 }).notNull(),
    /** Service accounting code, for the invoice. Null until the client's CA supplies one. */
    hsnSac: varchar('hsn_sac', { length: 10 }),

    grossAmount: numeric('gross_amount', { precision: 10, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    /** Gross minus discount, minus any embedded tax if this line is inclusive. The GST base for this line. */
    taxableValue: numeric('taxable_value', { precision: 10, scale: 2 }).notNull(),
    taxTreatment: taxTreatmentEnum('tax_treatment').notNull(),
    taxMode: taxModeEnum('tax_mode').notNull(),
    taxRatePct: numeric('tax_rate_pct', { precision: 5, scale: 2 }).notNull().default('0.00'),
    cgstAmount: numeric('cgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    sgstAmount: numeric('sgst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    igstAmount: numeric('igst_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    lineTotal: numeric('line_total', { precision: 10, scale: 2 }).notNull(),

    /**
     * WHOSE money the discount on this line was. `platform` leaves the doctor's
     * payout at `gross_amount`; `doctor` reduces it.
     *
     * *** THIS EXISTS SO FR-7.4 CANNOT BE BROKEN SILENTLY. *** "Discount before
     * tax" says nothing about who funds it. If a coupon landed on the doctor's
     * fee and the discounted figure reached the payout, the doctor would simply
     * be paid less and "platform deduction 0" would quietly stop being true.
     * Storing gross AND discount AND the bearer makes the payout unambiguous
     * and the decision auditable rather than implicit.
     */
    discountBearer: varchar('discount_bearer', { length: 10 }),

    /** How `gross_amount` was derived: `pass_through` (given) or `percent_of` (a rate on other lines). */
    basis: varchar('basis', { length: 20 }).notNull(),
    basisPct: numeric('basis_pct', { precision: 5, scale: 2 }),
    /** Which component codes `basis_pct` was applied to. Reproduces the derivation without re-reading config. */
    basisCodes: jsonb('basis_codes').$type<string[]>(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** One line per component code per quote — the code is how a refund apportions back onto lines. */
    uniqueIndex().on(table.priceQuoteId, table.code),
    index().on(table.priceQuoteId, table.position),

    check(
      'price_quote_components_line_balances',
      sql`${table.lineTotal} = ${table.taxableValue} + ${table.cgstAmount} + ${table.sgstAmount} + ${table.igstAmount}`,
    ),
    /** An exempt line carries no tax and no rate. Cheap, and it catches a misconfigured catalogue at the write. */
    check(
      'price_quote_components_exempt_has_no_tax',
      sql`${table.taxTreatment} <> 'exempt' OR (${table.cgstAmount} = 0 AND ${table.sgstAmount} = 0 AND ${table.igstAmount} = 0 AND ${table.taxRatePct} = 0)`,
    ),
    /** A discount can zero a line but never invert it. */
    check(
      'price_quote_components_discount_within_gross',
      sql`${table.discountAmount} <= ${table.grossAmount}`,
    ),
    /**
     * An inclusive amount must actually contain a tax to back out, so an
     * exempt line cannot be inclusive — that combination asserts an embedded
     * tax that does not exist, and would silently shrink the line.
     */
    check(
      'price_quote_components_exempt_is_not_inclusive',
      sql`${table.taxTreatment} <> 'exempt' OR ${table.taxMode} = 'exclusive'`,
    ),
  ],
);

export type PriceQuoteComponentRow = typeof priceQuoteComponentsTable.$inferSelect;
export type NewPriceQuoteComponentRow = typeof priceQuoteComponentsTable.$inferInsert;
