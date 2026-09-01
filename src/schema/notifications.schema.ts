import { bigserial, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { consultationsTable } from './consultations.schema';
import { doctorsTable } from './doctors.schema';
import { notificationStatusEnum } from './enums.schema';
import { patientsTable } from './patients.schema';

export const notificationsTable = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    patientId: uuid('patient_id').references(() => patientsTable.id),
    doctorId: uuid('doctor_id').references(() => doctorsTable.id),
    /** Read in the panel — admins have no push token. */
    adminId: uuid('admin_id').references(() => adminsTable.id),
    /** booking_confirmed, consult_reminder, doctor_joined, prescription_ready, checkin_due, instant_request, red_flag_alert, document_rejected, doctor_approved. */
    templateCode: varchar('template_code', { length: 80 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    /** The copy AS SENT. Kept because the template may change later. MUST NOT name a diagnosis, FR-16.2. */
    body: text('body').notNull(),
    /** Deep-link payload. */
    deepLinkData: jsonb('deep_link_data').$type<unknown>(),
    consultationId: uuid('consultation_id').references(() => consultationsTable.id),
    /** Delivery only. Whether it was READ is read_at. */
    status: notificationStatusEnum('status').notNull().default('queued'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    /** Set = read. There is no read value in the status enum saying the same thing. */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    failureReason: varchar('failure_reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.patientId, table.createdAt),
    index().on(table.doctorId, table.createdAt),
    index().on(table.adminId, table.createdAt),
    index().on(table.status, table.createdAt),
  ],
);

export type NotificationRow = typeof notificationsTable.$inferSelect;
export type NewNotificationRow = typeof notificationsTable.$inferInsert;
