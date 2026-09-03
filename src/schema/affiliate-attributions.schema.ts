import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { affiliatePartnersTable } from './affiliate-partners.schema';
import { patientsTable } from './patients.schema';

/**
 * *** WHICH PARTNER SENT THIS PATIENT, AND UNTIL WHEN. ***
 *
 * The link half of a doctor's affiliate arrangement. A code is typed and
 * self-attributes; a link has to remember.
 *
 * ── NO ANONYMOUS CLICK TABLE. THIS IS DELIBERATE. ──────────────────────────
 *
 * There is no anonymous-visitor identity in this backend, and inventing one for
 * a mental-health app is a privacy cost with no owner — `docs/SRS.md` §6.2's
 * minimum-necessary principle points the other way. So nothing is stored
 * server-side for an anonymous visitor. Ever.
 *
 * Instead the landing page receives a SIGNED, SELF-EXPIRING token naming the
 * partner, holds it client-side, and the FIRST AUTHENTICATED request carrying it
 * writes one row here. From that moment the server is authoritative and the
 * token is never trusted again. The row is the attribution; the token is only
 * how it got here.
 *
 * ── LAST TOUCH WINS ────────────────────────────────────────────────────────
 *
 * One active attribution per patient, enforced by a partial unique index — the
 * same shape `doctor_specialties`' one-primary index uses. A later click
 * supersedes the earlier row in the same transaction rather than being rejected.
 *
 * First-touch would reward whoever INTRODUCED the patient; last-touch rewards
 * whoever CONVERTED them. For a doctor sending their own patient list, "who
 * sent them this time" is the honest answer.
 *
 * ── EXPIRY IS CHECKED IN THE QUERY, NOT THE INDEX ──────────────────────────
 *
 * `now()` is not IMMUTABLE and cannot appear in a partial index predicate, so
 * the index conditions on `status` and the reader additionally filters
 * `expires_at > now()`. Attempting the reverse is a migration that fails.
 */
export const affiliateAttributionsTable = pgTable(
  'affiliate_attributions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientsTable.id),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => affiliatePartnersTable.id),
    /** `link` today. Typed codes attribute through the redemption instead, so they never write here. */
    source: varchar('source', { length: 20 }).notNull(),
    /** `active` | `superseded`. Only `active` is indexed uniquely. */
    status: varchar('status', { length: 20 }).notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('affiliate_attributions_one_active_idx')
      .on(table.patientId)
      .where(sql`${table.status} = 'active'`),
    index().on(table.partnerId, table.createdAt),
  ],
);

export type AffiliateAttributionRow = typeof affiliateAttributionsTable.$inferSelect;
export type NewAffiliateAttributionRow = typeof affiliateAttributionsTable.$inferInsert;
