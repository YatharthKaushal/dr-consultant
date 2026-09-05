/**
 * *** REAL-HTTP ENDPOINT TESTS — `patient` MODULE. ***
 *
 * Drives every route in `patient.controller.ts` and
 * `patient-admin.controller.ts` through `createConfiguredApp()` +
 * `app.inject()` — real guards, real `ValidationPipe`, real database. No
 * vendor to mock. Every account's token is minted directly via
 * `IdentityTokenService.mintTokenPair`, the same real signer a genuine OTP
 * sign-in hands its result to.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import type { AccountType } from '../../schema/enums.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

function pgArray(values: readonly string[], type: 'uuid' | 'varchar') {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`);
  return sql.raw(`array['${values.join("','")}']::${type}[]`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixtures {
  runId: string;
  /** Created bare (status 'pending') — used for the profile-completion transition tests. */
  pendingPatientId: string;
  pendingPatientMobile: string;
  /** Created already-active — used for routine-edit and moderation tests. */
  activePatientId: string;
  doctorId: string;
  adminReadId: string;
  adminManageStatusId: string;
  adminNoneId: string;
}

async function permissionId(db: Database, key: string): Promise<string> {
  const [row] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
  if (!row) {
    throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts against this database first.`);
  }
  return row.id;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9176${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const pendingPatientMobile = nextPhone();
  const [pendingPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: pendingPatientMobile, status: 'pending' })
    .returning({ id: patientsTable.id });

  const [activePatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Active Patient ${runId}`, dateOfBirth: '1990-01-01', status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Patient-test Doctor ${runId}` })
    .returning({ id: doctorsTable.id });

  const [adminRead] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Patient Admin Read ${runId}` }).returning({ id: adminsTable.id });
  const [adminManageStatus] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Patient Admin ManageStatus ${runId}` }).returning({ id: adminsTable.id });
  const [adminNone] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Patient Admin None ${runId}` }).returning({ id: adminsTable.id });

  await db.insert(adminPermissionGrantsTable).values({ adminId: adminRead.id, permissionId: await permissionId(db, PERMISSIONS.PATIENTS_READ) });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManageStatus.id, permissionId: await permissionId(db, PERMISSIONS.PATIENTS_READ) });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManageStatus.id, permissionId: await permissionId(db, PERMISSIONS.PATIENTS_MANAGE_STATUS) });

  return {
    runId,
    pendingPatientId: pendingPatient.id,
    pendingPatientMobile,
    activePatientId: activePatient.id,
    doctorId: doctor.id,
    adminReadId: adminRead.id,
    adminManageStatusId: adminManageStatus.id,
    adminNoneId: adminNone.id,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.pendingPatientId, fixtures.activePatientId];
  const adminIds = [fixtures.adminReadId, fixtures.adminManageStatusId, fixtures.adminNoneId];

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from patients where id = any(${pgArray(patientIds, 'uuid')})`);
  await db.execute(sql`delete from doctors where id = ${fixtures.doctorId}`);

  // `audit_log.entity_id` is varchar, not uuid — compare as text.
  await db.execute(
    sql`delete from audit_log where actor_id = any(${pgArray([...patientIds, ...adminIds], 'uuid')}) or entity_id = any(${pgArray(patientIds, 'varchar')})`,
  );
}

/* -------------------------------------------------------------------------- */

describe('patient module — real HTTP endpoint tests', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;

  const tokens: Record<string, string> = {};

  async function mint(accountType: AccountType, accountId: string, tokenVersion = 0): Promise<string> {
    const pair = await tokenService.mintTokenPair(accountType, accountId, tokenVersion);
    return pair.accessToken;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    tokenService = app.get(IdentityTokenService);

    fixtures = await seedFixtures(db);

    tokens.pending = await mint('patient', fixtures.pendingPatientId);
    tokens.active = await mint('patient', fixtures.activePatientId);
    tokens.doctor = await mint('doctor', fixtures.doctorId);
    tokens.adminRead = await mint('admin', fixtures.adminReadId);
    tokens.adminManageStatus = await mint('admin', fixtures.adminManageStatusId);
    tokens.adminNone = await mint('admin', fixtures.adminNoneId);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ====================================================================== */
  /* GET /patients/me                                                        */
  /* ====================================================================== */

  describe('GET /patients/me', () => {
    it("returns the caller's own profile, without tokenVersion", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(tokens.active) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; tokenVersion?: unknown }>(response);
      expect(body.id).toBe(fixtures.activePatientId);
      expect(body).not.toHaveProperty('tokenVersion');
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/patients/me' });
      expect(response.statusCode).toBe(401);
    });

    it('a doctor token is refused as the wrong account type — 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('an admin token is also refused — this route is patient-only', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(403);
    });
  });

  /* ====================================================================== */
  /* PATCH /patients/me                                                      */
  /* ====================================================================== */

  describe('PATCH /patients/me — routine edits', () => {
    it('updates a single field, leaving the rest untouched', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.active),
        payload: { preferredLanguage: 'hi' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ preferredLanguage: string; fullName: string | null }>(response);
      expect(body.preferredLanguage).toBe('hi');
      expect(body.fullName).toBe(`Active Patient ${fixtures.runId}`);
    });

    it('an invalid gender enum value is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.active),
        payload: { gender: 'not-a-real-gender' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a malformed dateOfBirth is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.active),
        payload: { dateOfBirth: 'not-a-date' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a fullName over 160 characters is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.active),
        payload: { fullName: 'x'.repeat(161) },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'PATCH', url: '/api/patients/me', payload: { preferredLanguage: 'en' } });
      expect(response.statusCode).toBe(401);
    });

    it('a doctor token is refused — 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'PATCH', url: '/api/patients/me', headers: auth(tokens.doctor), payload: { preferredLanguage: 'en' } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  describe('PATCH /patients/me — the profile-completion transition (FR-1.1/FR-2.2)', () => {
    it('setting fullName alone on a pending account does NOT yet complete the profile', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.pending),
        payload: { fullName: `Pending Patient ${fixtures.runId}` },
      });
      expect(response.statusCode).toBe(200);
      // Re-read raw — the response itself carries no `status` field per PublicPatientRow? Actually it does (status is not stripped). Confirm via a fresh DB read regardless.
      const [row] = await db.select({ status: patientsTable.status }).from(patientsTable).where(eq(patientsTable.id, fixtures.pendingPatientId));
      expect(row.status).toBe('pending');
    });

    it('*** BUSINESS RULE *** adding dateOfBirth alongside the existing fullName completes the profile — status flips to active in the same write', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.pending),
        payload: { dateOfBirth: '1995-06-15' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string }>(response);
      expect(body.status).toBe('active');

      const [row] = await db.select({ status: patientsTable.status }).from(patientsTable).where(eq(patientsTable.id, fixtures.pendingPatientId));
      expect(row.status).toBe('active');
    });

    it('the account remains active for a subsequent routine edit — the transition does not re-fire', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/patients/me',
        headers: auth(tokens.pending),
        payload: { preferredLanguage: 'ta' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('active');
    });
  });

  /* ====================================================================== */
  /* Admin — auth boundary                                                   */
  /* ====================================================================== */

  describe('admin/patients — auth boundary', () => {
    it('a patient token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/patients', headers: auth(tokens.active) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/patients' });
      expect(response.statusCode).toBe(401);
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/patients', headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/patients (PATIENTS_READ)', () => {
    it('lists patients, including the fixtures created for this run', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/patients', headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([fixtures.pendingPatientId, fixtures.activePatientId]));
    });
  });

  describe('GET /admin/patients/:id (PATIENTS_READ)', () => {
    it('returns one patient by id', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/patients/${fixtures.activePatientId}`, headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(200);
      expect(payload<{ id: string }>(response).id).toBe(fixtures.activePatientId);
    });

    it('a well-formed but nonexistent id is 404 PATIENT_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/patients/${randomUUID()}`, headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('PATIENT_NOT_FOUND');
    });

    /**
     * *** REGRESSION FOR A FIXED BUG — SEE API_TEST_FINDINGS.md. ***
     * `patient-admin.controller.ts`'s `:id` params were missing
     * `createUuidValidationPipe`, unlike every other admin controller in this
     * codebase (`doctor-admin.controller.ts`, `specialty-admin.controller.ts`,
     * etc.) — a malformed id reached Drizzle's `eq(patientsTable.id, id)`
     * against a `uuid` column, Postgres raised `22P02 invalid input syntax for
     * type uuid`, and `HttpExceptionFilter`'s catch-all branch reported a raw
     * 500 `INTERNAL_SERVER_ERROR` instead of a clean 400. Fixed by adding the
     * same pipe every sibling controller already uses.
     */
    it('a malformed (non-UUID) id is refused as a clean 400 VALIDATION_FAILED, never a raw 500', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/patients/not-a-uuid', headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /admin/patients/:id/status (PATIENTS_MANAGE_STATUS)', () => {
    it('*** SPLIT PERMISSION PROVEN *** PATIENTS_READ alone cannot change status — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/patients/${fixtures.activePatientId}/status`,
        headers: auth(tokens.adminRead),
        payload: { status: 'suspended' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('an invalid status value is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/patients/${fixtures.activePatientId}/status`,
        headers: auth(tokens.adminManageStatus),
        payload: { status: 'not-a-real-status' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a nonexistent id is 404 PATIENT_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/patients/${randomUUID()}/status`,
        headers: auth(tokens.adminManageStatus),
        payload: { status: 'suspended' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('a malformed id is a clean 400, never a raw 500 (same fix as GET /admin/patients/:id)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/patients/not-a-uuid/status',
        headers: auth(tokens.adminManageStatus),
        payload: { status: 'suspended' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('*** SESSION REVOCATION *** suspending a patient immediately invalidates their existing token', async () => {
      const me = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(tokens.active) });
      expect(me.statusCode).toBe(200);

      const suspend = await app.inject({
        method: 'PATCH',
        url: `/api/admin/patients/${fixtures.activePatientId}/status`,
        headers: auth(tokens.adminManageStatus),
        payload: { status: 'suspended' },
      });
      expect(suspend.statusCode).toBe(200);
      expect(payload<{ status: string }>(suspend).status).toBe('suspended');

      const meAfter = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(tokens.active) });
      expect(meAfter.statusCode).toBe(401);
    });

    it('reinstating to active does not itself revoke — a freshly minted token after reinstatement works', async () => {
      const reinstate = await app.inject({
        method: 'PATCH',
        url: `/api/admin/patients/${fixtures.activePatientId}/status`,
        headers: auth(tokens.adminManageStatus),
        payload: { status: 'active' },
      });
      expect(reinstate.statusCode).toBe(200);
      expect(payload<{ status: string }>(reinstate).status).toBe('active');

      // *** NOT `mint()` — THAT HARDCODES tokenVersion: 0. *** The suspend
      // step above bumped the real column; a fresh token must carry the
      // CURRENT tokenVersion or `IdentityAuthContextService`'s comparison
      // rejects it as stale, which would look like a false "still revoked"
      // failure rather than proving what this test actually checks.
      const [row] = await db.select({ tokenVersion: patientsTable.tokenVersion }).from(patientsTable).where(eq(patientsTable.id, fixtures.activePatientId));
      const freshToken = await mint('patient', fixtures.activePatientId, row.tokenVersion);
      const me = await app.inject({ method: 'GET', url: '/api/patients/me', headers: auth(freshToken) });
      expect(me.statusCode).toBe(200);
    });
  });
});
