/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR THE MCP MODULE. ***
 *
 * Two very different surfaces, both tested here through `app.inject()`
 * against the real application:
 *
 *   1. `McpAdminController` (`/api/admin/mcp/clients`) — an ordinary REST
 *      admin CRUD, exactly like every other `*-admin.controller.ts` in this
 *      codebase: `@AccountType('admin')` + `@RequirePermission`. Tested in
 *      full below.
 *
 *   2. `McpController` (`POST /api/mcp`) — NOT a normal REST endpoint.
 *      `@Public()` + `McpClientGuard` handle a completely different
 *      authentication scheme (a static, scrypt-verified API key, never a
 *      JWT), and on success the handler calls `reply.hijack()` and hands the
 *      raw socket to an MCP JSON-RPC (Streamable HTTP) transport — the
 *      platform's normal `{ success, data }` envelope and
 *      `ResponseInterceptor` never apply to a successful call at all. This
 *      file therefore tests exactly what the task brief calls for testing on
 *      a non-REST protocol surface: the AUTH AND RATE-LIMIT BOUNDARY, which
 *      is entirely enforced by `McpClientGuard` BEFORE the handler (and
 *      before any hijack) and so still answers in the platform's ordinary
 *      envelope with a real HTTP status. A genuinely authenticated,
 *      under-limit call is deliberately NOT driven end to end here — that
 *      would mean asserting on a live JSON-RPC/SSE exchange with the MCP SDK
 *      transport, which is a different protocol's own concern, not this
 *      module's HTTP boundary.
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
import { mcpClientsTable } from '../../schema/mcp-clients.schema';
import { mcpRequestAttemptsTable } from '../../schema/mcp-request-attempts.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { IdentityTokenService } from '../identity/identity-token.service';
import { MCP_CONFIG_KEYS } from './mcp.constants';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  adminMcpReadId: string; // mcp.read only
  adminMcpManageId: string; // mcp.manage only
  adminNoPermId: string;
  patientId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9191${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` }).returning({ id: adminsTable.id });
    return row.id;
  }
  const adminMcpReadId = await makeAdmin('MCP Admin Read');
  const adminMcpManageId = await makeAdmin('MCP Admin Manage');
  const adminNoPermId = await makeAdmin('MCP Admin NoPerm');

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `MCP Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, ['mcp.read', 'mcp.manage']));
  const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (idByKey.size !== 2) throw new Error(`Expected mcp.read/mcp.manage to be seeded — found ${idByKey.size}/2.`);
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminMcpReadId, permissionId: idByKey.get('mcp.read')! });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminMcpManageId, permissionId: idByKey.get('mcp.manage')! });

  return { runId, adminMcpReadId, adminMcpManageId, adminNoPermId, patientId: patient.id };
}

