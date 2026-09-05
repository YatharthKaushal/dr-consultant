/**
 * *** AUDIT ADMIN OVER REAL HTTP. ***
 *
 * `audit-admin.controller.ts` serves four routes across three independently
 * gated permissions (`audit.read`, `audit.export`, `config.read`/
 * `config.manage`) — this file drives every one of them through
 * `createConfiguredApp()` + `app.inject()`, the same mechanism
 * `app.e2e.integration.spec.ts` established, so the real
 * `JwtAuthGuard` -> `AccountTypeGuard` -> `PermissionGuard` chain runs.
 *
 * *** WHY TOKENS ARE MINTED DIRECTLY. *** See `governance.endpoint.spec.ts`'s
 * identical note — `IdentityTokenService.mintTokenPair` produces a real,
 * signed JWT verified through the exact same `resolveAccessToken` path
 * `JwtAuthGuard` calls; proving the OTP sign-in SCREEN itself is
 * `app.e2e.integration.spec.ts`'s job, not this file's.
 *
 * *** THE CENTREPIECE: `ipAddress` MUST NEVER APPEAR IN A RESPONSE BODY. ***
 * `audit_log.ip_address` is a real column (`inet`), and this module's whole
 * privacy argument (`audit-mapper.util.ts#toAuditLogView`'s header) is that
 * no read path this module serves ever echoes it back. Reading the code and
 * trusting it is exactly the kind of claim this round exists to verify
 * independently — so the fixture below INSERTS a row with a real, distinct
 * IP address directly (bypassing `AuditService.write`, which never accepts
 * one), then both `GET .../log` and `GET .../export` are asserted not by
 * checking a typed field, but by `JSON.stringify`-ing/grepping the RAW
 * response text for that exact IP string. A field the code forgot to map
 * would still show up in a raw text search; a typed-field check could not
 * catch that.
 *
 * *** THE RETENTION CONFIG IS GLOBAL, SHARED, MUTABLE STATE — NOT PER-RUN
 * FIXTURE DATA. *** `audit.retention_days` lives in the single shared
 * `app_config` table, read by the real retention sweep and potentially other
 * worktrees' own tests. The config test reads the value BEFORE mutating it
 * and restores it in a `finally`, so this file never leaves the shared
 * database in a different configuration than it found it.
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
import { doctorsTable } from '../../schema/doctors.schema';
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

interface Fixtures {
  runId: string;
  adminFullId: string; // holds audit.read, audit.export, config.read, config.manage
  adminNoneId: string;
  doctorId: string;
  /** A distinct, unambiguous `entity_type` so this run's own rows can be filtered out of a table shared with every other worktree/dev row. */
  entityType: string;
  auditLogIds: number[];
  fixtureIp: string;
  originalRetentionDays: number | null;
}

