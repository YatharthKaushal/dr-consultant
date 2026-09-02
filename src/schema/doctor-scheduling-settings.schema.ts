import { pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { doctorsTable } from './doctors.schema';

/**
 * Per-doctor overrides of the platform-wide booking-window defaults that
 * live in `app_config` (`scheduling.min_notice_minutes`,
 * `scheduling.booking_horizon_days` — see `modules/availability/
 * availability.constants.ts`). NULL in any column here means "inherit the
 * platform default", not "zero" — resolved by
 * `availability-settings.service.ts`.
 *
 * A doctor with no overrides at all has NO ROW here, not a row full of
 * nulls — this table is expected to stay nearly empty. `doctorId` is both
 * the primary key and the FK, so "does this doctor have an override row"
 * is a single point lookup, not a scan.
 *
 * `slotIntervalMinutes` is accepted and stored but NOT YET wired into the
 * slot engine (`availability-slot.engine.ts`) — slot length there is driven
 * entirely by the doctor's `consultationDurationMinutes` (read via
 * `DoctorFacade.getSchedulingParameters`). This column exists for a future
 * feature (a start-time grid finer than one consultation+buffer) and is
 * deliberately inert for now; do not treat its absence from the engine as a
 * bug.
 */
export const doctorSchedulingSettingsTable = pgTable('doctor_scheduling_settings', {
  doctorId: uuid('doctor_id')
    .primaryKey()
    .references(() => doctorsTable.id),
  /** NULL = inherit `scheduling.min_notice_minutes` from `app_config`. */
  minNoticeMinutes: smallint('min_notice_minutes'),
  /** NULL = inherit `scheduling.booking_horizon_days` from `app_config`. */
  bookingHorizonDays: smallint('booking_horizon_days'),
  /** Reserved for a future feature — see class doc comment. Not read by the slot engine yet. */
  slotIntervalMinutes: smallint('slot_interval_minutes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type DoctorSchedulingSettingsRow = typeof doctorSchedulingSettingsTable.$inferSelect;
export type NewDoctorSchedulingSettingsRow = typeof doctorSchedulingSettingsTable.$inferInsert;
