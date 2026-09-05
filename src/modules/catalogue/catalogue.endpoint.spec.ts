/**
 * *** REAL-HTTP ENDPOINT TESTS for the `catalogue` module — specialties and
 * concerns. ***
 *
 * Every other test touching this module calls `SpecialtyService`/
 * `ConcernService` directly. This drives every route in
 * `specialty.controller.ts`, `specialty-admin.controller.ts`,
 * `concern.controller.ts` and `concern-admin.controller.ts` through
 * `createConfiguredApp()` + `app.inject()` — the real router, the real
 * `JwtAuthGuard`/`AccountTypeGuard`/`PermissionGuard` stack, the real
 * `ValidationPipe`, the real database.
 *
 * No vendor to mock here — nothing in this module calls Slide, Razorpay or
 * LiveKit, so unlike `app.e2e.integration.spec.ts` there is no
 * `jest.mock('@synquic/slide')` at the top of this file. Every account's
 * access token is minted directly via `IdentityTokenService.mintTokenPair`,
 * the same real, un-mocked signer `identity.service.ts#verifyOtp` calls after
 * a real OTP verification — this proves the SAME guard stack a real sign-in
 * would hand a token to, without re-deriving the OTP flow that
 * `identity.endpoint.spec.ts` already owns.
 *
 * Fixture discipline copied from `app.e2e.integration.spec.ts`: one
 * `seedFixtures`, one `teardown` in reverse-FK order, every unique column
 * namespaced by a per-run `runId`, every assertion re-read from Postgres
 * fresh where it matters.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import type { AccountType } from '../../schema/enums.schema';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { concernsTable } from '../../schema/concerns.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/* Envelope helper — identical contract to app.e2e.integration.spec.ts        */
/* -------------------------------------------------------------------------- */

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
  patientId: string;
  doctorId: string;
  /** All catalogue-relevant permissions — the success-path caller. */
  adminAllId: string;
  /** Zero grants — proves every permission-gated route actually 403s. */
  adminNoneId: string;
  /** SPECIALTIES_READ only — proves READ does not imply MANAGE. */
  adminSpecReadOnlyId: string;
  /** SPECIALTIES_MANAGE only (no CLINICAL_TEMPLATES) — proves the templates split is enforced. */
  adminSpecManageOnlyId: string;
  /** CONCERNS_MANAGE only (no SEARCH_MANAGE_MAPPING) — proves the mapping split is enforced. */
  adminConcernManageOnlyId: string;
  activeSpecialtyId: string;
  inactiveSpecialtyId: string;
  concernId: string;
}

async function permissionId(db: Database, key: string): Promise<string> {
  const [row] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
  if (!row) {
    throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts against this database first.`);
  }
  return row.id;
}

async function grantAdmin(db: Database, adminId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const permId = await permissionId(db, key);
    await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permId });
  }
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9178${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Catalogue Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Catalogue Doctor ${runId}` })
    .returning({ id: doctorsTable.id });

  const adminIds: Record<string, string> = {};
  for (const label of ['all', 'none', 'specReadOnly', 'specManageOnly', 'concernManageOnly']) {
    const [admin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `Catalogue Admin ${label} ${runId}` })
      .returning({ id: adminsTable.id });
    adminIds[label] = admin.id;
  }

  await grantAdmin(db, adminIds.all, [
    PERMISSIONS.SPECIALTIES_READ,
    PERMISSIONS.SPECIALTIES_MANAGE,
    PERMISSIONS.SPECIALTIES_MANAGE_CLINICAL_TEMPLATES,
    PERMISSIONS.CONCERNS_READ,
    PERMISSIONS.CONCERNS_MANAGE,
    PERMISSIONS.SEARCH_MANAGE_MAPPING,
  ]);
  await grantAdmin(db, adminIds.specReadOnly, [PERMISSIONS.SPECIALTIES_READ]);
  await grantAdmin(db, adminIds.specManageOnly, [PERMISSIONS.SPECIALTIES_READ, PERMISSIONS.SPECIALTIES_MANAGE]);
  await grantAdmin(db, adminIds.concernManageOnly, [PERMISSIONS.CONCERNS_READ, PERMISSIONS.CONCERNS_MANAGE]);
  // adminNoneId: deliberately no grants at all.

  const [activeSpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `cat_active_${runId}`, name: `Active Specialty ${runId}`, canPrescribe: true, isActive: true })
    .returning({ id: specialtiesTable.id });

  const [inactiveSpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `cat_inactive_${runId}`, name: `Inactive Specialty ${runId}`, canPrescribe: false, isActive: false })
    .returning({ id: specialtiesTable.id });

  const [concern] = await db
    .insert(concernsTable)
    .values({ specialtyId: activeSpecialty.id, code: `concern_${runId}`, name: `Concern ${runId}`, isActive: true })
    .returning({ id: concernsTable.id });

  return {
    runId,
    patientId: patient.id,
    doctorId: doctor.id,
    adminAllId: adminIds.all,
    adminNoneId: adminIds.none,
    adminSpecReadOnlyId: adminIds.specReadOnly,
    adminSpecManageOnlyId: adminIds.specManageOnly,
    adminConcernManageOnlyId: adminIds.concernManageOnly,
    activeSpecialtyId: activeSpecialty.id,
    inactiveSpecialtyId: inactiveSpecialty.id,
    concernId: concern.id,
  };
}