async function grant(db: Database, adminId: string, key: string): Promise<void> {
  const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
  if (!permission) throw new Error(`Permission "${key}" is not seeded — has identity.seed.ts run against this database?`);
  await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permission.id });
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const entityType = `audit_endpoint_test_${runId}`;
  const fixtureIp = '203.0.113.77'; // TEST-NET-3 (RFC 5737) — guaranteed never a real caller.

  const [adminFull] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `AUD${runId}1`.slice(0, 16), fullName: `Audit Admin (all perms) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `AUD${runId}2`.slice(0, 16), fullName: `Audit Admin (no perms) ${runId}` })
    .returning({ id: adminsTable.id });
  // A real row is required — `resolveAccessToken` re-reads the account and
  // requires it to exist and be active before the guard chain even reaches
  // `AccountTypeGuard`, so a WRONG_ACCOUNT_TYPE probe needs a genuine doctor.
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: `AUD${runId}9`.slice(0, 16), fullName: `Audit Doctor (wrong-type probe) ${runId}` })
    .returning({ id: doctorsTable.id });

  for (const key of [
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.CONFIG_MANAGE,
  ]) {
    await grant(db, adminFull.id, key);
  }

  // *** INSERTED DIRECTLY, BYPASSING `AuditService.write` (WHICH NEVER
  // ACCEPTS AN IP). *** This is what makes the "ipAddress never appears in a
  // response" assertion a real proof rather than a tautology: the row
  // genuinely carries one, and only the read path's own mapping keeps it out.
  const rows = await db.execute(
    sql`insert into audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata, ip_address)
        values ('admin', ${adminFull.id}, 'read', ${entityType}, ${`fixture-${runId}`}, ${JSON.stringify({ note: 'fixture row' })}::jsonb, ${fixtureIp}::inet)
        returning id`,
  );
  const auditLogIds = (rows.rows as Array<{ id: number }>).map((row) => row.id);

  // Read the CURRENT global retention config — restored verbatim in teardown.
  const originalRow = await db.execute(sql`select value from app_config where key = 'audit.retention_days'`);
  const originalRetentionDays =
    (originalRow.rows as Array<{ value: unknown }>)[0]?.value !== undefined
      ? Number((originalRow.rows as Array<{ value: unknown }>)[0].value)
      : null;

  return {
    runId,
    adminFullId: adminFull.id,
    adminNoneId: adminNone.id,
    doctorId: doctor.id,
    entityType,
    auditLogIds,
    fixtureIp,
    originalRetentionDays,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  await db.execute(sql`delete from audit_log where id = any(${sql.raw(`array[${fixtures.auditLogIds.join(',') || 'null'}]::bigint[]`)})`);
  await db
    .delete(adminPermissionGrantsTable)
    .where(inArray(adminPermissionGrantsTable.adminId, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(adminsTable).where(inArray(adminsTable.id, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));

  // Restore the global retention config to exactly what this run found, so a
  // shared database is never left in a different state than it started in.
  if (fixtures.originalRetentionDays === null) {
    await db.execute(sql`delete from app_config where key = 'audit.retention_days'`);
  } else {
    await db.execute(
      sql`update app_config set value = ${sql.raw(String(fixtures.originalRetentionDays))} where key = 'audit.retention_days'`,
    );
  }
}

describe('*** AUDIT ADMIN — every route, real HTTP ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: { adminFull: string; adminNone: string; doctor: string };

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'admin' | 'doctor', id: string) => (await tokenService.mintTokenPair(accountType, id, 0)).accessToken;

    tokens = {
      adminFull: await mint('admin', fixtures.adminFullId),
      adminNone: await mint('admin', fixtures.adminNoneId),
      doctor: await mint('doctor', fixtures.doctorId),
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

  function authBoundary(url: string, requiredPermissionAdmin: 'adminNone' = 'adminNone') {
    it('401s with no token', async () => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('403s for the right token but wrong account type (doctor)', async () => {
      const response = await app.inject({ method: 'GET', url, headers: bearer(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('403s for an admin missing the required permission', async () => {
      const response = await app.inject({ method: 'GET', url, headers: bearer(tokens[requiredPermissionAdmin]) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  }

  /* ====================================================================== */
  /* GET /admin/audit/log — audit.read                                      */
  /* ====================================================================== */

  describe('GET /api/admin/audit/log', () => {
    authBoundary('/api/admin/audit/log');

    it('200s for an admin holding audit.read, finds this run\'s fixture row by entityType, and NEVER echoes ipAddress anywhere in the raw response body', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/audit/log?entityType=${fixtures.entityType}`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);

      const rawBody = response.payload;
      expect(rawBody).not.toContain(fixtures.fixtureIp);

      const rows = payload<Array<{ id: number; entityType: string; actorId: string }>>(response);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((row) => row.entityType === fixtures.entityType)).toBe(true);
      // Structural proof, not just a substring check: the typed shape has no key for it at all.
      expect(Object.keys(rows[0])).not.toContain('ipAddress');
    });

    it('400s on a DTO validation failure (from is not ISO 8601)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/audit/log?from=not-a-date',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* GET /admin/audit/export — audit.export (gated SEPARATELY from audit.read) */
  /* ====================================================================== */

  describe('GET /api/admin/audit/export', () => {
    it('403s for an admin holding audit.read but NOT audit.export — the two permissions are genuinely independent', async () => {
      // Grant ONLY audit.read to a fresh admin, to prove export is not implied by read.
      const [readOnlyAdmin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `AUD${fixtures.runId}3`.slice(0, 16), fullName: `Audit Admin (read only) ${fixtures.runId}` })
        .returning({ id: adminsTable.id });
      await grant(db, readOnlyAdmin.id, PERMISSIONS.AUDIT_READ);
      const tokenService = app.get(IdentityTokenService);
      const readOnlyToken = (await tokenService.mintTokenPair('admin', readOnlyAdmin.id, 0)).accessToken;

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/admin/audit/export',
          headers: bearer(readOnlyToken),
        });
        expect(response.statusCode).toBe(403);
        expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
      } finally {
        await db.delete(adminPermissionGrantsTable).where(eq(adminPermissionGrantsTable.adminId, readOnlyAdmin.id));
        await db.delete(adminsTable).where(eq(adminsTable.id, readOnlyAdmin.id));
      }
    });

    authBoundary('/api/admin/audit/export');

    it('200s as a real CSV attachment for an admin holding audit.export, contains the fixture row by entity_id, and NEVER contains the raw ipAddress', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/audit/export?entityType=${fixtures.entityType}`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');

      const csv = response.payload;
      expect(csv).not.toContain(fixtures.fixtureIp);
      expect(csv).toContain(`fixture-${fixtures.runId}`);
      const header = csv.replace(/^﻿/, '').split('\r\n')[0];
      expect(header.split(',')).not.toContain('ip_address');
    });
  });

  /* ====================================================================== */
  /* GET/PUT /admin/audit/config — config.read / config.manage              */
  /* ====================================================================== */

  describe('GET /api/admin/audit/config', () => {
    authBoundary('/api/admin/audit/config');

    it('200s for an admin holding config.read', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/audit/config',
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ retentionDays: number; purgeEligibleActions: string[] }>(response);
      expect(typeof body.retentionDays).toBe('number');
      expect(Array.isArray(body.purgeEligibleActions)).toBe(true);
    });

    it('403s for an admin holding audit.read/audit.export but not config.read — config is gated SEPARATELY from the log permissions', async () => {
      const [logOnlyAdmin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `AUD${fixtures.runId}4`.slice(0, 16), fullName: `Audit Admin (log only) ${fixtures.runId}` })
        .returning({ id: adminsTable.id });
      await grant(db, logOnlyAdmin.id, PERMISSIONS.AUDIT_READ);
      await grant(db, logOnlyAdmin.id, PERMISSIONS.AUDIT_EXPORT);
      const tokenService = app.get(IdentityTokenService);
      const logOnlyToken = (await tokenService.mintTokenPair('admin', logOnlyAdmin.id, 0)).accessToken;

      try {
        const response = await app.inject({ method: 'GET', url: '/api/admin/audit/config', headers: bearer(logOnlyToken) });
        expect(response.statusCode).toBe(403);
      } finally {
        await db.delete(adminPermissionGrantsTable).where(eq(adminPermissionGrantsTable.adminId, logOnlyAdmin.id));
        await db.delete(adminsTable).where(eq(adminsTable.id, logOnlyAdmin.id));
      }
    });
  });

  describe('PUT /api/admin/audit/config', () => {
    it('401s with no token', async () => {
      const response = await app.inject({ method: 'PUT', url: '/api/admin/audit/config', payload: { retentionDays: 365 } });
      expect(response.statusCode).toBe(401);
    });

    it('403s for an admin holding config.read but not config.manage — read and manage are independent', async () => {
      const [readOnlyAdmin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `AUD${fixtures.runId}5`.slice(0, 16), fullName: `Audit Admin (config read only) ${fixtures.runId}` })
        .returning({ id: adminsTable.id });
      await grant(db, readOnlyAdmin.id, PERMISSIONS.CONFIG_READ);
      const tokenService = app.get(IdentityTokenService);
      const readOnlyToken = (await tokenService.mintTokenPair('admin', readOnlyAdmin.id, 0)).accessToken;

      try {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/admin/audit/config',
          headers: bearer(readOnlyToken),
          payload: { retentionDays: 365 },
        });
        expect(response.statusCode).toBe(403);
      } finally {
        await db.delete(adminPermissionGrantsTable).where(eq(adminPermissionGrantsTable.adminId, readOnlyAdmin.id));
        await db.delete(adminsTable).where(eq(adminsTable.id, readOnlyAdmin.id));
      }
    });

    it('400s on a DTO validation failure (retentionDays below the non-zero floor of 30)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/audit/config',
        headers: bearer(tokens.adminFull),
        payload: { retentionDays: 10 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('200s for an admin holding config.manage, actually persists the new value, and GET reflects it back', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/audit/config',
        headers: bearer(tokens.adminFull),
        payload: { retentionDays: 365 },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ retentionDays: number }>(response);
      expect(body.retentionDays).toBe(365);

      const getResponse = await app.inject({
        method: 'GET',
        url: '/api/admin/audit/config',
        headers: bearer(tokens.adminFull),
      });
      expect(payload<{ retentionDays: number }>(getResponse).retentionDays).toBe(365);

      // Real SQL, not the service's own return value.
      const row = await db.execute(sql`select value from app_config where key = 'audit.retention_days'`);
      expect(Number((row.rows as Array<{ value: unknown }>)[0].value)).toBe(365);
    });
  });
});
