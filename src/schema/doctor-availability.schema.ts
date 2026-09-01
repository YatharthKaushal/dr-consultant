import { date, index, pgTable, smallint, time, timestamp, uuid } from 'drizzle-orm/pg-core';
import { availabilityRuleTypeEnum } from './enums.schema';
import { doctorsTable } from './doctors.schema';

/**
 * A rule that no longer applies is deleted, not deactivated — there is no
 * `is_active`, and no free-text reason that no screen reads.
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
