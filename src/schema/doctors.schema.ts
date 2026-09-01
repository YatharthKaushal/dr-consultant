import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
// Forward reference for `blocked_by_consultation_id` — genuinely circular
// with consultations.schema.ts (which references doctors.id). Resolved via
// the lazy `(): AnyPgColumn =>` callback form; safe with the ESM circular
// import because the callback only runs after both modules finish loading.
import { consultationsTable } from './consultations.schema';
import { doctorPresenceEnum, doctorSeniorityEnum, doctorVerificationStatusEnum } from './enums.schema';

/**
 * No reliability counters and no `active_consultation_id` — both are counted
 * from `consultations` and `instant_consultancy` when needed. Only the
 * completion gate is cached, because it is checked on every instant routing
 * decision. No `verification_note` — a rejection is per-document
 * (`doctor_documents.rejection_reason`); the admin note on the doctor
 * decision itself lives in the `audit_log` row where `action = verify`.
 *
 * No `specialty_id` here — a doctor can practise under more than one
 * specialty (FR-4.3), so specialties live in `doctor_specialties`, a real
 * many-to-many, not a singular FK.
 */
export const doctorsTable = pgTable(
  'doctors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Sign-in identifier, E.164 form — doctors sign in by OTP, FR-1.2. */
    mobileNumber: varchar('mobile_number', { length: 16 }).notNull().unique(),
    /** Null = the doctor has never completed an OTP sign-in on this number. */
    mobileVerifiedAt: timestamp('mobile_verified_at', { withTimezone: true, mode: 'date' }),
    /** *** REVOCATION *** bump to invalidate every token issued for this account. */
    tokenVersion: smallint('token_version').notNull().default(0),
    pushToken: text('push_token'),
    deviceId: varchar('device_id', { length: 120 }),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    bio: text('bio'),
    /** Filtered on, FR-4.4. */
    languages: jsonb('languages').$type<string[]>().notNull().default([]),
    verificationStatus: doctorVerificationStatusEnum('verification_status').notNull().default('pending'),
    /** Medical council registration, shown in listings by FR-4.2. */
    registrationNumber: varchar('registration_number', { length: 80 }).unique(),
    qualification: varchar('qualification', { length: 255 }),
    yearsOfExperience: smallint('years_of_experience'),
    /** Admin who approved the DOCTOR; each document is signed off separately. */
    verifiedByAdminId: uuid('verified_by_admin_id').references(() => adminsTable.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    /** Admin-granted. `expert` is the only level that may be ASKED for a case opinion. */
    seniorityLevel: doctorSeniorityEnum('seniority_level').notNull().default('standard'),
    /** Doctor keeps 100% of this. */
    consultationFeeInr: numeric('consultation_fee_inr', { precision: 10, scale: 2 }).notNull().default('0'),
    consultationDurationMinutes: smallint('consultation_duration_minutes').notNull().default(30),
    bufferMinutes: smallint('buffer_minutes').notNull().default(5),
    /** Admin toggle. Search needs verification_status = verified AND this true. */
    isListed: boolean('is_listed').notNull().default(false),
    allowInstantConsult: boolean('allow_instant_consult').notNull().default(false),
    presence: doctorPresenceEnum('presence').notNull().default('offline'),
    /** *** THE COMPLETION GATE *** set while documentation is outstanding. */
    blockedByConsultationId: uuid('blocked_by_consultation_id').references(
      (): AnyPgColumn => consultationsTable.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.verificationStatus, table.isListed),
    index().on(table.presence, table.allowInstantConsult),
    index().on(table.seniorityLevel),
    index().on(table.pushToken),
  ],
);

export type DoctorRow = typeof doctorsTable.$inferSelect;
export type NewDoctorRow = typeof doctorsTable.$inferInsert;
