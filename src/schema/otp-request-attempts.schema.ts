import { bigserial, index, inet, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { accountTypeEnum } from './enums.schema';

/**
 * One row per `POST /auth/otp/request` CALL, regardless of outcome —
 * distinct from `otp_challenges`, which only ever gets a row once Slide has
 * actually been asked to send a code.
 *
 * This table exists to close a gap `otp_challenges`-based rate limiting
 * cannot: for `doctor`/`admin` audiences, a request for a mobile number
 * with no matching account is refused before Slide is ever called, so no
 * `otp_challenges` row is written for it. Without a row written somewhere,
 * that check is entirely unthrottled, and the endpoint becomes a free
 * oracle for enumerating which phone numbers belong to registered doctors
 * or admins — an unlimited number of guesses at whatever rate a script can
 * fire HTTP requests. SRS 6.1's "OTP attempts and login attempts are
 * rate-limited" covers exactly this: an account-existence check IS a login
 * attempt, not just successful sends.
 *
 * A row is written here FIRST, before the existence check and before
 * Slide is called, so `identity.service.ts`'s rate-limit gate can count
 * every attempt uniformly regardless of what happens next. No FK to
 * patients/doctors/admins — same reasoning as `otp_challenges`: a row here
 * can predate or outlive any of them.
 */
export const otpRequestAttemptsTable = pgTable(
  'otp_request_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mobileNumber: varchar('mobile_number', { length: 16 }).notNull(),
    audience: accountTypeEnum('audience').notNull(),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.mobileNumber, table.createdAt),
    index().on(table.ipAddress, table.createdAt),
    // Read by the retention-purge job — short-lived, pure rate-limit noise
    // with no dispute/audit value beyond the counting window.
    index().on(table.createdAt),
  ],
);

export type OtpRequestAttemptRow = typeof otpRequestAttemptsTable.$inferSelect;
export type NewOtpRequestAttemptRow = typeof otpRequestAttemptsTable.$inferInsert;
