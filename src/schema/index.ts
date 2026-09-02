/**
 * Barrel for every Drizzle table definition in this schema.
 *
 * The schema follows `docs/SRS.md` and `docs/MODULES.md` as the
 * specification. `docs/erd.sql` was the starting point for the original
 * port, but it is a historical artefact, not the source of truth — several
 * tables here (`otp_challenges`, `payment_events`, `doctor_specialties`,
 * `content_recommendations`, `search_queries`, `doctor_clinical_templates`)
 * exist because the requirements docs call for them and `erd.sql` never
 * modeled them. Where the two disagree, the requirements docs win.
 *
 * drizzle-kit itself globs every "*.schema.ts" file under src/ directly (see
 * `drizzle.config.ts`), so this file is not required for migrations to pick
 * up new tables — it exists so application code has one import path:
 *
 *   import { patientsTable, doctorsTable } from 'src/schema';
 */

export * from './enums.schema';

export * from './patients.schema';
export * from './admins.schema';
export * from './otp-challenges.schema';
export * from './otp-request-attempts.schema';
export * from './roles.schema';
export * from './permissions.schema';
export * from './role-permissions.schema';
export * from './admin-roles.schema';
export * from './admin-permission-grants.schema';
export * from './specialties.schema';
export * from './concerns.schema';
export * from './followup-pathways.schema';
export * from './legal-documents.schema';
export * from './app-config.schema';
export * from './audit-log.schema';

export * from './payments.schema';
export * from './payment-events.schema';
export * from './clinical-records.schema';

export * from './doctors.schema';
export * from './doctor-specialties.schema';
export * from './doctor-documents.schema';
export * from './doctor-availability.schema';
export * from './doctor-scheduling-settings.schema';
export * from './doctor-clinical-templates.schema';

export * from './consultations.schema';
export * from './consultation-participants.schema';
export * from './instant-consultancy.schema';
export * from './search-queries.schema';
export * from './search-rate-limits.schema';

export * from './report-requests.schema';
export * from './clarification-cases.schema';
export * from './patient-files.schema';

export * from './checkin-responses.schema';
export * from './safety-alerts.schema';

export * from './agent-profiles.schema';
export * from './agent-credentials.schema';
export * from './mcp-clients.schema';
export * from './mcp-request-attempts.schema';
export * from './storage-providers.schema';

export * from './content-items.schema';
export * from './content-recommendations.schema';
export * from './complaints.schema';
export * from './consents.schema';
export * from './data-deletion-requests.schema';
export * from './notifications.schema';