async function teardown(db: Database, fixtures: Fixtures, createdClientIds: readonly string[]): Promise<void> {
  const adminIds = [fixtures.adminMcpReadId, fixtures.adminMcpManageId, fixtures.adminNoPermId];

  await db.delete(mcpRequestAttemptsTable).where(inArray(mcpRequestAttemptsTable.mcpClientId, [...createdClientIds]));
  await db.delete(mcpClientsTable).where(inArray(mcpClientsTable.id, [...createdClientIds]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, adminIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  // Only ever deletes the key THIS file wrote — `mcp.enabled` does not exist by default (see `MCP_CONFIG_FALLBACKS`), so removing it restores the untouched, disabled-by-default state for every other suite.
  await db.delete(appConfigTable).where(eq(appConfigTable.key, MCP_CONFIG_KEYS.ENABLED));
}

/* -------------------------------------------------------------------------- */

describe('MCP module — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let appConfig: AppConfigService;
  let adminMcpReadToken: string;
  let adminMcpManageToken: string;
  let adminNoPermToken: string;
  let patientToken: string;
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    appConfig = app.get(AppConfigService);
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    adminMcpReadToken = (await tokenService.mintTokenPair('admin', fixtures.adminMcpReadId, 0)).accessToken;
    adminMcpManageToken = (await tokenService.mintTokenPair('admin', fixtures.adminMcpManageId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures, createdClientIds);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function createClient(name: string, scopes: string[] = ['list_service_catalogue']): Promise<{ id: string; plaintextKey: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/mcp/clients',
      headers: auth(adminMcpManageToken),
      payload: { name, scopes },
    });
    expect(res.statusCode).toBe(201);
    const body = payload<{ client: { id: string }; plaintextKey: string }>(res);
    createdClientIds.push(body.client.id);
    return { id: body.client.id, plaintextKey: body.plaintextKey };
  }

  /* ====================================================================== */
  /* Admin CRUD — /api/admin/mcp/clients                                     */
  /* ====================================================================== */

  describe('admin client CRUD — permission-gated on mcp.read / mcp.manage', () => {
    it('GET list/get: 403 without mcp.read, 200 with it', async () => {
      const { id } = await createClient(`endpoint-list-${fixtures.runId}`);

      const noPermList = await app.inject({ method: 'GET', url: '/api/admin/mcp/clients', headers: auth(adminNoPermToken) });
      expect(noPermList.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPermList).code).toBe('PERMISSION_DENIED');

      const withPermList = await app.inject({ method: 'GET', url: '/api/admin/mcp/clients', headers: auth(adminMcpReadToken) });
      expect(withPermList.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(withPermList).map((c) => c.id)).toContain(id);

      const withPermGet = await app.inject({ method: 'GET', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpReadToken) });
      expect(withPermGet.statusCode).toBe(200);
      // No key material of any kind on the read projection.
      expect(withPermGet.json()).not.toEqual(expect.objectContaining({ hashedKey: expect.anything() }));

      const notFound = await app.inject({ method: 'GET', url: `/api/admin/mcp/clients/${randomUUID()}`, headers: auth(adminMcpReadToken) });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('MCP_CLIENT_NOT_FOUND');
    });

    it('POST create: 403 without mcp.manage; with it, the plaintext key is returned ONCE and starts with mcp_', async () => {
      const noPerm = await app.inject({
        method: 'POST',
        url: '/api/admin/mcp/clients',
        headers: auth(adminMcpReadToken),
        payload: { name: `should-not-be-created-${fixtures.runId}` },
      });
      expect(noPerm.statusCode).toBe(403);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/mcp/clients',
        headers: auth(adminMcpManageToken),
        payload: { name: `endpoint-create-${fixtures.runId}`, scopes: ['list_service_catalogue', 'list_doctors'] },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{ client: { id: string; scopes: string[] }; plaintextKey: string }>(res);
      expect(body.plaintextKey).toMatch(/^mcp_/);
      expect(body.client.scopes).toEqual(['list_service_catalogue', 'list_doctors']);
      createdClientIds.push(body.client.id);
    });

    it('a duplicate name is refused 409; an unknown scope (tool name) is refused 400', async () => {
      const name = `endpoint-dup-${fixtures.runId}`;
      await createClient(name);
      const dup = await app.inject({ method: 'POST', url: '/api/admin/mcp/clients', headers: auth(adminMcpManageToken), payload: { name } });
      expect(dup.statusCode).toBe(409);
      expect(payload<{ code: string }>(dup).code).toBe('MCP_CLIENT_NAME_TAKEN');

      const badScope = await app.inject({
        method: 'POST',
        url: '/api/admin/mcp/clients',
        headers: auth(adminMcpManageToken),
        payload: { name: `endpoint-badscope-${fixtures.runId}`, scopes: ['not_a_real_tool_name'] },
      });
      expect(badScope.statusCode).toBe(400);
      expect(payload<{ code: string }>(badScope).code).toBe('MCP_UNKNOWN_SCOPE');
    });

    it('creating with no scopes at all is allowed and fails closed (empty array, not every tool)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/mcp/clients',
        headers: auth(adminMcpManageToken),
        payload: { name: `endpoint-noscopes-${fixtures.runId}` },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{ client: { id: string; scopes: string[] } }>(res);
      expect(body.client.scopes).toEqual([]);
      createdClientIds.push(body.client.id);
    });

    it('validation: an empty name is refused 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/mcp/clients', headers: auth(adminMcpManageToken), payload: { name: '' } });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH: 403 without mcp.manage; with it, deactivating truly revokes the key at the auth boundary', async () => {
      await ensureMcpEnabled();
      const { id, plaintextKey } = await createClient(`endpoint-revoke-${fixtures.runId}`);

      const stillWorks = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${plaintextKey}` }, payload: {} });
      expect(stillWorks.statusCode).not.toBe(401);

      const noPerm = await app.inject({ method: 'PATCH', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpReadToken), payload: { isActive: false } });
      expect(noPerm.statusCode).toBe(403);

      const deactivated = await app.inject({ method: 'PATCH', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpManageToken), payload: { isActive: false } });
      expect(deactivated.statusCode).toBe(200);
      expect(payload<{ isActive: boolean }>(deactivated).isActive).toBe(false);

      const revoked = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${plaintextKey}` }, payload: {} });
      expect(revoked.statusCode).toBe(401);
      expect(payload<{ code: string }>(revoked).code).toBe('MCP_UNAUTHENTICATED');
    });

    it('PATCH on an unknown id 404s; renaming to a taken name is refused 409', async () => {
      const notFound = await app.inject({ method: 'PATCH', url: `/api/admin/mcp/clients/${randomUUID()}`, headers: auth(adminMcpManageToken), payload: { name: 'x' } });
      expect(notFound.statusCode).toBe(404);

      const nameA = `endpoint-rename-a-${fixtures.runId}`;
      const nameB = `endpoint-rename-b-${fixtures.runId}`;
      await createClient(nameA);
      const { id: idB } = await createClient(nameB);
      const clash = await app.inject({ method: 'PATCH', url: `/api/admin/mcp/clients/${idB}`, headers: auth(adminMcpManageToken), payload: { name: nameA } });
      expect(clash.statusCode).toBe(409);
      expect(payload<{ code: string }>(clash).code).toBe('MCP_CLIENT_NAME_TAKEN');
    });

    it('DELETE: 403 without mcp.manage; with it, the client is gone (404 after)', async () => {
      const { id } = await createClient(`endpoint-delete-${fixtures.runId}`);

      const noPerm = await app.inject({ method: 'DELETE', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpReadToken) });
      expect(noPerm.statusCode).toBe(403);

      const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpManageToken) });
      expect(deleted.statusCode).toBe(204);

      const after = await app.inject({ method: 'GET', url: `/api/admin/mcp/clients/${id}`, headers: auth(adminMcpReadToken) });
      expect(after.statusCode).toBe(404);
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/mcp/clients' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/mcp/clients', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* POST /api/mcp — the transport auth/rate-limit boundary                  */
  /* ====================================================================== */

  async function ensureMcpEnabled(): Promise<void> {
    await db
      .insert(appConfigTable)
      .values({ key: MCP_CONFIG_KEYS.ENABLED, value: true })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value: true } });
    appConfig.invalidate(MCP_CONFIG_KEYS.ENABLED);
  }

  describe('POST /api/mcp — McpClientGuard: disabled / unauthenticated / revoked / rate-limited', () => {
    it('*** mcp.enabled defaults to false, and the WHOLE surface answers 503 MCP_DISABLED before any auth is even checked ***', async () => {
      await db.delete(appConfigTable).where(eq(appConfigTable.key, MCP_CONFIG_KEYS.ENABLED));
      appConfig.invalidate(MCP_CONFIG_KEYS.ENABLED);

      const noAuthAtAll = await app.inject({ method: 'POST', url: '/api/mcp', payload: {} });
      expect(noAuthAtAll.statusCode).toBe(503);
      expect(payload<{ code: string }>(noAuthAtAll).code).toBe('MCP_DISABLED');

      const evenWithAValidLookingHeader = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: 'Bearer mcp_whatever' },
        payload: {},
      });
      expect(evenWithAValidLookingHeader.statusCode).toBe(503);
    });

    it('once enabled: no Authorization header is 401; a well-formed but unknown key is 401; a syntactically random key is 401 — one code for all three', async () => {
      await ensureMcpEnabled();

      const noHeader = await app.inject({ method: 'POST', url: '/api/mcp', payload: {} });
      expect(noHeader.statusCode).toBe(401);
      expect(payload<{ code: string }>(noHeader).code).toBe('MCP_UNAUTHENTICATED');

      const unknownKey = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer mcp_${randomUUID()}` }, payload: {} });
      expect(unknownKey.statusCode).toBe(401);
      expect(payload<{ code: string }>(unknownKey).code).toBe('MCP_UNAUTHENTICATED');

      const garbage = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer not-even-shaped-like-a-key' }, payload: {} });
      expect(garbage.statusCode).toBe(401);
    });

    it('a real, active client key authenticates past the guard (rejected only by rate limiting/further down the stack, never 401)', async () => {
      await ensureMcpEnabled();
      const { plaintextKey } = await createClient(`endpoint-auth-ok-${fixtures.runId}`);

      const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${plaintextKey}` }, payload: {} });
      // Never a 401/503 — whatever it answers next is the MCP protocol's own concern, out of scope here.
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(503);
    });

    it('*** exhausting mcp.rate_limit.max_requests_per_window (120, the compiled-in fallback) is refused 429, and only after authentication succeeded ***', async () => {
      await ensureMcpEnabled();
      const { id, plaintextKey } = await createClient(`endpoint-ratelimit-${fixtures.runId}`);

      await db.insert(mcpRequestAttemptsTable).values(Array.from({ length: 120 }, () => ({ mcpClientId: id })));

      const throttled = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${plaintextKey}` }, payload: {} });
      expect(throttled.statusCode).toBe(429);
      const body = payload<{ code: string; retryAfterSeconds: number }>(throttled);
      expect(body.code).toBe('MCP_RATE_LIMITED');
      expect(typeof body.retryAfterSeconds).toBe('number');

      // A DIFFERENT client's own budget is untouched — the limit is per-client.
      const { plaintextKey: otherKey } = await createClient(`endpoint-ratelimit-other-${fixtures.runId}`);
      const otherClientRes = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${otherKey}` }, payload: {} });
      expect(otherClientRes.statusCode).not.toBe(429);

      // An unauthenticated attempt against the throttled key's prefix territory is still 401, never 429 — rate limiting is strictly after authentication.
      const wrongKeySameClient = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer mcp_totallywrongkeyvalue000000000000000000000' }, payload: {} });
      expect(wrongKeySameClient.statusCode).toBe(401);
    });
  });
});
