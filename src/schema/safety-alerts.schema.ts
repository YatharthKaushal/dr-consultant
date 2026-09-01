import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { checkinResponsesTable } from './checkin-responses.schema';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { safetyAlertTypeEnum } from './enums.schema';

/**
 * A red status alerts BOTH the treating doctor and admins at
 * care_coordinator or clinical_governance level. There is no status column:
 * open, acknowledged and closed are read from `acknowledged_at`/`closed_at`.
 */
export const safetyAlertsTable = pgTable(
  'safety_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    alertType: safetyAlertTypeEnum('alert_type').notNull(),
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    checkinResponseId: uuid('checkin_response_id').references(() => checkinResponsesTable.id),
    /** Why it fired, in plain words. NEVER names a diagnosis. */
    reason: varchar('reason', { length: 255 }),
    acknowledgedByAdminId: uuid('acknowledged_by_admin_id').references(() => adminsTable.id),
    acknowledgedByDoctorId: uuid('acknowledged_by_doctor_id').references(() => doctorsTable.id),
    /** NULL and closed_at NULL = open. */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
    /** Set = closed. These two timestamps ARE the status. */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    closingNote: text('closing_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.alertType, table.createdAt),
    index().on(table.consultationId),
  ],
);

export type SafetyAlertRow = typeof safetyAlertsTable.$inferSelect;
export type NewSafetyAlertRow = typeof safetyAlertsTable.$inferInsert;
