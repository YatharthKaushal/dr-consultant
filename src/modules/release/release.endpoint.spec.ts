/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR THE RELEASE MODULE. ***
 *
 * Two routes: `GET /api/app/release-status` (public — no token) and
 * `GET`/`PUT /api/admin/release-policy` (admin, `release.manage`). The stored
 * policy is captured before and restored after any write, same discipline
 * `storage.endpoint.spec.ts` uses for its shared rows.
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
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { RELEASE_CONFIG_KEYS } from './release.constants';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  adminManagerId: string;
  adminNoPermId: string;
  patientId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9192${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` }).returning({ id: adminsTable.id });
    return row.id;
  }
  const adminManagerId = await makeAdmin('Release Admin Manager');
  const adminNoPermId = await makeAdmin('Release Admin NoPerm');

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Release Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [perm] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, 'release.manage'));
  if (!perm) throw new Error('Expected release.manage to be seeded.');
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManagerId, permissionId: perm.id });

  return { runId, adminManagerId, adminNoPermId, patientId: patient.id };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [fixtures.adminManagerId, fixtures.adminNoPermId];
  await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, adminIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
}

describe('Release module — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let adminManagerToken: string;
  let adminNoPermToken: string;
  let patientToken: string;
  let storedPolicyBeforeSuite: unknown;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const [row] = await db.select({ value: appConfigTable.value }).from(appConfigTable).where(eq(appConfigTable.key, RELEASE_CONFIG_KEYS.POLICY));
    storedPolicyBeforeSuite = row?.value;

    const tokenService = app.get(IdentityTokenService);
    adminManagerToken = (await tokenService.mintTokenPair('admin', fixtures.adminManagerId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (storedPolicyBeforeSuite === undefined) {
        await db.delete(appConfigTable).where(eq(appConfigTable.key, RELEASE_CONFIG_KEYS.POLICY));
      } else {
        await db
          .insert(appConfigTable)
          .values({ key: RELEASE_CONFIG_KEYS.POLICY, value: storedPolicyBeforeSuite })
          .onConflictDoUpdate({ target: appConfigTable.key, set: { value: storedPolicyBeforeSuite } });
      }
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  const entry = { minimumSupportedVersion: '1.0.0', latestVersion: '1.2.0', storeUrl: 'https://store', message: 'update' };
  const fullPolicy = { patient: { ios: entry, android: entry }, doctor: { ios: entry, android: entry } };

  describe('GET /api/app/release-status — public, no token required', () => {
    it('200s with no Authorization header at all', async () => {
      await app.inject({ method: 'PUT', url: '/api/admin/release-policy', headers: auth(adminManagerToken), payload: fullPolicy });

      const res = await app.inject({ method: 'GET', url: '/api/app/release-status?app=patient&platform=android&version=0.5.0' });
      expect(res.statusCode).toBe(200);
      const body = payload<{ updateRequired: boolean; updateAvailable: boolean; latestVersion: string }>(res);
      expect(body.updateRequired).toBe(true);
      expect(body.latestVersion).toBe('1.2.0');
    });

    it('400s on a malformed version, and on an unrecognised app/platform', async () => {
      const badVersion = await app.inject({ method: 'GET', url: '/api/app/release-status?app=patient&platform=android&version=abc' });
      expect(badVersion.statusCode).toBe(400);

      const badApp = await app.inject({ method: 'GET', url: '/api/app/release-status?app=nurse&platform=android&version=1.0.0' });
      expect(badApp.statusCode).toBe(400);
    });
  });

  describe('GET/PUT /api/admin/release-policy — gated on release.manage', () => {
    it('403 without the permission, 401 with no token, 403 wrong account type', async () => {
      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/release-policy', headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const anon = await app.inject({ method: 'GET', url: '/api/admin/release-policy' });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/release-policy', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('PUT writes the full document, audits it, and GET reflects it back', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/admin/release-policy', headers: auth(adminManagerToken), payload: fullPolicy });
      expect(res.statusCode).toBe(200);
      expect(payload<typeof fullPolicy>(res)).toEqual(fullPolicy);

      const got = await app.inject({ method: 'GET', url: '/api/admin/release-policy', headers: auth(adminManagerToken) });
      expect(payload<typeof fullPolicy>(got)).toEqual(fullPolicy);

      const auditRows = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, RELEASE_CONFIG_KEYS.POLICY));
      expect(auditRows.some((row) => row.actorId === fixtures.adminManagerId && row.action === 'update')).toBe(true);
    });

    it('PUT rejects a malformed document; nothing is written', async () => {
      const before = payload<typeof fullPolicy>(await app.inject({ method: 'GET', url: '/api/admin/release-policy', headers: auth(adminManagerToken) }));

      const bad = { ...fullPolicy, patient: { ios: { minimumSupportedVersion: 'nope', latestVersion: '1.0.0' } } };
      const res = await app.inject({ method: 'PUT', url: '/api/admin/release-policy', headers: auth(adminManagerToken), payload: bad });
      expect(res.statusCode).toBe(400);

      const after = payload<typeof fullPolicy>(await app.inject({ method: 'GET', url: '/api/admin/release-policy', headers: auth(adminManagerToken) }));
      expect(after).toEqual(before);
    });
  });
});
