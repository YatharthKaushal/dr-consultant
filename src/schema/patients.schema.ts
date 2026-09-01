import { index, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { accountStatusEnum, genderEnum } from './enums.schema';

/**
 * Patients authenticate by OTP only — no password, no email.
 *
 * The row is only ever written after the OTP is confirmed, so its existence
 * IS the verification (no `mobile_verified_at`). Age is derived from
 * `date_of_birth` and never stored. No emergency contact: FR-3.4/6.3 give
 * emergency guidance as content, not a collected contact.
 */
export const patientsTable = pgTable(
  'patients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: accountStatusEnum('status').notNull().default('pending'),
    /** Sign-in identifier, E.164 form (+919876543210). */
    mobileNumber: varchar('mobile_number', { length: 16 }).notNull().unique(),
    fullName: varchar('full_name', { length: 160 }),
    dateOfBirth: text('date_of_birth'),
    gender: genderEnum('gender').notNull().default('undisclosed'),
    preferredLanguage: varchar('preferred_language', { length: 40 }).notNull().default('en'),
    /** *** REVOCATION *** bump to invalidate every token issued for this account. */
    tokenVersion: smallint('token_version').notNull().default(0),
    pushToken: text('push_token'),
    deviceId: varchar('device_id', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.status), index().on(table.pushToken)],
);

export type PatientRow = typeof patientsTable.$inferSelect;
export type NewPatientRow = typeof patientsTable.$inferInsert;
