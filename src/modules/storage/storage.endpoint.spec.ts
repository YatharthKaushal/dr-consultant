/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR M-XX STORAGE (ADMIN SURFACE). ***
 *
 * `modules/storage` exposes exactly one controller — `StorageAdminController`
 * — a thin, PATCH-only admin CRUD over `storage_providers`. There is no
 * patient/doctor-facing HTTP surface at all: everything else in this module
 * (`StorageFacade`, `StorageRotationService`, the S3/Cloudinary adapters) is
 * consumed by OTHER modules (`modules/document`) through DI, never through a
 * route of its own. This file is therefore the entire HTTP surface this
 * module has to test.
 *
 * *** EXACTLY TWO ROWS ALWAYS EXIST — `s3` AND `cloudinary` — SEEDED ONCE. ***
 * There is no POST/DELETE (`storage-providers.schema.ts`'s own comment: an
 * admin can PATCH `config`/`isActive`/`priority`, never create or remove a
 * provider). So every mutating test here PATCHes one of the two REAL, SHARED
 * rows this dev database already has — every such test captures the row's
 * current state first and restores it immediately after asserting, exactly
 * as `search.endpoint.spec.ts` does for `search.max_results`.
 *
 * Uses the same `app.inject()` + `IdentityTokenService.mintTokenPair`
 * mechanism `app.e2e.integration.spec.ts` documents as sanctioned.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env.local`,
 * fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { storageProvidersTable } from '../../schema/storage-providers.schema';
import { IdentityTokenService } from '../identity/identity-token.service';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  adminReaderId: string; // storage.read only
  adminManagerId: string; // storage.manage only
  adminNoPermId: string;
  patientId: string; // only used to prove the account-type gate
  s3Id: string;
  cloudinaryId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9192${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` }).returning({ id: adminsTable.id });
    return row.id;
  }
  const adminReaderId = await makeAdmin('Storage Admin Reader');
  const adminManagerId = await makeAdmin('Storage Admin Manager');
  const adminNoPermId = await makeAdmin('Storage Admin NoPerm');

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Storage Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, ['storage.read', 'storage.manage']));
  const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (idByKey.size !== 2) throw new Error(`Expected storage.read/storage.manage to be seeded — found ${idByKey.size}/2.`);
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminReaderId, permissionId: idByKey.get('storage.read')! });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManagerId, permissionId: idByKey.get('storage.manage')! });

  const providerRows = await db.select({ id: storageProvidersTable.id, provider: storageProvidersTable.provider }).from(storageProvidersTable);
  const s3 = providerRows.find((row) => row.provider === 's3');
  const cloudinary = providerRows.find((row) => row.provider === 'cloudinary');
  if (!s3 || !cloudinary) {
    throw new Error(`Expected exactly the s3/cloudinary storage_providers rows to be seeded — found: ${providerRows.map((r) => r.provider).join(', ')}.`);
  }

  return { runId, adminReaderId, adminManagerId, adminNoPermId, patientId: patient.id, s3Id: s3.id, cloudinaryId: cloudinary.id };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [fixtures.adminReaderId, fixtures.adminManagerId, fixtures.adminNoPermId];
  await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, adminIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
}

/* -------------------------------------------------------------------------- */

