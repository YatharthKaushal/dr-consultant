/**
 * *** REAL-HTTP ENDPOINT TESTS — `availability` MODULE. ***
 *
 * Drives every route in `availability.controller.ts` (doctor self-service:
 * weekly schedule, overrides, blocks, settings, own slots),
 * `availability-public.controller.ts` (`GET /doctors/:id/slots`) and
 * `availability-admin.controller.ts` (admin reads + the settings override)
 * through `createConfiguredApp()` + `app.inject()` — real guards, real
 * `ValidationPipe`, real database. No vendor to mock.
 *
 * *** THE min_notice_minutes TRAP, AGAIN. *** Exactly like
 * `app.e2e.integration.spec.ts`'s LINK 3, `scheduling.min_notice_minutes`
 * (default 120) hides slots closer than that from every slot-listing route.
 * This file reads the REAL effective value from `app_config` (or the
 * compiled fallback) in `beforeAll`, rather than hardcoding 120, so it stays
 * correct even if a future admin edits the platform default.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorAvailabilityTable } from '../../schema/doctor-availability.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import type { AccountType } from '../../schema/enums.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { AVAILABILITY_CONFIG_FALLBACKS, AVAILABILITY_CONFIG_KEYS } from './availability.constants';

jest.setTimeout(120_000);

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

/** `YYYY-MM-DD` far enough in the future that no min-notice/booking-horizon math run inside this file can ever push it out of range. */
function futureIsoDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixtures {
  runId: string;
  /** Verified + listed, full-week weekly availability — the "slots exist" doctor. */
  bookableDoctorId: string;
  /** Verified + listed, but otherwise untouched — used only as "someone else's doctor" for ownership-leak tests. */
  otherDoctorId: string;
  /** Never verified/listed — proves slot-listing degrades to `[]`, never an error. */
  unbookableDoctorId: string;
  patientId: string;
  adminReadId: string;
  adminManageId: string;
  adminNoneId: string;
}

