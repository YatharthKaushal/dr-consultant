import { date, index, pgTable, smallint, time, timestamp, uuid } from 'drizzle-orm/pg-core';
import { availabilityRuleTypeEnum } from './enums.schema';
import { doctorsTable } from './doctors.schema';

/**
 * A rule that no longer applies is deleted, not deactivated — there is no
 * `is_active`, and no free-text reason that no screen reads.
 *
 * Two CHECK constraints govern the shape/value of these columns, added by
 * hand in the M-07 migration `drizzle/0002_availability_and_scheduling.sql`
 * rather than expressed via drizzle-kit's `check()` builder here — the
 * condition is a three-way per-`rule_type` branch (below) that reads more
 * clearly as hand-written SQL than fighting drizzle-kit's diffing with it,
 * and it keeps this file's own generated snapshot untouched (the same
 * reason the partial-unique-index migration on `consultations` is
 * hand-written rather than schema-declared). If you change the meaning of
 * `ruleType`/`dayOfWeek`/`specificDate`/`startTime`/`endTime`, update that
 * migration's SQL to match — drizzle-kit's `generate` will not do it for
 * you, and neither would a `check()` builder call here (both are equally
 * "not expressible" as far as future diffing is concerned once hand-written).
 *
 *   - `doctor_availability_rule_shape_check` — binds `rule_type` to its
 *     required columns:
 *       - `weekly`: `day_of_week` NOT NULL, `specific_date` NULL,
 *         `start_time`/`end_time` both NOT NULL.
 *       - `custom_hours`: `specific_date` NOT NULL, `day_of_week` NULL,
 *         `start_time`/`end_time` both NOT NULL.
 *       - `blocked`: `specific_date` NOT NULL, `day_of_week` NULL,
 *         `start_time`/`end_time` either both NULL (a full-day block) or
 *         both NOT NULL (a partial-day block) — never just one.
 *   - `doctor_availability_time_order_check` — whenever both `start_time`
 *     and `end_time` are present, `end_time > start_time`.
 *
 * Overlap prevention (two rules for the same doctor/day whose time ranges
 * intersect) is NOT a DB constraint — it would need `btree_gist`, awkward
 * for this rule shape — and is enforced in `availability-rule.service.ts`
 * instead, with thorough unit tests.
 */
export const doctorAvailabilityTable = pgTable(
  'doctor_availability',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorsTable.id),
    ruleType: availabilityRuleTypeEnum('rule_type').notNull(),
    /** Required when rule_type = weekly. 0 Sunday through 6 Saturday. */
    dayOfWeek: smallint('day_of_week'),
    /** Required when rule_type = blocked or custom_hours. */
    specificDate: date('specific_date'),
    startTime: time('start_time'),
    endTime: time('end_time'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.doctorId, table.ruleType),
    index().on(table.doctorId, table.specificDate),
  ],
);

export type DoctorAvailabilityRow = typeof doctorAvailabilityTable.$inferSelect;
export type NewDoctorAvailabilityRow = typeof doctorAvailabilityTable.$inferInsert;