/** Every specialty/concern id this file creates OUTSIDE seedFixtures (via POST routes), tracked for teardown. */
const createdSpecialtyIds: string[] = [];
const createdConcernIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [
    fixtures.adminAllId,
    fixtures.adminNoneId,
    fixtures.adminSpecReadOnlyId,
    fixtures.adminSpecManageOnlyId,
    fixtures.adminConcernManageOnlyId,
  ];
  const specialtyIds = [fixtures.activeSpecialtyId, fixtures.inactiveSpecialtyId, ...createdSpecialtyIds];
  const concernIds = [fixtures.concernId, ...createdConcernIds];

  await db.delete(concernsTable).where(sql`${concernsTable.id} = any(${pgArray(concernIds, 'uuid')})`);
  await db.delete(specialtiesTable).where(sql`${specialtiesTable.id} = any(${pgArray(specialtyIds, 'uuid')})`);

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from patients where id = ${fixtures.patientId}`);
  await db.execute(sql`delete from doctors where id = ${fixtures.doctorId}`);

  // `audit_log.entity_id` is varchar, not uuid — compare as text (see app.e2e.integration.spec.ts's teardown for the same cast).
  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...specialtyIds, ...concernIds], 'varchar')}) or actor_id = any(${pgArray(adminIds, 'uuid')})`,
  );
}

/* -------------------------------------------------------------------------- */