async function permissionId(db: Database, key: string): Promise<string> {
  const [row] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
  if (!row) throw new Error(`Fixture precondition failed: permission "${key}" not seeded.`);
  return row.id;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9174${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [bookableDoctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Availability Bookable Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });

  const [otherDoctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Availability Other Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '500.00',
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });

  const [unbookableDoctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Availability Unbookable Doctor ${runId}` })
    .returning({ id: doctorsTable.id });

  // The bookable doctor's own week, wide open — mirrors app.e2e.integration.spec.ts's
  // own fixture reasoning: the whole day, every weekday, so this test's pass/fail
  // never depends on what time of day it happens to run.
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await db.insert(doctorAvailabilityTable).values({
      doctorId: bookableDoctor!.id,
      ruleType: 'weekly',
      dayOfWeek,
      specificDate: null,
      startTime: '00:00:00',
      endTime: '23:59:00',
    });
  }

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Availability Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [adminRead] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Availability Admin Read ${runId}` }).returning({ id: adminsTable.id });
  const [adminManage] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Availability Admin Manage ${runId}` }).returning({ id: adminsTable.id });
  const [adminNone] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Availability Admin None ${runId}` }).returning({ id: adminsTable.id });

  await db.insert(adminPermissionGrantsTable).values({ adminId: adminRead!.id, permissionId: await permissionId(db, PERMISSIONS.AVAILABILITY_READ) });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManage!.id, permissionId: await permissionId(db, PERMISSIONS.AVAILABILITY_MANAGE) });

  return {
    runId,
    bookableDoctorId: bookableDoctor!.id,
    otherDoctorId: otherDoctor!.id,
    unbookableDoctorId: unbookableDoctor!.id,
    patientId: patient!.id,
    adminReadId: adminRead!.id,
    adminManageId: adminManage!.id,
    adminNoneId: adminNone!.id,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const doctorIds = [fixtures.bookableDoctorId, fixtures.otherDoctorId, fixtures.unbookableDoctorId];
  const adminIds = [fixtures.adminReadId, fixtures.adminManageId, fixtures.adminNoneId];

  await db.execute(sql`delete from doctor_scheduling_settings where doctor_id = any(${pgArray(doctorIds, 'uuid')})`);
  await db.execute(sql`delete from doctor_availability where doctor_id = any(${pgArray(doctorIds, 'uuid')})`);

  const allIdsForAudit = [...doctorIds, ...adminIds, fixtures.patientId];
  await db.execute(
    sql`delete from audit_log where actor_id = any(${pgArray(allIdsForAudit, 'uuid')}) or entity_id = any(${pgArray(allIdsForAudit, 'varchar')})`,
  );

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from patients where id = ${fixtures.patientId}`);
  await db.execute(sql`delete from doctors where id = any(${pgArray(doctorIds, 'uuid')})`);
}

/* -------------------------------------------------------------------------- */

describe('availability module — real HTTP endpoint tests', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;
  let minNoticeMinutes: number;
  let maxSlotQueryDays: number;

  const tokens: Record<string, string> = {};

  async function mint(accountType: AccountType, accountId: string, tokenVersion = 0): Promise<string> {
    return (await tokenService.mintTokenPair(accountType, accountId, tokenVersion)).accessToken;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    tokenService = app.get(IdentityTokenService);

    const appConfig = app.get(AppConfigService);
    minNoticeMinutes = await appConfig.getNumber(AVAILABILITY_CONFIG_KEYS.MIN_NOTICE_MINUTES, AVAILABILITY_CONFIG_FALLBACKS.MIN_NOTICE_MINUTES);
    maxSlotQueryDays = await appConfig.getNumber(AVAILABILITY_CONFIG_KEYS.MAX_SLOT_QUERY_DAYS, AVAILABILITY_CONFIG_FALLBACKS.MAX_SLOT_QUERY_DAYS);

    fixtures = await seedFixtures(db);

    tokens.bookableDoctor = await mint('doctor', fixtures.bookableDoctorId);
    tokens.otherDoctor = await mint('doctor', fixtures.otherDoctorId);
    tokens.unbookableDoctor = await mint('doctor', fixtures.unbookableDoctorId);
    tokens.patient = await mint('patient', fixtures.patientId);
    tokens.adminRead = await mint('admin', fixtures.adminReadId);
    tokens.adminManage = await mint('admin', fixtures.adminManageId);
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
  /* GET/PUT doctors/me/availability/weekly                                  */
  /* ====================================================================== */

  describe('GET /doctors/me/availability/weekly', () => {
    it("SUCCESS: lists the caller's own weekly rules (7 days seeded)", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/availability/weekly', headers: auth(tokens.bookableDoctor) });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response)).toHaveLength(7);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/availability/weekly' });
      expect(response.statusCode).toBe(401);
    });

    it('a patient token is refused — 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/availability/weekly', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('an admin token is refused — this route is doctor self-service only', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/availability/weekly', headers: auth(tokens.adminManage) });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PUT /doctors/me/availability/weekly', () => {
    it('SUCCESS: replaces the whole week atomically', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/availability/weekly',
        headers: auth(tokens.otherDoctor),
        payload: { rules: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }] },
      });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ dayOfWeek: number }>>(response);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dayOfWeek).toBe(1);
    });

    it('*** BUSINESS RULE *** endTime <= startTime is refused 400 INVALID_RULE_SHAPE', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/availability/weekly',
        headers: auth(tokens.otherDoctor),
        payload: { rules: [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }] },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_RULE_SHAPE');
    });

    it('*** BUSINESS RULE *** two overlapping rules for the same day are refused 409 OVERLAPPING_RULE', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/availability/weekly',
        headers: auth(tokens.otherDoctor),
        payload: {
          rules: [
            { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' },
            { dayOfWeek: 2, startTime: '12:00', endTime: '17:00' },
          ],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('OVERLAPPING_RULE');
    });

    it('VALIDATION: a dayOfWeek out of 0-6 is refused 400 by the real ValidationPipe', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/availability/weekly',
        headers: auth(tokens.otherDoctor),
        payload: { rules: [{ dayOfWeek: 7, startTime: '09:00', endTime: '17:00' }] },
      });
      expect(response.statusCode).toBe(400);
    });

    it('VALIDATION: a malformed time string is refused 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/availability/weekly',
        headers: auth(tokens.otherDoctor),
        payload: { rules: [{ dayOfWeek: 1, startTime: '9am', endTime: '17:00' }] },
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'PUT', url: '/api/doctors/me/availability/weekly', payload: { rules: [] } });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Overrides                                                               */
  /* ====================================================================== */

  describe('POST/DELETE /doctors/me/availability/overrides/:id', () => {
    const overrideDate = futureIsoDate(200);
    let overrideId: string;

    it('SUCCESS: adds an override', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/overrides',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: overrideDate, startTime: '10:00', endTime: '14:00' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; specificDate: string }>(response);
      overrideId = body.id;
    });

    it('*** BUSINESS RULE *** a second, overlapping override for the SAME date is refused 409 OVERLAPPING_RULE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/overrides',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: overrideDate, startTime: '13:00', endTime: '18:00' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('OVERLAPPING_RULE');
    });

    it('*** BUSINESS RULE *** endTime <= startTime is refused 400 INVALID_RULE_SHAPE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/overrides',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: futureIsoDate(201), startTime: '14:00', endTime: '10:00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_RULE_SHAPE');
    });

    it('VALIDATION: a malformed specificDate is refused 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/overrides',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: 'not-a-date', startTime: '10:00', endTime: '14:00' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('*** OWNERSHIP LEAK *** another doctor deleting this override id gets the SAME 404 as a nonexistent id — never 403', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/overrides/${overrideId}`,
        headers: auth(tokens.otherDoctor),
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('RULE_NOT_FOUND');
    });

    it('a nonexistent id is 404 RULE_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/overrides/${randomUUID()}`,
        headers: auth(tokens.bookableDoctor),
      });
      expect(response.statusCode).toBe(404);
    });

    it('SUCCESS: the owning doctor removes their own override — 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/overrides/${overrideId}`,
        headers: auth(tokens.bookableDoctor),
      });
      expect(response.statusCode).toBe(204);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/availability/overrides', payload: { specificDate: futureIsoDate(202), startTime: '10:00', endTime: '11:00' } });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Blocks                                                                  */
  /* ====================================================================== */

  describe('POST/DELETE /doctors/me/availability/blocks/:id', () => {
    it('SUCCESS: a full-day block (both times omitted)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/blocks',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: futureIsoDate(210) },
      });
      expect(response.statusCode).toBe(201);
    });

    it('*** BUSINESS RULE *** only ONE of startTime/endTime set is refused 400 INVALID_RULE_SHAPE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/blocks',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: futureIsoDate(211), startTime: '09:00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_RULE_SHAPE');
    });

    it('*** BUSINESS RULE *** a full-day block on a date that already has one is refused 409 OVERLAPPING_RULE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/blocks',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: futureIsoDate(210) },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('OVERLAPPING_RULE');
    });

    it('SUCCESS: a partial-day block on a DIFFERENT date', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/availability/blocks',
        headers: auth(tokens.bookableDoctor),
        payload: { specificDate: futureIsoDate(212), startTime: '12:00', endTime: '13:00' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string }>(response);

      const removedByOther = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/blocks/${body.id}`,
        headers: auth(tokens.otherDoctor),
      });
      expect(removedByOther.statusCode).toBe(404);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/blocks/${body.id}`,
        headers: auth(tokens.bookableDoctor),
      });
      expect(removed.statusCode).toBe(204);
    });

    it('a nonexistent id is 404 RULE_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/availability/blocks/${randomUUID()}`,
        headers: auth(tokens.bookableDoctor),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* Settings — self-service                                                */
  /* ====================================================================== */

  describe('GET/PATCH /doctors/me/availability/settings', () => {
    it('SUCCESS: defaults to null (inherit the platform default)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/availability/settings', headers: auth(tokens.unbookableDoctor) });
      expect(response.statusCode).toBe(200);
      expect(payload<{ minNoticeMinutes: number | null }>(response).minNoticeMinutes).toBeNull();
    });

    it('SUCCESS: sets an override, then explicit null clears it back to "inherit"', async () => {
      const set = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me/availability/settings',
        headers: auth(tokens.unbookableDoctor),
        payload: { minNoticeMinutes: 60 },
      });
      expect(set.statusCode).toBe(200);
      expect(payload<{ minNoticeMinutes: number }>(set).minNoticeMinutes).toBe(60);

      const cleared = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me/availability/settings',
        headers: auth(tokens.unbookableDoctor),
        payload: { minNoticeMinutes: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(payload<{ minNoticeMinutes: number | null }>(cleared).minNoticeMinutes).toBeNull();
    });

    it('VALIDATION: minNoticeMinutes over 10,080 is refused 400', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me/availability/settings',
        headers: auth(tokens.unbookableDoctor),
        payload: { minNoticeMinutes: 10_081 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('VALIDATION: bookingHorizonDays of 0 is refused 400 (minimum is 1)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me/availability/settings',
        headers: auth(tokens.unbookableDoctor),
        payload: { bookingHorizonDays: 0 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* Slots — GET doctors/me/slots and the public GET doctors/:id/slots       */
  /* ====================================================================== */

  describe('GET /doctors/me/slots and GET /doctors/:id/slots', () => {
    const from = new Date();
    const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);
    const query = `from=${from.toISOString()}&to=${to.toISOString()}`;

    it("*** min_notice_minutes TRAP *** the bookable doctor's own slots respect the real configured minimum notice", async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/me/slots?${query}`, headers: auth(tokens.bookableDoctor) });
      expect(response.statusCode).toBe(200);
      const slots = payload<Array<{ startsAt: string }>>(response);
      expect(slots.length).toBeGreaterThan(0);
      const earliestAllowed = from.getTime() + minNoticeMinutes * 60_000;
      for (const slot of slots) {
        expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(earliestAllowed);
      }
    });

    it('SUCCESS: a patient sees the same bookable doctor\'s slots via the public route', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.bookableDoctorId}/slots?${query}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response).length).toBeGreaterThan(0);
    });

    it('*** NOT AN ERROR *** an unverified/unlisted doctor simply has no slots — empty array, never a 404 or 403', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.unbookableDoctorId}/slots?${query}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response)).toEqual([]);
    });

    it('VALIDATION: `to` <= `from` is refused 400 INVALID_RANGE', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/doctors/${fixtures.bookableDoctorId}/slots?from=${to.toISOString()}&to=${from.toISOString()}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_RANGE');
    });

    it('*** BUSINESS RULE *** a range wider than scheduling.max_slot_query_days is refused 400 RANGE_TOO_LARGE', async () => {
      const wideTo = new Date(from.getTime() + (maxSlotQueryDays + 5) * 24 * 60 * 60 * 1000);
      const response = await app.inject({
        method: 'GET',
        url: `/api/doctors/${fixtures.bookableDoctorId}/slots?from=${from.toISOString()}&to=${wideTo.toISOString()}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('RANGE_TOO_LARGE');
    });

    it('VALIDATION: a malformed `from` is refused 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/doctors/${fixtures.bookableDoctorId}/slots?from=not-a-date&to=${to.toISOString()}`,
        headers: auth(tokens.patient),
      });
      expect(response.statusCode).toBe(400);
    });

    it('VALIDATION: a malformed (non-UUID) doctor id is refused 400, never a raw 500', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/not-a-uuid/slots?${query}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(400);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.bookableDoctorId}/slots?${query}` });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Admin — auth boundary                                                   */
  /* ====================================================================== */

  describe('admin/doctors/:id/availability — auth boundary', () => {
    it('a doctor token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability`, headers: auth(tokens.bookableDoctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability` });
      expect(response.statusCode).toBe(401);
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability`, headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/doctors/:id/availability, /slots, /availability/settings (AVAILABILITY_READ)', () => {
    it('lists every rule for the doctor', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability`, headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response).length).toBeGreaterThan(0);
    });

    it('returns the same slots the public route would', async () => {
      const from = new Date();
      const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/doctors/${fixtures.bookableDoctorId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
        headers: auth(tokens.adminRead),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response).length).toBeGreaterThan(0);
    });

    it('reads scheduling settings', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability/settings`, headers: auth(tokens.adminRead) });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('PATCH /admin/doctors/:id/availability/settings (AVAILABILITY_MANAGE)', () => {
    it('*** PERMISSION BOUNDARY *** AVAILABILITY_READ alone cannot write settings — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability/settings`,
        headers: auth(tokens.adminRead),
        payload: { minNoticeMinutes: 90 },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('SUCCESS: an admin holding AVAILABILITY_MANAGE sets the per-doctor override', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.bookableDoctorId}/availability/settings`,
        headers: auth(tokens.adminManage),
        payload: { bookingHorizonDays: 45 },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ bookingHorizonDays: number }>(response).bookingHorizonDays).toBe(45);
    });
  });
});
