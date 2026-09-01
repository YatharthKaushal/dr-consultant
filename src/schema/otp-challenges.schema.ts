import { index, inet, pgTable, smallint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { accountTypeEnum } from './enums.schema';

/**
 * One row per OTP *challenge* through Slide (slide.synquic.in), for every
 * account type — patients, doctors and admins all sign in this way, and
 * there is no password anywhere in this platform.
 *
 * This is deliberately NOT folded into `audit_log`: a login attempt from a
 * brand-new number has no actor row to attach an audit entry to yet (an
 * unrecognised patient number is exactly the case where none exists), and
 * `audit_log.entity_id` is NOT NULL. This table owns the pre-account phase —
 * request, resend, verify, rate limit. `audit_log` (`action = login`)
 * continues to own the confirmed-login record once an actor exists; the two
 * never overlap.
 *
 * A resend (Slide's `otp.retry`) UPDATES this row in place — Slide reuses
 * the same `provider_request_id` across a retry, so `resend_count` and
 * `last_sent_at` move and everything else stays. `resend_count` plus
 * `otp.resend.max_per_challenge`/`otp.resend.cooldown_seconds` in
 * `app_config` govern how many times and how often THIS ONE challenge may
 * be resent — a per-challenge concern.
 *
 * Rate limiting the INITIAL `POST /otp/request` call (SRS 6.1) is a
 * separate, broader concern this table cannot own on its own: a
 * doctor/admin request for an unregistered number is refused before Slide
 * is ever called, so no row lands here for it, and counting only rows in
 * this table would leave that check completely unthrottled. See
 * `otp-request-attempts.schema.ts`, which records every `/otp/request`
 * call regardless of outcome and is what `otp.request.max_per_number_per_hour`
 * / `otp.request.max_per_ip_per_hour` are actually checked against.
 *
 * `attempt_count` counts wrong-code submissions against `otp.verify` for
 * THIS row; `attempt_count >= max` (checked in application code against
 * `app_config`) is the lockout condition, so there is no separate
 * `locked_at` — same reasoning `safety_alerts` uses for having no status
 * column. `verified_at` non-null is our own replay stop on this row,
 * independent of Slide's own single-use `otp.verifyToken`.
 *
 * No `code_hash`: Slide verifies the code, we never receive it to hash.
 * No `provider` column: one vendor this release, a constant is not data,
 * same reasoning `payments` gives for having no `gateway` column.
 * No FK to patients/doctors/admins: a row here can predate every one of
 * them.
 */
export const otpChallengesTable = pgTable(
  'otp_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mobileNumber: varchar('mobile_number', { length: 16 }).notNull(),
    /** Which app/role asked for this OTP — stops a patient-app OTP minting a doctor session. */
    audience: accountTypeEnum('audience').notNull(),
    /** Slide's `requestId`. One row is provably one Slide request: `otp.send` returns it, `otp.retry` reuses it. */
    providerRequestId: varchar('provider_request_id', { length: 120 }).notNull().unique(),
    /** Wrong-code submissions against `otp.verify` for this row. */
    attemptCount: smallint('attempt_count').notNull().default(0),
    /** `otp.retry` calls against this row. */
    resendCount: smallint('resend_count').notNull().default(0),
    /** `createdAt` is the first send; cooldown checks and the client's resend-button hint need the latest. */
    lastSentAt: timestamp('last_sent_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * Our own best-effort bookkeeping estimate, computed at insert time from
     * `app_config`'s `otp.challenge.ttl_seconds` (kept in step with the
     * Slide widget's configured expiry by hand — see the deployment
     * runbook). Drives the retention purge and the "can I show the resend
     * button yet" UI hint. NOT the authoritative expiry check — Slide's
     * `otp.verify` enforces the real window server-side and returns 400 on
     * expiry regardless of what this column says.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Set = this challenge has been consumed. Null = never verified (expired, abandoned, or still pending). */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    ipAddress: inet('ip_address'),
    deviceId: varchar('device_id', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.mobileNumber, table.createdAt),
    index().on(table.ipAddress, table.createdAt),
    // Read by the retention-purge job — this table carries a phone number
    // and an IP per row and must be pruned on the window in app_config's
    // retention.otp_challenges_days.
    index().on(table.createdAt),
  ],
);

export type OtpChallengeRow = typeof otpChallengesTable.$inferSelect;
export type NewOtpChallengeRow = typeof otpChallengesTable.$inferInsert;
