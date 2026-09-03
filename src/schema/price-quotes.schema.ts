import {
  char,
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { patientsTable } from './patients.schema';
import { placeOfSupplyKindEnum, priceQuoteStatusEnum } from './enums.schema';
import { specialtiesTable } from './specialties.schema';

/**
 * *** THE PRICE, DECIDED ONCE AND FROZEN. ***
 *
 * The backend is the only source of truth for what a patient pays. Everything
 * the checkout screen shows comes from one of these rows and its components;
 * the frontend calculates nothing.
 *
 * ── WHY THE TOTAL IS STORED HERE, WHEN `payments` DELIBERATELY HAS NO TOTAL ──
 *
 * `payment-money.util.ts` argues at length against a stored total: "a stored
 * copy could disagree with its own components". That argument holds for exactly
 * as long as `payments`' three money columns ARE the whole bill. Once a bill can
 * carry a discount, a third component, or a tax-inclusive component, those
 * columns become a LOSSY SUMMARY — and re-summing them no longer recomputes the
 * total, it computes a different number. The choice stops being
 * stored-versus-derived and becomes stored-versus-wrong.
 *
 * This row resolves it while keeping the original intent: it is IMMUTABLE by
 * construction. Nothing updates a quote's money after it is written — the only
 * permitted transitions are `status` and its timestamps — so the drift that
 * comment feared cannot occur here.
 *
 * ── WHY IT IS A SEPARATE TABLE AND NOT COLUMNS ON `payments` ────────────────
 *
 * A bill is a variable-length list of components; that is the entire point of
 * the design, and a list cannot be columns. And a quote must exist BEFORE any
 * payment row: the patient sees the price, picks a state and applies a coupon
 * before committing to a slot.
 *
 * ── PLACE OF SUPPLY IS A COMPLIANCE FIELD, NOT A CONVENIENCE ────────────────
 *
 * `place_of_supply_state_code` is NOT NULL on purpose. CBIC Circular
 * 242/36/2024 requires the recipient's STATE on the tax invoice for online
 * services supplied to unregistered recipients, irrespective of transaction
 * value, with penal exposure under s.122(3)(e) CGST Act for omitting it. A
 * nullable column is a column a bug can ship empty, and the resulting invoice
 * would be invalid.
 *
 * Razorpay cannot supply this: Standard Checkout collects no address and the
 * payment entity carries no state or postal code. It is collected by us, at
 * checkout, before the order exists — which it must be anyway, since the tax
 * determines the amount and Razorpay fixes an order's amount at creation.
 */
export const priceQuotesTable = pgTable(
  'price_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: priceQuoteStatusEnum('status').notNull().default('draft'),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),

    patientId: uuid('patient_id').references(() => patientsTable.id),
    doctorId: uuid('doctor_id').references(() => doctorsTable.id),
    specialtyId: uuid('specialty_id').references(() => specialtiesTable.id),
    /** Null until the quote is pinned — a price is quoted before a consultation exists. */
    consultationId: uuid('consultation_id').references((): AnyPgColumn => consultationsTable.id),

    /** GST state code of the RECIPIENT. Legally required on the invoice — see the header. */
    placeOfSupplyStateCode: char('place_of_supply_state_code', { length: 2 }).notNull(),
    /** Optional, and only ever a convenience for pre-selecting the state. The state code is authoritative. */
    placeOfSupplyPincode: varchar('place_of_supply_pincode', { length: 6 }),
    placeOfSupplyKind: placeOfSupplyKindEnum('place_of_supply_kind').notNull(),
    /** The org's own registered state, snapshotted — moving the registration must not restate old invoices. */
    supplierStateCode: char('supplier_state_code', { length: 2 }).notNull(),
    supplierGstin: varchar('supplier_gstin', { length: 15 }),

    /** Sum of every component before discount. */
    grossTotal: numeric('gross_total', { precision: 10, scale: 2 }).notNull(),
    discountTotal: numeric('discount_total', { precision: 10, scale: 2 }).notNull().default('0.00'),
    /** FR-7.2's "subtotal before GST" — the sum of every component's TAXABLE VALUE. */
    taxableTotal: numeric('taxable_total', { precision: 10, scale: 2 }).notNull(),
    cgstTotal: numeric('cgst_total', { precision: 10, scale: 2 }).notNull().default('0.00'),
    sgstTotal: numeric('sgst_total', { precision: 10, scale: 2 }).notNull().default('0.00'),
    igstTotal: numeric('igst_total', { precision: 10, scale: 2 }).notNull().default('0.00'),
    /** *** THE AUTHORITATIVE AMOUNT. *** What Razorpay's order was created for. */
    totalPayable: numeric('total_payable', { precision: 10, scale: 2 }).notNull(),

    /**
     * The promotion module's own id for the applied benefit. DELIBERATELY NOT A
     * FOREIGN KEY: promotions is a separate module reached through a port, and a
     * hard FK here would make pricing unable to boot without it — the exact
     * coupling the port exists to avoid. Orphan risk is nil because instruments
     * are archived, never deleted.
     */
    discountId: uuid('discount_id'),
    discountCode: varchar('discount_code', { length: 60 }),
    discountLabel: varchar('discount_label', { length: 80 }),

    /** After this, the quote cannot be pinned. Checked inside the pin's own conditional UPDATE, so no timer is needed for correctness. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.status, table.expiresAt),
    index().on(table.patientId, table.createdAt),
    index().on(table.consultationId),

    /** The row must add up. Cheap, and it catches an engine bug before an invoice carries it. */
    check(
      'price_quotes_total_balances',
      sql`${table.totalPayable} = ${table.taxableTotal} + ${table.cgstTotal} + ${table.sgstTotal} + ${table.igstTotal}`,
    ),
    /**
     * A supply is intra-state OR inter-state, never both. CGST+SGST and IGST are
     * mutually exclusive by law, and a row carrying both is a tax return nobody
     * can file.
     */
    check(
      'price_quotes_single_tax_regime',
      sql`${table.igstTotal} = 0 OR (${table.cgstTotal} = 0 AND ${table.sgstTotal} = 0)`,
    ),
    /**
     * NOT a check that `gross - discount = taxable`. That holds for an EXCLUSIVE
     * component and is false for an inclusive one, where the taxable value is
     * the backed-out figure and is strictly less. Enforced in the engine, where
     * the distinction is visible.
     */
  ],
);

export type PriceQuoteRow = typeof priceQuotesTable.$inferSelect;
export type NewPriceQuoteRow = typeof priceQuotesTable.$inferInsert;
