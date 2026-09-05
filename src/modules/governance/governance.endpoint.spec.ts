/**
 * *** GOVERNANCE OVER REAL HTTP. ***
 *
 * Every route in `governance-admin.controller.ts` is a READ (two working
 * queues, the quality dashboard, a per-doctor reliability drill-down, and two
 * CSV exports) — this module owns no table of its own and has no
 * per-resource ownership concept at all. So unlike `clarification`/
 * `feedback`, the thing worth proving here is narrower and sharper: EVERY ONE
 * of these six routes is actually permission-gated (not just decorated), and
 * a handful of the dashboard's numbers are the REAL composed count, not a
 * hardcoded shape.
 *
 * Driven through `createConfiguredApp()` + `app.inject()` — the same
 * mechanism `app.e2e.integration.spec.ts` established — so the real
 * `JwtAuthGuard` -> `AccountTypeGuard` -> `PermissionGuard` chain runs for
 * every request, not a hand-rolled stand-in.
 *
 * *** WHY TOKENS ARE MINTED DIRECTLY, NOT VIA `/api/auth/otp/*`. *** Every
 * route this file exercises requires a real, signed, verifiable JWT — that is
 * exactly what `IdentityTokenService.mintTokenPair` produces, checked by the
 * SAME `resolveAccessToken` path `JwtAuthGuard` calls (signature, issuer,
 * `tokenVersion`, account-active). What OTP/Slide adds on top is proving the
 * SIGN-IN SCREEN itself, which is `app.e2e.integration.spec.ts`'s job, not
 * this file's — minting directly here is the "cleanest approach for
 * controller-only tests" recommendation this round's own investigation
 * reached, and keeps five modules from each re-mocking Slide.
 *
 * *** WHY DASHBOARD NUMBERS ARE VERIFIED BY DELTA, NEVER BY ABSOLUTE VALUE.
 * *** `governance-quality.service.ts#getDashboard` and
 * `governance-queue.service.ts` compute GLOBAL counts across the whole
 * `clinical_records`/`safety_alerts` tables — no patient/run scoping exists
 * to filter by, and this database is shared with real dev/demo data AND
 * several other worktrees' own test runs happening concurrently. Asserting
 * "the dashboard reports exactly 2" would be false the moment anything else
 * on the shared database has an open draft or alert. Reading the baseline
 * BEFORE seeding and asserting the POST-seed number is `baseline + knownDelta`
 * is the only assertion that is true regardless of what else is on the box.
 *
 * *** WHY THE PLAIN QUEUE LIST'S *CONTENTS* ARE NOT ASSERTED, ONLY ITS SHAPE
 * AND GATING. *** `listDrafts`/`listOpenAlerts` page oldest-first with a
 * DEFAULT limit of 20 — on a shared table with unknown backlog, this run's
 * brand-new (therefore newest) rows can legitimately fall off page one. The
 * CSV export (`GOVERNANCE_EXPORT_MAX_ROWS = 10,000`, effectively the whole
 * table) is the one place this file asserts on ROW CONTENTS — with that
 * ceiling, this run's rows are guaranteed to be in it.
 *
 * Requires a reachable Postgres — reads `.env`/`.env.local` exactly as
 * `app.e2e.integration.spec.ts` does, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { safetyAlertsTable } from '../../schema/safety-alerts.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

/** See `app.e2e.integration.spec.ts`'s identical helper — every response here is enveloped by the same global interceptor/filter. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  doctorId: string;
  patientId: string;
  adminFullId: string;
  adminNoneId: string;
  /** The two brand-new drafts this run adds to `pendingCaseSummaries`. */
  draftConsultationIds: string[];
  /** The red_flag alert's own consultation + row id. */
  redFlagConsultationId: string;
  redFlagAlertId: string;
  /** The amber (non-red_flag -> `followUpAlerts`) alert's own consultation + row id. */
  amberConsultationId: string;
  amberAlertId: string;
  /** Read BEFORE any fixture row is inserted — every dashboard assertion is `baseline + known delta`, never an absolute number. */
  baseline: { pendingCaseSummaries: number; redFlags: number; followUpAlerts: number };
}

async function countDraftClinicalRecords(db: Database): Promise<number> {
  const result = await db.execute(sql`select count(*)::int as count from clinical_records where finalised_at is null`);
  return (result.rows as Array<{ count: number }>)[0].count;
}

