import { bigserial, index, inet, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * *** THE ENUMERATION THROTTLE. ***
 *
 * A "resolve this code" endpoint is a machine for discovering valid codes, and
 * "hidden but still redeemable" — an explicit product requirement — is exactly
 * the feature that makes discovering them worthwhile. Without a throttle an
 * attacker walks the namespace and harvests every unlisted campaign.
 *
 * One row per ATTEMPT, counted as
 * `count(*) WHERE subject = ? AND created_at >= now() - window` — the same shape
 * `otp_request_attempts` and `search_rate_limits` already use here. No Redis, no
 * in-process counter, and therefore correct across every instance without
 * sticky routing.
 *
 * *** THE ROW IS WRITTEN BEFORE THE COUNT, NOT AFTER. *** That ordering IS the
 * throttle: a count taken before the caller's own row exists is a count every
 * concurrent caller reads identically, so N parallel requests all pass a budget
 * of one. `otp_request_attempts` is used the same way
 * (`identity.service.ts#requestOtp` records before it acts). See
 * `promotion.service.ts#checkThrottle`.
 *
 * Throttled per patient AND per IP: per-patient alone is useless against
 * unauthenticated probing, and per-IP alone punishes a shared NAT.
 *
 * ── NO FOREIGN KEY ON `patient_id`, ON PURPOSE ─────────────────────────────
 *
 * A rate-limit row can legitimately outlive the account it counted, and an
 * attempt from an unauthenticated caller has no patient at all — `ip_address` is
 * genuinely the only subject there. An FK would make deleting a patient depend
 * on first clearing their throttle history, which inverts the priority: the
 * deletion matters, the counter does not.
 *
 * Rows are disposable. `created_at` is indexed so a retention sweep can drop old
 * ones cheaply.
 */
export const promotionCodeAttemptsTable = pgTable(
  'promotion_code_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Null for an unauthenticated attempt — see the header on why this is not an FK. */
    patientId: uuid('patient_id'),
    ipAddress: inet('ip_address'),
    /**
     * `pending` -> `resolved` | `refused`.
     *
     * Written `pending` when the attempt is OPENED (before the count that
     * decides it) and settled when the evaluation ends. All three are counted
     * identically: a throttle that only counts failures is trivially evaded, and
     * a row left `pending` by a crash mid-evaluation must still hold its budget.
     */
    outcome: varchar('outcome', { length: 20 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.patientId, table.createdAt),
    index().on(table.ipAddress, table.createdAt),
    index().on(table.createdAt),
  ],
);

export type PromotionCodeAttemptRow = typeof promotionCodeAttemptsTable.$inferSelect;
export type NewPromotionCodeAttemptRow = typeof promotionCodeAttemptsTable.$inferInsert;
