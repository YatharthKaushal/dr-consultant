/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR THE AI GATEWAY (ADMIN SURFACE). ***
 *
 * `modules/ai` exposes exactly one controller — `AiAdminController`
 * (`/api/admin/ai`), consumed internally by `modules/search` (via
 * `SEARCH_AI_PORT` -> `AiFacade`) rather than exposing anything to a
 * patient/doctor directly. This file is therefore that controller's entire
 * HTTP surface: agent-profile CRUD and agent-credential CRUD, both
 * permission-gated (`ai.read` / `ai.manage`), through `app.inject()` against
 * the real application.
 *
 * *** THE ONE LIVE-PROBE ROUTE, `POST .../credentials/:id/test`, NEVER
 * REACHES A REAL THIRD-PARTY LLM. *** It is a genuine, real completion call
 * by design (`agent-credential.service.ts`'s own doc comment: "a REAL
 * structured-output call, not a ping"), which this suite honours by pointing
 * the test credential's profile at `baseUrl: http://127.0.0.1:1` — a port
 * nothing listens on, so the SAME real code path (`openai_compatible`
 * adapter -> real `fetch` -> real failure classification) runs and fails
 * FAST on a local connection refusal, never touching an external network or
 * spending anything. This is the same spirit as `search.endpoint.spec.ts`'s
 * AI tests, adapted for a route whose entire job is to make one real call.
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
import { agentCredentialsTable } from '../../schema/agent-credentials.schema';
import { agentProfilesTable } from '../../schema/agent-profiles.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
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
  adminAiReadId: string; // ai.read only
  adminAiManageId: string; // ai.manage only
  adminNoPermId: string;
  patientId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9190${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` }).returning({ id: adminsTable.id });
    return row.id;
  }
  const adminAiReadId = await makeAdmin('AI Admin Read');
  const adminAiManageId = await makeAdmin('AI Admin Manage');
  const adminNoPermId = await makeAdmin('AI Admin NoPerm');

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `AI Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, ['ai.read', 'ai.manage']));
  const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (idByKey.size !== 2) throw new Error(`Expected ai.read/ai.manage to be seeded — found ${idByKey.size}/2.`);
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminAiReadId, permissionId: idByKey.get('ai.read')! });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminAiManageId, permissionId: idByKey.get('ai.manage')! });

  return { runId, adminAiReadId, adminAiManageId, adminNoPermId, patientId: patient.id };
}