async function countOpenAlertsByType(db: Database, alertType: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from safety_alerts where alert_type = ${alertType} and acknowledged_at is null and closed_at is null`,
  );
  return (result.rows as Array<{ count: number }>)[0].count;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const mobile = (seq: number) => `GOV${runId}${seq}`.slice(0, 16);

  const baselinePending = await countDraftClinicalRecords(db);
  const baselineRed = await countOpenAlertsByType(db, 'red_flag');
  const baselineAmber = await countOpenAlertsByType(db, 'amber');

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `gov_${runId}`, name: `Governance Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(1), fullName: `Governance Doctor ${runId}` })
    .returning({ id: doctorsTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: mobile(2), fullName: `Governance Patient ${runId}` })
    .returning({ id: patientsTable.id });

  // `consultations_doctor_specialty_fk` requires this pair to exist before any consultation can reference both.
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [adminFull] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(3), fullName: `Governance Admin (all perms) ${runId}` })
    .returning({ id: adminsTable.id });

  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(4), fullName: `Governance Admin (no perms) ${runId}` })
    .returning({ id: adminsTable.id });

  for (const key of [
    PERMISSIONS.GOVERNANCE_READ_QUEUES,
    PERMISSIONS.GOVERNANCE_READ_QUALITY,
    PERMISSIONS.GOVERNANCE_EXPORT,
  ]) {
    const [permission] = await db
      .select({ id: permissionsTable.id })
      .from(permissionsTable)
      .where(eq(permissionsTable.key, key));
    if (!permission) throw new Error(`Permission "${key}" is not seeded — has identity.seed.ts run against this database?`);
    await db.insert(adminPermissionGrantsTable).values({ adminId: adminFull.id, permissionId: permission.id });
  }

  async function newConsultation(seq: number): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `GOV${runId}${seq}`.slice(0, 24),
        patientId: patient.id,
        doctorId: doctor.id,
        specialtyId: specialty.id,
        mode: 'scheduled',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }

  // Two brand-new DRAFT clinical records — `finalised_at` left null.
  const draftConsultationIds = [await newConsultation(1), await newConsultation(2)];
  await db.insert(clinicalRecordsTable).values([
    { consultationId: draftConsultationIds[0], chiefComplaint: 'fixture', riskCategory: 'high' },
    { consultationId: draftConsultationIds[1], chiefComplaint: 'fixture', riskCategory: 'moderate' },
  ]);

  // One OPEN red_flag alert -> counts toward `redFlags`.
  const redFlagConsultationId = await newConsultation(3);
  const [redFlagAlert] = await db
    .insert(safetyAlertsTable)
    .values({ alertType: 'red_flag', consultationId: redFlagConsultationId, reason: 'fixture red flag' })
    .returning({ id: safetyAlertsTable.id });

  // One OPEN amber alert -> counts toward `followUpAlerts` (every non-red_flag type, summed).
  const amberConsultationId = await newConsultation(4);
  const [amberAlert] = await db
    .insert(safetyAlertsTable)
    .values({ alertType: 'amber', consultationId: amberConsultationId, reason: 'fixture amber' })
    .returning({ id: safetyAlertsTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    doctorId: doctor.id,
    patientId: patient.id,
    adminFullId: adminFull.id,
    adminNoneId: adminNone.id,
    draftConsultationIds,
    redFlagConsultationId,
    redFlagAlertId: redFlagAlert.id,
    amberConsultationId,
    amberAlertId: amberAlert.id,
    baseline: { pendingCaseSummaries: baselinePending, redFlags: baselineRed, followUpAlerts: baselineAmber },
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const consultationIds = [
    ...fixtures.draftConsultationIds,
    fixtures.redFlagConsultationId,
    fixtures.amberConsultationId,
  ];
  await db.delete(safetyAlertsTable).where(inArray(safetyAlertsTable.id, [fixtures.redFlagAlertId, fixtures.amberAlertId]));
  await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.consultationId, consultationIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db
    .delete(adminPermissionGrantsTable)
    .where(inArray(adminPermissionGrantsTable.adminId, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(adminsTable).where(inArray(adminsTable.id, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

describe('*** GOVERNANCE ADMIN — every route, real HTTP ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: {
    adminFull: string;
    adminNone: string;
    doctor: string;
    patient: string;
  };

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'admin' | 'doctor' | 'patient', id: string) =>
      (await tokenService.mintTokenPair(accountType, id, 0)).accessToken;

    tokens = {
      adminFull: await mint('admin', fixtures.adminFullId),
      adminNone: await mint('admin', fixtures.adminNoneId),
      doctor: await mint('doctor', fixtures.doctorId),
      patient: await mint('patient', fixtures.patientId),
    };
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /* ====================================================================== */
  /* Shared auth-boundary matrix, run against every route                    */
  /* ====================================================================== */

  function authBoundary(method: 'GET', url: string) {
    it('401s with no token', async () => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('403s for the right token but wrong account type (doctor)', async () => {
      const response = await app.inject({ method, url, headers: bearer(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('403s for an admin missing the required permission', async () => {
      const response = await app.inject({ method, url, headers: bearer(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  }

  /* ====================================================================== */
  /* Working queue: pending case summaries — governance.read_queues          */
  /* ====================================================================== */

  describe('GET /api/admin/governance/queues/pending-case-summaries', () => {
    authBoundary('GET', '/api/admin/governance/queues/pending-case-summaries');

    it('200s for an admin holding governance.read_queues, and returns a well-shaped list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/queues/pending-case-summaries?limit=100',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      const items = payload<Array<{ consultationId: string; riskCategory: string }>>(response);
      expect(Array.isArray(items)).toBe(true);
    });

    it('400s on a DTO validation failure (limit below the Min(1) bound)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/queues/pending-case-summaries?limit=0',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* Working queue: safety alerts — governance.read_queues                   */
  /* ====================================================================== */

  describe('GET /api/admin/governance/queues/safety-alerts', () => {
    authBoundary('GET', '/api/admin/governance/queues/safety-alerts');

    it('200s for an admin holding governance.read_queues, and returns a well-shaped list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/queues/safety-alerts?limit=100',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      const items = payload<Array<{ id: string; alertType: string; triage: string }>>(response);
      expect(Array.isArray(items)).toBe(true);
    });

    it('400s on a DTO validation failure (limit above the Max(100) bound)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/queues/safety-alerts?limit=101',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* Quality dashboard — governance.read_quality                             */
  /* ====================================================================== */

  describe('GET /api/admin/governance/quality-dashboard', () => {
    authBoundary('GET', '/api/admin/governance/quality-dashboard');

    /**
     * *** THE REAL NUMBER, NOT A HARDCODED SHAPE. *** `baseline` was read
     * BEFORE this run's fixtures existed — see the file header for why an
     * absolute assertion would be false on a shared database. This proves
     * `getDashboard()` actually re-queries `clinical_records`/`safety_alerts`
     * live rather than, say, always answering `0` or a cached value.
     */
    it('200s for an admin holding governance.read_quality, with the three composed numbers exactly baseline + this run\'s fixture', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/quality-dashboard',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      const dashboard = payload<{ pendingCaseSummaries: number; redFlags: number; followUpAlerts: number }>(response);

      expect(dashboard.pendingCaseSummaries).toBe(fixtures.baseline.pendingCaseSummaries + 2);
      expect(dashboard.redFlags).toBe(fixtures.baseline.redFlags + 1);
      expect(dashboard.followUpAlerts).toBe(fixtures.baseline.followUpAlerts + 1);
    });
  });

  /* ====================================================================== */
  /* Doctor reliability drill-down — governance.read_quality                 */
  /* ====================================================================== */

  describe('GET /api/admin/governance/doctors/:doctorId/reliability', () => {
    authBoundary('GET', `/api/admin/governance/doctors/${randomUUID()}/reliability`);

    it('200s for a real doctor, for an admin holding governance.read_quality', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/governance/doctors/${fixtures.doctorId}/reliability`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
    });

    it('404s for a well-formed but non-existent doctor id — never a leak, never a 500', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/governance/doctors/${randomUUID()}/reliability`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(404);
    });

    it('400s on a malformed (non-UUID) doctor id — the UUID param pipe runs before the permission check ever matters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/doctors/not-a-uuid/reliability',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* CSV exports — governance.export                                        */
  /* ====================================================================== */

  describe('GET /api/admin/governance/export/pending-case-summaries', () => {
    authBoundary('GET', '/api/admin/governance/export/pending-case-summaries');

    it('200s as a real CSV attachment, for an admin holding governance.export, and contains this run\'s two known consultation ids', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/export/pending-case-summaries',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      // `toCsvDocument` prepends a UTF-8 BOM (`﻿`) so the file opens
      // correctly by double-click in Excel on Windows — see `csv.util.ts`'s
      // own header. Stripped here before the header-row check.
      const csv = response.payload.replace(/^﻿/, '');
      expect(csv.startsWith('consultation_id,')).toBe(true);
      for (const id of fixtures.draftConsultationIds) {
        expect(csv).toContain(id);
      }
    });
  });

  describe('GET /api/admin/governance/export/safety-alerts', () => {
    authBoundary('GET', '/api/admin/governance/export/safety-alerts');

    it('200s as a real CSV attachment, for an admin holding governance.export, and contains both known alerts with the correct triage', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/governance/export/safety-alerts',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      const csv = response.payload;
      expect(csv).toContain(fixtures.redFlagAlertId);
      expect(csv).toContain(fixtures.amberAlertId);

      const redFlagLine = csv.split('\n').find((line) => line.includes(fixtures.redFlagAlertId));
      expect(redFlagLine).toContain('high_risk');
      const amberLine = csv.split('\n').find((line) => line.includes(fixtures.amberAlertId));
      expect(amberLine).toContain('follow_up');
    });
  });
});