describe('catalogue module — real HTTP endpoint tests', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;

  const tokens: Record<string, string> = {};

  async function mint(accountType: AccountType, accountId: string): Promise<string> {
    const pair = await tokenService.mintTokenPair(accountType, accountId, 0);
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

    tokens.patient = await mint('patient', fixtures.patientId);
    tokens.doctor = await mint('doctor', fixtures.doctorId);
    tokens.adminAll = await mint('admin', fixtures.adminAllId);
    tokens.adminNone = await mint('admin', fixtures.adminNoneId);
    tokens.adminSpecReadOnly = await mint('admin', fixtures.adminSpecReadOnlyId);
    tokens.adminSpecManageOnly = await mint('admin', fixtures.adminSpecManageOnlyId);
    tokens.adminConcernManageOnly = await mint('admin', fixtures.adminConcernManageOnlyId);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ====================================================================== */
  /* GET /specialties — public list, any authenticated account type          */
  /* ====================================================================== */

  describe('GET /specialties', () => {
    it('lists active specialties only, for a patient', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/specialties', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const list = payload<Array<{ id: string; isActive: boolean }>>(response);
      const ids = list.map((s) => s.id);
      expect(ids).toContain(fixtures.activeSpecialtyId);
      expect(ids).not.toContain(fixtures.inactiveSpecialtyId);
      expect(list.every((s) => s.isActive)).toBe(true);
    });

    it('also works for a doctor and for an admin — no @AccountType restriction on this route', async () => {
      const doctorResponse = await app.inject({ method: 'GET', url: '/api/specialties', headers: auth(tokens.doctor) });
      expect(doctorResponse.statusCode).toBe(200);
      const adminResponse = await app.inject({ method: 'GET', url: '/api/specialties', headers: auth(tokens.adminAll) });
      expect(adminResponse.statusCode).toBe(200);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/specialties' });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });
  });

  /* ====================================================================== */
  /* GET /specialties/:id                                                    */
  /* ====================================================================== */

  describe('GET /specialties/:id', () => {
    it('returns the active specialty to a patient', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/specialties/${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ id: string }>(response).id).toBe(fixtures.activeSpecialtyId);
    });

    it('*** EXISTENCE LEAK CHECK *** an inactive specialty answers 404 to a patient, never 403 — indistinguishable from a nonexistent id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/specialties/${fixtures.inactiveSpecialtyId}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('the SAME inactive specialty IS visible to an admin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/specialties/${fixtures.inactiveSpecialtyId}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ isActive: boolean }>(response).isActive).toBe(false);
    });

    it('a nonexistent id answers the identical 404 shape', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/specialties/${randomUUID()}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('a malformed (non-UUID) id is refused as a clean 400, not a raw DB error', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/specialties/not-a-uuid',
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  /* ====================================================================== */
  /* GET /concerns                                                           */
  /* ====================================================================== */

  describe('GET /concerns', () => {
    it('lists active concerns, unfiltered', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/concerns', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const list = payload<Array<{ id: string }>>(response);
      expect(list.map((c) => c.id)).toContain(fixtures.concernId);
    });

    it('filters by specialtyId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/concerns?specialtyId=${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(200);
      const list = payload<Array<{ id: string; specialtyId: string }>>(response);
      expect(list.every((c) => c.specialtyId === fixtures.activeSpecialtyId)).toBe(true);
      expect(list.map((c) => c.id)).toContain(fixtures.concernId);
    });

    it('a malformed specialtyId query param is a clean 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/concerns?specialtyId=not-a-uuid',
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/concerns' });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Admin specialties — auth boundary shared across the whole controller    */
  /* ====================================================================== */

  describe('admin/specialties — auth boundary', () => {
    it('a patient token is refused as the wrong account type — 403 WRONG_ACCOUNT_TYPE, not 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/specialties',
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token at all is 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/specialties' });
      expect(response.statusCode).toBe(401);
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminNone),
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/specialties (SPECIALTIES_READ)', () => {
    it('lists every specialty, including the inactive one — this is the management list, not the public one', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining([fixtures.activeSpecialtyId, fixtures.inactiveSpecialtyId]));
    });
  });

  describe('GET /admin/specialties/:id (SPECIALTIES_READ)', () => {
    it('returns the full row, including admin-only template fields', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/specialties/${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; prescriptionTemplate: unknown }>(response);
      expect(body.id).toBe(fixtures.activeSpecialtyId);
      expect(body).toHaveProperty('prescriptionTemplate');
    });

    it('a nonexistent id is 404 SPECIALTY_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/specialties/${randomUUID()}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });
  });

  describe('POST /admin/specialties (SPECIALTIES_MANAGE)', () => {
    it('creates a specialty with only the required fields', async () => {
      const code = `cat_new_min_${fixtures.runId}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminAll),
        payload: { code, name: 'New Minimal Specialty', canPrescribe: false },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; code: string; requiredDocuments: string[] }>(response);
      expect(body.code).toBe(code);
      expect(body.requiredDocuments).toEqual([]);
      createdSpecialtyIds.push(body.id);
    });

    it('creates a specialty with every optional field populated', async () => {
      const code = `cat_new_full_${fixtures.runId}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminAll),
        payload: {
          code,
          name: 'New Full Specialty',
          description: 'A full description.',
          canPrescribe: true,
          intakeForm: [{ key: 'age', label: 'Age', type: 'number' }],
          firstConsultForm: [{ key: 'history', label: 'History', type: 'text' }],
          requiredDocuments: ['registration_certificate'],
        },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; requiredDocuments: string[] }>(response);
      expect(body.requiredDocuments).toEqual(['registration_certificate']);
      createdSpecialtyIds.push(body.id);
    });

    it('a duplicate code is refused — 409 SPECIALTY_CODE_TAKEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminAll),
        payload: { code: `cat_active_${fixtures.runId}`, name: 'Duplicate', canPrescribe: false },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_CODE_TAKEN');
    });

    it('a missing required field (canPrescribe) is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminAll),
        payload: { code: `cat_invalid_${fixtures.runId}`, name: 'Missing canPrescribe' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('*** SPLIT PERMISSION PROVEN *** SPECIALTIES_READ alone cannot create — 403 PERMISSION_DENIED, even though the same admin can GET', async () => {
      const getResponse = await app.inject({
        method: 'GET',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminSpecReadOnly),
      });
      expect(getResponse.statusCode).toBe(200);

      const postResponse = await app.inject({
        method: 'POST',
        url: '/api/admin/specialties',
        headers: auth(tokens.adminSpecReadOnly),
        payload: { code: `cat_denied_${fixtures.runId}`, name: 'Should Not Be Created', canPrescribe: false },
      });
      expect(postResponse.statusCode).toBe(403);
      expect(payload<{ code: string }>(postResponse).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('PATCH /admin/specialties/:id (SPECIALTIES_MANAGE)', () => {
    it('updates general fields', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.adminAll),
        payload: { description: 'Updated description.' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ description: string }>(response).description).toBe('Updated description.');
    });

    it('a nonexistent id is 404 SPECIALTY_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${randomUUID()}`,
        headers: auth(tokens.adminAll),
        payload: { name: 'Does not matter' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('*** BUSINESS RULE *** cannot flip canPrescribe=false while a prescriptionTemplate is set — 409 CANNOT_DISABLE_PRESCRIBING_WITH_TEMPLATE_SET', async () => {
      // A fresh, dedicated specialty so this test cannot interfere with the shared activeSpecialtyId fixture.
      const [templated] = await db
        .insert(specialtiesTable)
        .values({ code: `cat_templated_${fixtures.runId}`, name: 'Templated', canPrescribe: true, isActive: true })
        .returning({ id: specialtiesTable.id });
      createdSpecialtyIds.push(templated.id);

      const setTemplate = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${templated.id}/templates`,
        headers: auth(tokens.adminAll),
        payload: { prescriptionTemplate: [{ name: 'Sertraline', dose: '50mg', frequency: 'OD', duration: '30d' }] },
      });
      expect(setTemplate.statusCode).toBe(200);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${templated.id}`,
        headers: auth(tokens.adminAll),
        payload: { canPrescribe: false },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CANNOT_DISABLE_PRESCRIBING_WITH_TEMPLATE_SET');
    });
  });

  describe('PATCH /admin/specialties/:id/templates (SPECIALTIES_MANAGE_CLINICAL_TEMPLATES)', () => {
    it('sets prescriptionTemplate and adviceTemplate on a prescribing specialty', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${fixtures.activeSpecialtyId}/templates`,
        headers: auth(tokens.adminAll),
        payload: {
          prescriptionTemplate: [{ name: 'Sertraline', dose: '50mg', frequency: 'OD', duration: '30d' }],
          adviceTemplate: { covered: 'x', homePractice: 'y', nextFocus: 'z', warningSigns: 'w' },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ prescriptionTemplate: unknown[]; adviceTemplate: Record<string, unknown> }>(response);
      expect(body.prescriptionTemplate).toHaveLength(1);
      expect(body.adviceTemplate.covered).toBe('x');
    });

    it('*** BUSINESS RULE, OPPOSITE DIRECTION *** setting a prescriptionTemplate on a non-prescribing specialty is refused — 409 TEMPLATE_REQUIRES_PRESCRIBING', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${fixtures.inactiveSpecialtyId}/templates`,
        headers: auth(tokens.adminAll),
        payload: { prescriptionTemplate: [{ name: 'X', dose: '1', frequency: 'OD', duration: '1d' }] },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('TEMPLATE_REQUIRES_PRESCRIBING');
    });

    it('a nonexistent id is 404 SPECIALTY_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${randomUUID()}/templates`,
        headers: auth(tokens.adminAll),
        payload: { adviceTemplate: null },
      });
      expect(response.statusCode).toBe(404);
    });

    it('*** SPLIT PERMISSION PROVEN *** SPECIALTIES_MANAGE alone cannot touch templates — 403, even though the same admin can PATCH general fields', async () => {
      const generalPatch = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.adminSpecManageOnly),
        payload: { description: 'Touched by SPECIALTIES_MANAGE-only admin.' },
      });
      expect(generalPatch.statusCode).toBe(200);

      const templatesPatch = await app.inject({
        method: 'PATCH',
        url: `/api/admin/specialties/${fixtures.activeSpecialtyId}/templates`,
        headers: auth(tokens.adminSpecManageOnly),
        payload: { adviceTemplate: { covered: 'nope', homePractice: 'nope', nextFocus: 'nope', warningSigns: 'nope' } },
      });
      expect(templatesPatch.statusCode).toBe(403);
      expect(payload<{ code: string }>(templatesPatch).code).toBe('PERMISSION_DENIED');
    });
  });

  /* ====================================================================== */
  /* Admin concerns                                                          */
  /* ====================================================================== */

  describe('admin/concerns — auth boundary', () => {
    it('a doctor token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/concerns', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/concerns', headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/concerns and /admin/concerns/:id (CONCERNS_READ)', () => {
    it('lists concerns, optionally filtered by specialtyId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/concerns?specialtyId=${fixtures.activeSpecialtyId}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(response).map((c) => c.id)).toContain(fixtures.concernId);
    });

    it('a nonexistent concern id is 404 CONCERN_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/concerns/${randomUUID()}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('CONCERN_NOT_FOUND');
    });
  });

  describe('POST /admin/concerns (CONCERNS_MANAGE)', () => {
    it('creates a concern under an existing specialty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/concerns',
        headers: auth(tokens.adminAll),
        payload: { specialtyId: fixtures.activeSpecialtyId, code: `concern_new_${fixtures.runId}`, name: 'New Concern' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; specialtyId: string }>(response);
      expect(body.specialtyId).toBe(fixtures.activeSpecialtyId);
      createdConcernIds.push(body.id);
    });

    it('*** BUSINESS RULE *** a nonexistent specialtyId is refused — 404 SPECIALTY_NOT_FOUND, not a raw FK error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/concerns',
        headers: auth(tokens.adminAll),
        payload: { specialtyId: randomUUID(), code: 'orphan', name: 'Orphan Concern' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('a duplicate (specialtyId, code) pair is refused — 409 CONCERN_CODE_TAKEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/concerns',
        headers: auth(tokens.adminAll),
        payload: { specialtyId: fixtures.activeSpecialtyId, code: `concern_${fixtures.runId}`, name: 'Duplicate' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CONCERN_CODE_TAKEN');
    });

    it('a missing required field (specialtyId) is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/concerns',
        headers: auth(tokens.adminAll),
        payload: { code: 'no_specialty', name: 'No Specialty' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /admin/concerns/:id (CONCERNS_MANAGE)', () => {
    it('updates general fields, including moving to a different specialty', async () => {
      const [otherSpecialty] = await db
        .insert(specialtiesTable)
        .values({ code: `cat_other_${fixtures.runId}`, name: 'Other Specialty', canPrescribe: false, isActive: true })
        .returning({ id: specialtiesTable.id });
      createdSpecialtyIds.push(otherSpecialty.id);

      const [movable] = await db
        .insert(concernsTable)
        .values({ specialtyId: fixtures.activeSpecialtyId, code: `movable_${fixtures.runId}`, name: 'Movable' })
        .returning({ id: concernsTable.id });
      createdConcernIds.push(movable.id);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${movable.id}`,
        headers: auth(tokens.adminAll),
        payload: { specialtyId: otherSpecialty.id },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ specialtyId: string }>(response).specialtyId).toBe(otherSpecialty.id);
    });

    it('*** BUSINESS RULE *** moving to a nonexistent specialty is 404 SPECIALTY_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${fixtures.concernId}`,
        headers: auth(tokens.adminAll),
        payload: { specialtyId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('a nonexistent concern id is 404 CONCERN_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${randomUUID()}`,
        headers: auth(tokens.adminAll),
        payload: { name: 'Does not matter' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('CONCERN_NOT_FOUND');
    });
  });

  describe('PATCH /admin/concerns/:id/mapping (SEARCH_MANAGE_MAPPING)', () => {
    it('updates matchPhrases and matchWeight', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${fixtures.concernId}/mapping`,
        headers: auth(tokens.adminAll),
        payload: { matchPhrases: ['sad', 'low mood'], matchWeight: 5 },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ matchPhrases: string[]; matchWeight: number }>(response);
      expect(body.matchPhrases).toEqual(['sad', 'low mood']);
      expect(body.matchWeight).toBe(5);
    });

    it('a nonexistent concern id is 404 CONCERN_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${randomUUID()}/mapping`,
        headers: auth(tokens.adminAll),
        payload: { matchWeight: 1 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('*** SPLIT PERMISSION PROVEN *** CONCERNS_MANAGE alone cannot touch the mapping — 403, even though the same admin can PATCH general fields', async () => {
      const generalPatch = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${fixtures.concernId}`,
        headers: auth(tokens.adminConcernManageOnly),
        payload: { name: 'Renamed by CONCERNS_MANAGE-only admin' },
      });
      expect(generalPatch.statusCode).toBe(200);

      const mappingPatch = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${fixtures.concernId}/mapping`,
        headers: auth(tokens.adminConcernManageOnly),
        payload: { matchWeight: 9 },
      });
      expect(mappingPatch.statusCode).toBe(403);
      expect(payload<{ code: string }>(mappingPatch).code).toBe('PERMISSION_DENIED');
    });

    it('matchWeight out of smallint range (> 32767) is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/concerns/${fixtures.concernId}/mapping`,
        headers: auth(tokens.adminAll),
        payload: { matchWeight: 999_999 },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });
});
