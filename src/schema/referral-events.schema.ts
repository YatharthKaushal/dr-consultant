import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { consultationsTable } from './consultations.schema';
import { discountInstrumentsTable } from './discount-instruments.schema';
import { discountRedemptionsTable } from './discount-redemptions.schema';
import { patientsTable } from './patients.schema';
import { referralEventStatusEnum } from './enums.schema';

/**
 * *** ONE PATIENT REFERRED ANOTHER, AND WHETHER IT HAS EARNED ANYTHING YET. ***
 *
 * ── THE TWO-STATE DESIGN IS THE ANTI-FARMING DESIGN ────────────────────────
 *
 * A row is born `qualifying`: the referee typed a referral code, booked and
 * paid. It becomes `qualified` only once that consultation reaches a qualifying
 * status — and ONLY THEN is the referrer's reward minted.
 *
 * Minting at payment capture would be trivially farmable. Refer a burner
 * account, book, pay, take the referee's discount, then cancel inside the
 * free-cancellation window that `booking-policy.engine.ts` already auto-refunds
 * — and the referrer walks away with a reward the platform funded out of
 * nothing. Waiting for a qualifying status means the money was actually retained
 * and the consult actually happened.
 *
 * *** DEPLOYMENT TRAP. *** The natural qualifying status is `completed`, which is
 * set by M-15 (clinical records) — a module that does not exist yet. Hard-coding
 * it would mean referral rewards SILENTLY NEVER MINT in this release. The
 * qualifying set is therefore an `app_config` key with a compiled-in default,
 * widenable from the admin panel with no app release.
 *
 * ── ATTRIBUTION IS EXPLICIT, NEVER INFERRED ────────────────────────────────
 *
 * The referee typed a code. There is no cookie, no window, no device match.
 * That is a deliberate asymmetry with affiliate LINKS: a referring friend can
 * put a code in a message, and a durable inferred patient-to-patient link in a
 * mental-health app is a privacy cost with no product return
 * (`docs/SRS.md` §6.2, minimum necessary).
 */
export const referralEventsTable = pgTable(
  'referral_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The `kind = 'referral'` instrument that was redeemed. */
    referralInstrumentId: uuid('referral_instrument_id')
      .notNull()
      .references((): AnyPgColumn => discountInstrumentsTable.id),
    referrerPatientId: uuid('referrer_patient_id')
      .notNull()
      .references(() => patientsTable.id),
    refereePatientId: uuid('referee_patient_id')
      .notNull()
      .references(() => patientsTable.id),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    redemptionId: uuid('redemption_id')
      .notNull()
      .references((): AnyPgColumn => discountRedemptionsTable.id),
    status: referralEventStatusEnum('status').notNull().default('qualifying'),

    /**
     * The programme terms in force when this referral happened, copied whole.
     * A config edit must not change what an in-flight referral is worth — the
     * same reason `consultations.followup_pathway_id` is "pinned to the pathway
     * version in force when assigned". `jsonb`, because it is a copy of an
     * `app_config` policy blob rather than a fixed set of fields.
     */
    programSnapshot: jsonb('program_snapshot').$type<unknown>().notNull(),

    qualifiedAt: timestamp('qualified_at', { withTimezone: true, mode: 'date' }),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    voidReason: varchar('void_reason', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * *** A PATIENT CAN BE REFERRED ONCE, EVER. ***
     *
     * Kills repeat-referee farming in the database rather than in a service, and
     * makes circular referral (A refers B, then B refers A) impossible the moment
     * either has already been a referee.
     */
    uniqueIndex('referral_events_referee_once_idx').on(table.refereePatientId),

    index().on(table.referrerPatientId, table.status, table.createdAt),
    index().on(table.status, table.createdAt),

    /** Self-referral, structurally refused — not left to a service check. */
    check(
      'referral_events_not_self_check',
      sql`${table.referrerPatientId} <> ${table.refereePatientId}`,
    ),
  ],
);

export type ReferralEventRow = typeof referralEventsTable.$inferSelect;
export type NewReferralEventRow = typeof referralEventsTable.$inferInsert;