async function teardown(db: Database, fixtures: Fixtures, createdProfileIds: readonly string[], createdCredentialIds: readonly string[]): Promise<void> {
  const adminIds = [fixtures.adminAiReadId, fixtures.adminAiManageId, fixtures.adminNoPermId];

  await db.delete(agentCredentialsTable).where(inArray(agentCredentialsTable.id, [...createdCredentialIds]));
  await db.delete(agentProfilesTable).where(inArray(agentProfilesTable.id, [...createdProfileIds]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, adminIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
}

/* -------------------------------------------------------------------------- */

describe('AI gateway admin — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let adminAiReadToken: string;
  let adminAiManageToken: string;
  let adminNoPermToken: string;
  let patientToken: string;
  const createdProfileIds: string[] = [];
  const createdCredentialIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    adminAiReadToken = (await tokenService.mintTokenPair('admin', fixtures.adminAiReadId, 0)).accessToken;
    adminAiManageToken = (await tokenService.mintTokenPair('admin', fixtures.adminAiManageId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures, createdProfileIds, createdCredentialIds);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function createProfile(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/ai/profiles',
      headers: auth(adminAiManageToken),
      payload: { name: `endpoint-profile-${randomUUID()}`, provider: 'openai_compatible', model: 'test-model', ...overrides },
    });
    expect(res.statusCode).toBe(201);
    const body = payload<{ id: string }>(res);
    createdProfileIds.push(body.id);
    return body;
  }

  /* ====================================================================== */
  /* Profiles                                                                 */
  /* ====================================================================== */

  describe('agent profile CRUD — permission-gated on ai.read / ai.manage', () => {
    it('GET list/get: 403 without ai.read, 200 with it', async () => {
      const { id } = await createProfile();

      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/ai/profiles', headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const list = await app.inject({ method: 'GET', url: '/api/admin/ai/profiles', headers: auth(adminAiReadToken) });
      expect(list.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(list).map((p) => p.id)).toContain(id);

      const get = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiReadToken) });
      expect(get.statusCode).toBe(200);

      const notFound = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${randomUUID()}`, headers: auth(adminAiReadToken) });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('PROFILE_NOT_FOUND');
    });

    it('POST create: 403 without ai.manage; validation on provider/baseUrl; duplicate name is refused 409', async () => {
      const noPerm = await app.inject({
        method: 'POST',
        url: '/api/admin/ai/profiles',
        headers: auth(adminAiReadToken),
        payload: { name: 'x', provider: 'openai_compatible', model: 'm' },
      });
      expect(noPerm.statusCode).toBe(403);

      const badProvider = await app.inject({
        method: 'POST',
        url: '/api/admin/ai/profiles',
        headers: auth(adminAiManageToken),
        payload: { name: `endpoint-badprovider-${fixtures.runId}`, provider: 'not_a_real_provider', model: 'm' },
      });
      expect(badProvider.statusCode).toBe(400);
      expect(payload<{ code: string }>(badProvider).code).toBe('VALIDATION_FAILED');

      const badUrl = await app.inject({
        method: 'POST',
        url: '/api/admin/ai/profiles',
        headers: auth(adminAiManageToken),
        payload: { name: `endpoint-badurl-${fixtures.runId}`, provider: 'openai_compatible', model: 'm', baseUrl: 'not-a-real-url' },
      });
      expect(badUrl.statusCode).toBe(400);

      const name = `endpoint-dup-${fixtures.runId}`;
      await createProfile({ name });
      const dup = await app.inject({
        method: 'POST',
        url: '/api/admin/ai/profiles',
        headers: auth(adminAiManageToken),
        payload: { name, provider: 'anthropic', model: 'claude' },
      });
      expect(dup.statusCode).toBe(409);
      expect(payload<{ code: string }>(dup).code).toBe('PROFILE_NAME_TAKEN');
    });

    it('PATCH: 403 without ai.manage; renaming to a taken name 409s; unknown id 404s', async () => {
      const { id } = await createProfile();
      const noPerm = await app.inject({ method: 'PATCH', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiReadToken), payload: { model: 'x' } });
      expect(noPerm.statusCode).toBe(403);

      const updated = await app.inject({ method: 'PATCH', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiManageToken), payload: { model: 'updated-model' } });
      expect(updated.statusCode).toBe(200);
      expect(payload<{ model: string }>(updated).model).toBe('updated-model');

      const takenName = `endpoint-taken-${fixtures.runId}`;
      await createProfile({ name: takenName });
      const clash = await app.inject({ method: 'PATCH', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiManageToken), payload: { name: takenName } });
      expect(clash.statusCode).toBe(409);

      const notFound = await app.inject({ method: 'PATCH', url: `/api/admin/ai/profiles/${randomUUID()}`, headers: auth(adminAiManageToken), payload: { model: 'x' } });
      expect(notFound.statusCode).toBe(404);
    });

    it('DELETE: 403 without ai.manage; refused 409 while credentials exist, succeeds once they are removed', async () => {
      const { id } = await createProfile();
      const credRes = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${id}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'primary', key: 'sk-fake-endpoint-test-key-0000000000' },
      });
      expect(credRes.statusCode).toBe(201);
      const credential = payload<{ id: string }>(credRes);
      createdCredentialIds.push(credential.id);

      const noPerm = await app.inject({ method: 'DELETE', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiReadToken) });
      expect(noPerm.statusCode).toBe(403);

      const blocked = await app.inject({ method: 'DELETE', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiManageToken) });
      expect(blocked.statusCode).toBe(409);
      const blockedBody = payload<{ code: string; credentialCount: number }>(blocked);
      expect(blockedBody.code).toBe('PROFILE_HAS_CREDENTIALS');
      expect(blockedBody.credentialCount).toBe(1);

      const deleteCredential = await app.inject({ method: 'DELETE', url: `/api/admin/ai/credentials/${credential.id}`, headers: auth(adminAiManageToken) });
      expect(deleteCredential.statusCode).toBe(204);
      createdCredentialIds.splice(createdCredentialIds.indexOf(credential.id), 1);

      const nowAllowed = await app.inject({ method: 'DELETE', url: `/api/admin/ai/profiles/${id}`, headers: auth(adminAiManageToken) });
      expect(nowAllowed.statusCode).toBe(204);
      createdProfileIds.splice(createdProfileIds.indexOf(id), 1);
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/ai/profiles' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/ai/profiles', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* Credentials                                                              */
  /* ====================================================================== */

  describe('agent credential CRUD — the plaintext key never leaves this boundary', () => {
    it('POST create: 403 without ai.manage; unknown profileId 404s; the response NEVER carries key material', async () => {
      const { id: profileId } = await createProfile();

      const noPerm = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiReadToken),
        payload: { label: 'x', key: 'sk-fake-key-00000000000000000' },
      });
      expect(noPerm.statusCode).toBe(403);

      const badProfile = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${randomUUID()}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'x', key: 'sk-fake-key-00000000000000000' },
      });
      expect(badProfile.statusCode).toBe(404);
      expect(payload<{ code: string }>(badProfile).code).toBe('PROFILE_NOT_FOUND');

      const plaintextKey = 'sk-super-secret-plaintext-key-0000';
      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'primary', key: plaintextKey },
      });
      expect(created.statusCode).toBe(201);
      const body = payload<{ id: string; maskedKey: string; keyLast4: string }>(created);
      createdCredentialIds.push(body.id);
      expect(body.keyLast4).toBe(plaintextKey.slice(-4));
      expect(body.maskedKey).not.toContain(plaintextKey);
      expect(JSON.stringify(created.json())).not.toContain(plaintextKey);

      const [row] = await db.select().from(agentCredentialsTable).where(eq(agentCredentialsTable.id, body.id));
      expect(row.encryptedKey).not.toBe(plaintextKey);
      expect(row.encryptedKey).not.toContain(plaintextKey);
    });

    it('a duplicate (profileId, label) pair is refused 409; a too-short key is refused 400', async () => {
      const { id: profileId } = await createProfile();
      await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'dup-label', key: 'sk-fake-key-00000000000000000' },
      }).then((res) => createdCredentialIds.push(payload<{ id: string }>(res).id));

      const dup = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'dup-label', key: 'sk-another-fake-key-000000000' },
      });
      expect(dup.statusCode).toBe(409);
      expect(payload<{ code: string }>(dup).code).toBe('CREDENTIAL_LABEL_TAKEN');

      const tooShort = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'short-key', key: 'short' },
      });
      expect(tooShort.statusCode).toBe(400);
    });

    it('GET list: 403 without ai.read, 200 with it, no key material on any row', async () => {
      const { id: profileId } = await createProfile();
      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'list-me', key: 'sk-list-me-fake-key-00000000' },
      });
      createdCredentialIds.push(payload<{ id: string }>(created).id);

      const noPerm = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${profileId}/credentials`, headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);

      const list = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${profileId}/credentials`, headers: auth(adminAiReadToken) });
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toMatch(/encryptedKey/i);
    });

    it('PATCH: 403 without ai.manage; omitting `key` leaves the stored key untouched; unknown id 404s', async () => {
      const { id: profileId } = await createProfile();
      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'rotate-me', key: 'sk-original-fake-key-0000000' },
      });
      const credentialId = payload<{ id: string; keyLast4: string }>(created).id;
      createdCredentialIds.push(credentialId);
      const [before] = await db.select({ encryptedKey: agentCredentialsTable.encryptedKey }).from(agentCredentialsTable).where(eq(agentCredentialsTable.id, credentialId));

      const noPerm = await app.inject({ method: 'PATCH', url: `/api/admin/ai/credentials/${credentialId}`, headers: auth(adminAiReadToken), payload: { label: 'x' } });
      expect(noPerm.statusCode).toBe(403);

      const relabelled = await app.inject({ method: 'PATCH', url: `/api/admin/ai/credentials/${credentialId}`, headers: auth(adminAiManageToken), payload: { label: 'renamed' } });
      expect(relabelled.statusCode).toBe(200);
      expect(payload<{ label: string }>(relabelled).label).toBe('renamed');

      const [after] = await db.select({ encryptedKey: agentCredentialsTable.encryptedKey }).from(agentCredentialsTable).where(eq(agentCredentialsTable.id, credentialId));
      expect(after.encryptedKey).toBe(before.encryptedKey);

      const notFound = await app.inject({ method: 'PATCH', url: `/api/admin/ai/credentials/${randomUUID()}`, headers: auth(adminAiManageToken), payload: { label: 'x' } });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('CREDENTIAL_NOT_FOUND');
    });

    it('DELETE: 403 without ai.manage; succeeds, then 404s on re-read', async () => {
      const { id: profileId } = await createProfile();
      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'delete-me', key: 'sk-delete-me-fake-key-0000000' },
      });
      const credentialId = payload<{ id: string }>(created).id;

      const noPerm = await app.inject({ method: 'DELETE', url: `/api/admin/ai/credentials/${credentialId}`, headers: auth(adminAiReadToken) });
      expect(noPerm.statusCode).toBe(403);

      const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/ai/credentials/${credentialId}`, headers: auth(adminAiManageToken) });
      expect(deleted.statusCode).toBe(204);

      const rows = await db.select().from(agentCredentialsTable).where(eq(agentCredentialsTable.id, credentialId));
      expect(rows).toHaveLength(0);
    });

    /**
     * *** THE LIVE PROBE — REAL CODE, LOCAL UNREACHABLE HOST, NO EXTERNAL CALL. ***
     * See the file header for why `baseUrl: http://127.0.0.1:1` is what makes
     * this both a genuine exercise of `adminTest`'s real HTTP-calling code
     * path and something that can never reach a real vendor.
     */
    it('POST .../test: 403 without ai.manage; with it, answers 200 { ok: false, failureKind } rather than throwing, and never touches the network', async () => {
      const { id: profileId } = await createProfile({ baseUrl: 'http://127.0.0.1:1' });
      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/ai/profiles/${profileId}/credentials`,
        headers: auth(adminAiManageToken),
        payload: { label: 'probe-me', key: 'sk-probe-me-fake-key-0000000' },
      });
      const credentialId = payload<{ id: string }>(created).id;
      createdCredentialIds.push(credentialId);

      const noPerm = await app.inject({ method: 'POST', url: `/api/admin/ai/credentials/${credentialId}/test`, headers: auth(adminAiReadToken) });
      expect(noPerm.statusCode).toBe(403);

      const res = await app.inject({ method: 'POST', url: `/api/admin/ai/credentials/${credentialId}/test`, headers: auth(adminAiManageToken) });
      expect(res.statusCode).toBe(200);
      const body = payload<{ ok: boolean; failureKind: string | null; detail: string | null }>(res);
      expect(body.ok).toBe(false);
      expect(body.failureKind).not.toBeNull();
    }, 30_000);

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const { id: profileId } = await createProfile();
      const anon = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${profileId}/credentials` });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: `/api/admin/ai/profiles/${profileId}/credentials`, headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });
});
