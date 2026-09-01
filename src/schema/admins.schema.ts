import { index, pgTable, smallint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { accountStatusEnum } from './enums.schema';

/**
 * `care_coordinator` is one of the fixed set of roles seeded into `roles`
 * (see `roles.schema.ts`) — what an admin may do is no longer a single
 * enum value on this row, it is the union of every role in `admin_roles`
 * plus any one-off grant in `admin_permission_grants`. This table only
 * holds who the admin IS, not what they may do.
 *
 * Sign-in is by mobile OTP, same as `patients` and `doctors` — there is no
 * password and no email. An admin row is created by another admin, so
 * (unlike `patients`, whose row is only ever written after the OTP already
 * confirmed) this row can exist before its first sign-in — same situation as
 * `doctors`, hence `mobile_verified_at` rather than a boolean.
 *
 * No email column, even as an optional contact field: nothing in the SRS
 * describes an admin email screen or an email notification channel, the
 * platform has no mail transport (same reasoning `erd.sql` already applied
 * to dropping `patients.email`), and a nullable-unique email sitting beside
 * an OTP-authoritative mobile number would be a second, unintended sign-in
 * path waiting to be built by accident.
 */
export const adminsTable = pgTable(
  'admins',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: accountStatusEnum('status').notNull().default('active'),
    /** Sign-in identifier, E.164 form — admins sign in by OTP, same as patients and doctors. */
    mobileNumber: varchar('mobile_number', { length: 16 }).notNull().unique(),
    /** Null = this admin has never completed an OTP sign-in on this number. */
    mobileVerifiedAt: timestamp('mobile_verified_at', { withTimezone: true, mode: 'date' }),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    /** *** REVOCATION *** bump to invalidate every token issued for this account. */
    tokenVersion: smallint('token_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.status)],
);

export type AdminRow = typeof adminsTable.$inferSelect;
export type NewAdminRow = typeof adminsTable.$inferInsert;