describe('Storage admin — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let adminReaderToken: string;
  let adminManagerToken: string;
  let adminNoPermToken: string;
  let patientToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    adminReaderToken = (await tokenService.mintTokenPair('admin', fixtures.adminReaderId, 0)).accessToken;
    adminManagerToken = (await tokenService.mintTokenPair('admin', fixtures.adminManagerId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
    // Only used to prove the account-type gate — this route never reads patient data.
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /* ====================================================================== */
  /* GET /admin/storage/providers, GET /admin/storage/providers/:id          */
  /* ====================================================================== */

  describe('GET providers — permission-gated on storage.read', () => {
    it('403 without the permission (even holding storage.manage), 200 with it, and both seeded providers are present', async () => {
      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/storage/providers', headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const managerOnly = await app.inject({ method: 'GET', url: '/api/admin/storage/providers', headers: auth(adminManagerToken) });
      expect(managerOnly.statusCode).toBe(403);

      const withRead = await app.inject({ method: 'GET', url: '/api/admin/storage/providers', headers: auth(adminReaderToken) });
      expect(withRead.statusCode).toBe(200);
      const providers = payload<Array<{ id: string; provider: string }>>(withRead);
      expect(providers.map((p) => p.provider).sort()).toEqual(['cloudinary', 's3']);
      // `storageKey`/credentials are never on this row at all (env-only) — nothing secret to assert is absent beyond confirming the explicit field list.
      expect(providers.every((p) => 'config' in p && 'isActive' in p && 'priority' in p)).toBe(true);
    });

    it('GET providers/:id: 200 for a real id, 404 for an unknown one, 400 for a malformed one', async () => {
      const found = await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(adminReaderToken) });
      expect(found.statusCode).toBe(200);
      expect(payload<{ provider: string }>(found).provider).toBe('s3');

      const notFound = await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${randomUUID()}`, headers: auth(adminReaderToken) });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('STORAGE_PROVIDER_NOT_FOUND');

      const malformed = await app.inject({ method: 'GET', url: '/api/admin/storage/providers/not-a-uuid', headers: auth(adminReaderToken) });
      expect(malformed.statusCode).toBe(400);
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/storage/providers' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/storage/providers', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* PATCH /admin/storage/providers/:id                                      */
  /* ====================================================================== */

  describe('PATCH providers/:id — permission-gated on storage.manage', () => {
    it('403 without the permission (even holding storage.read); nothing is written', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminReaderToken),
        payload: { priority: 999 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('updates priority on the s3 row, and restores it immediately — a real, shared production row', async () => {
      const before = payload<{ priority: number }>(
        await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(adminReaderToken) }),
      );

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { priority: 12345 },
      });
      expect(updated.statusCode).toBe(200);
      expect(payload<{ priority: number }>(updated).priority).toBe(12345);

      const auditRows = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, fixtures.s3Id));
      expect(auditRows.some((row) => row.actorId === fixtures.adminManagerId && row.action === 'update')).toBe(true);

      const restored = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { priority: before.priority },
      });
      expect(payload<{ priority: number }>(restored).priority).toBe(before.priority);
    });

    it('updates and restores config on the s3 row (config REPLACES wholesale, per its own documented semantics)', async () => {
      const before = payload<{ config: { bucket?: string; region?: string; endpoint?: string } }>(
        await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(adminReaderToken) }),
      ).config;

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { config: { bucket: `endpoint-test-bucket-${fixtures.runId}`, region: 'ap-south-1' } },
      });
      expect(updated.statusCode).toBe(200);
      expect(payload<{ config: { bucket: string } }>(updated).config.bucket).toBe(`endpoint-test-bucket-${fixtures.runId}`);

      const restored = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { config: before },
      });
      expect(payload<{ config: unknown }>(restored).config).toEqual(before);
    });

    it('a config key that does not belong to the target provider is refused 400, and nothing is written', async () => {
      const before = payload<{ config: unknown }>(
        await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(adminReaderToken) }),
      ).config;

      // `cloudName` belongs to the cloudinary row, not s3.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { config: { cloudName: 'should-not-be-accepted' } },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('STORAGE_PROVIDER_CONFIG_INVALID');

      const after = payload<{ config: unknown }>(
        await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(adminReaderToken) }),
      ).config;
      expect(after).toEqual(before);

      // Symmetric: `bucket` (s3-only) is refused on the cloudinary row.
      const reverse = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.cloudinaryId}`,
        headers: auth(adminManagerToken),
        payload: { config: { bucket: 'should-not-be-accepted-either' } },
      });
      expect(reverse.statusCode).toBe(400);
      expect(payload<{ code: string }>(reverse).code).toBe('STORAGE_PROVIDER_CONFIG_INVALID');
    });

    it('an empty PATCH body is a genuine no-op: 200 with the row unchanged, and no audit row is written', async () => {
      const before = payload<{ priority: number; updatedAt: string }>(
        await app.inject({ method: 'GET', url: `/api/admin/storage/providers/${fixtures.cloudinaryId}`, headers: auth(adminReaderToken) }),
      );
      const auditCountBefore = (await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, fixtures.cloudinaryId))).length;

      const res = await app.inject({ method: 'PATCH', url: `/api/admin/storage/providers/${fixtures.cloudinaryId}`, headers: auth(adminManagerToken), payload: {} });
      expect(res.statusCode).toBe(200);
      expect(payload<{ priority: number }>(res).priority).toBe(before.priority);

      const auditCountAfter = (await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, fixtures.cloudinaryId))).length;
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('validation: an endpoint URL missing a protocol (SSRF-shaped input) is refused 400 before the service runs', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { config: { endpoint: 'not-a-real-url-at-all' } },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('validation: priority above the smallint ceiling is refused 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${fixtures.s3Id}`,
        headers: auth(adminManagerToken),
        payload: { priority: 999_999 },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('PATCH on an unknown id 404s', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/storage/providers/${randomUUID()}`,
        headers: auth(adminManagerToken),
        payload: { priority: 1 },
      });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('STORAGE_PROVIDER_NOT_FOUND');
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'PATCH', url: `/api/admin/storage/providers/${fixtures.s3Id}`, payload: { priority: 1 } });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'PATCH', url: `/api/admin/storage/providers/${fixtures.s3Id}`, headers: auth(patientToken), payload: { priority: 1 } });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });
});
