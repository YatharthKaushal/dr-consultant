/**
 * ***************************************************************************
 * *** BOOKING MODULE — REAL HTTP, REAL POSTGRES, EVERY DOCUMENTED BRANCH. ***
 * ***************************************************************************
 *
 * Every test in `booking.service.spec.ts`/`booking.facade.spec.ts` calls the
 * service directly, mocked or against a real repository. NOTHING before this
 * file has driven `POST /api/bookings` (or any of its 18 siblings) through
 * `app.inject()` — the real `ValidationPipe`, the real guard stack, the real
 * `@RequirePermission` checks. `src/app.e2e.integration.spec.ts` proves ONE
 * booking end to end as a step in a much longer chain; this file is the
 * booking module's OWN exhaustive case matrix — every route, every
 * documented error code, the auth boundary, and the 404-not-403 ownership
 * rule.
 *
 * Pattern copied wholesale from `app.e2e.integration.spec.ts`: Slide mocked,
 * `createConfiguredApp()` (never a hand-built app), `app.inject()`, the
 * `{success,data}`/`{success:false,error}` envelope unwrapped by `payload()`,
 * fixtures namespaced by a random `runId`, teardown in strict reverse-FK
 * order. Admin auth is NEW here (the e2e file never mints one): an admin
 * signs in over the same `/api/auth/otp/*` routes as everyone else, but the
 * account row must already exist — `identity.service.ts` throws
 * `ACCOUNT_NOT_FOUND_FOR_ROLE` otherwise — so the admin row (and its
 * permission grants) is seeded directly, then a real JWT is minted through
 * `IdentityTokenService#mintTokenPair`, exactly matching what a real sign-in
 * would hand back. Permissions are resolved fresh from Postgres on every
 * request (`PermissionGuard` — no permission claim on the JWT), so granting
 * `admin_permission_grants` rows here exercises the real resolver, not a stub.
 *
 * Requires a reachable Postgres (`DATABASE_URL` in `.env`/`.env.local`) with
 * `identity.seed.ts` already run at least once (for the `permissions` catalog
 * rows) — the same precondition `identity-access.listAdminIdsWithPermission.
 * integration.spec.ts` states explicitly.
 */
import { createHmac, randomUUID } from 'node:crypto';

const identifiersByRequestId = new Map<string, string>();
const slideOtpMock = {
  send: jest.fn(async ({ identifier }: { widgetId: string; identifier: string }) => {
    const requestId = `otpreq_${randomUUID()}`;
    identifiersByRequestId.set(requestId, identifier);
    return { requestId };
  }),
  retry: jest.fn(async ({ requestId }: { requestId: string }) => ({ requestId })),
  verify: jest.fn(async ({ requestId }: { requestId: string; otp: string }) => ({
    accessToken: `slide_at_${requestId}`,
  })),
  verifyToken: jest.fn(async ({ accessToken }: { accessToken: string }) => {
    const requestId = accessToken.replace(/^slide_at_/, '');
    const identifier = identifiersByRequestId.get(requestId);
    if (identifier === undefined) throw new Error(`Test mock: no Slide request for token ${accessToken}.`);
    return { verified: true, identifier, verifiedAt: new Date().toISOString() };
  }),
};

jest.mock('@synquic/slide', () => {
  const actual = jest.requireActual('@synquic/slide');
  return { ...actual, SlideClient: jest.fn().mockImplementation(() => ({ otp: slideOtpMock })) };
});

import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { concernsTable } from '../../schema/concerns.schema';
import { doctorAvailabilityTable } from '../../schema/doctor-availability.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientFilesTable } from '../../schema/patient-files.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { RazorpayClient } from '../payment/razorpay.client';
import { PAYMENT_WEBHOOK_PATH } from '../payment/payment.constants';

jest.setTimeout(120_000);

const MIN_NOTICE_MINUTES = 120;

interface Fixtures {
  runId: string;
  specialtyId: string;
  otherSpecialtyId: string;
  inactiveSpecialtyId: string;
  concernOk: string;
  concernMismatched: string;
  patientAId: string;
  patientAMobile: string;
  patientBId: string;
  patientBMobile: string;
  doctorId: string;
  doctorMobile: string;
  doctorUnbookableId: string;
  doctorUnbookableMobile: string;
  doctorZeroFeeId: string;
  doctorZeroFeeMobile: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
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

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9178${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `bk_${runId}`, name: `Booking E2E Specialty ${runId}`, isActive: true })
    .returning({ id: specialtiesTable.id });

  const [otherSpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `bk2_${runId}`, name: `Booking E2E Other Specialty ${runId}`, isActive: true })
    .returning({ id: specialtiesTable.id });

  const [inactiveSpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `bk3_${runId}`, name: `Booking E2E Inactive Specialty ${runId}`, isActive: false })
    .returning({ id: specialtiesTable.id });

  const [concernOk] = await db
    .insert(concernsTable)
    .values({ specialtyId: specialty.id, code: `concern_ok_${runId}`, name: 'Matches the booked specialty' })
    .returning({ id: concernsTable.id });

  const [concernMismatched] = await db
    .insert(concernsTable)
    .values({ specialtyId: otherSpecialty.id, code: `concern_bad_${runId}`, name: 'Belongs to a different specialty' })
    .returning({ id: concernsTable.id });

  const patientAMobile = nextPhone();
  const [patientA] = await db
    .insert(patientsTable)
    .values({ mobileNumber: patientAMobile, fullName: `Booking E2E Patient A ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const patientBMobile = nextPhone();
  const [patientB] = await db
    .insert(patientsTable)
    .values({ mobileNumber: patientBMobile, fullName: `Booking E2E Patient B ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const doctorMobile = nextPhone();
  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: doctorMobile,
      fullName: `Booking E2E Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const doctorUnbookableMobile = nextPhone();
  const [doctorUnbookable] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: doctorUnbookableMobile,
      fullName: `Booking E2E Unbookable Doctor ${runId}`,
      // Deliberately left at defaults: verification_status='pending', is_listed=false.
      consultationFeeInr: '500.00',
    })
    .returning({ id: doctorsTable.id });

  const doctorZeroFeeMobile = nextPhone();
  const [doctorZeroFee] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: doctorZeroFeeMobile,
      fullName: `Booking E2E Zero-fee Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '0.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctorZeroFee.id, specialtyId: specialty.id });

  for (const doctorId of [doctor.id, doctorZeroFee.id]) {
    for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
      await db.insert(doctorAvailabilityTable).values({
        doctorId,
        ruleType: 'weekly',
        dayOfWeek,
        specificDate: null,
        startTime: '00:00:00',
        endTime: '23:59:00',
      });
    }
  }

  return {
    runId,
    specialtyId: specialty.id,
    otherSpecialtyId: otherSpecialty.id,
    inactiveSpecialtyId: inactiveSpecialty.id,
    concernOk: concernOk.id,
    concernMismatched: concernMismatched.id,
    patientAId: patientA.id,
    patientAMobile,
    patientBId: patientB.id,
    patientBMobile,
    doctorId: doctor.id,
    doctorMobile,
    doctorUnbookableId: doctorUnbookable.id,
    doctorUnbookableMobile,
    doctorZeroFeeId: doctorZeroFee.id,
    doctorZeroFeeMobile,
  };
}

const postedWebhookEventIds: string[] = [];
const adminIds: string[] = [];
const patientFileIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.patientAId, fixtures.patientBId];
  const doctorIds = [fixtures.doctorId, fixtures.doctorUnbookableId, fixtures.doctorZeroFeeId];
  const patientList = pgArray(patientIds, 'uuid');
  const doctorList = pgArray(doctorIds, 'uuid');

  const consultationRows = await db.execute(
    sql`select id from consultations where patient_id = any(${patientList})`,
  );
  const consultationIds = (consultationRows.rows as Array<{ id: string }>).map((row) => row.id);
  const consultationList = pgArray(consultationIds, 'uuid');

  await db.execute(sql`update doctors set blocked_by_consultation_id = null where id = any(${doctorList})`);

  await db.execute(sql`delete from patient_files where id = any(${pgArray(patientFileIds, 'uuid')})`);

  const webhookEventList = pgArray(postedWebhookEventIds, 'varchar');
  await db.execute(
    sql`delete from payment_events where payment_id in (select id from payments where consultation_id = any(${consultationList})) or gateway_event_id = any(${webhookEventList})`,
  );
  await db.execute(
    sql`delete from refund_components where refund_id in (select id from refunds where payment_id in (select id from payments where consultation_id = any(${consultationList})))`,
  );
  await db.execute(
    sql`delete from refunds where payment_id in (select id from payments where consultation_id = any(${consultationList}))`,
  );
  await db.execute(sql`delete from payments where consultation_id = any(${consultationList})`);
  await db.execute(
    sql`delete from price_quote_components where price_quote_id in (select id from price_quotes where patient_id = any(${patientList}) or consultation_id = any(${consultationList}))`,
  );
  await db.execute(
    sql`delete from price_quotes where patient_id = any(${patientList}) or consultation_id = any(${consultationList})`,
  );
  await db.execute(sql`delete from notifications where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from safety_alerts where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from checkin_responses where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from followup_assignments where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from outbox_events where aggregate_id = any(${pgArray(consultationIds, 'varchar')})`);
  await db.execute(sql`delete from audit_log where consultation_id = any(${consultationList})`);
  await db.execute(
    sql`delete from audit_log where actor_id = any(${pgArray([...patientIds, ...doctorIds, ...adminIds], 'uuid')})`,
  );
  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...consultationIds, ...postedWebhookEventIds], 'varchar')})`,
  );

  await db.execute(sql`delete from consultations where id = any(${consultationList})`);

  await db.execute(
    sql`delete from otp_challenges where mobile_number in (${fixtures.patientAMobile}, ${fixtures.patientBMobile}, ${fixtures.doctorMobile}, ${fixtures.doctorUnbookableMobile}, ${fixtures.doctorZeroFeeMobile})`,
  );
  await db.execute(
    sql`delete from otp_request_attempts where mobile_number in (${fixtures.patientAMobile}, ${fixtures.patientBMobile}, ${fixtures.doctorMobile}, ${fixtures.doctorUnbookableMobile}, ${fixtures.doctorZeroFeeMobile})`,
  );

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);

  await db.execute(sql`delete from doctor_availability where doctor_id = any(${doctorList})`);
  await db.execute(sql`delete from doctor_specialties where doctor_id = any(${doctorList})`);
  await db.execute(sql`delete from doctors where id = any(${doctorList})`);
  await db.execute(sql`delete from patients where id = any(${patientList})`);
  await db.execute(sql`delete from concerns where id in (${fixtures.concernOk}, ${fixtures.concernMismatched})`);
  await db.execute(
    sql`delete from specialties where id in (${fixtures.specialtyId}, ${fixtures.otherSpecialtyId}, ${fixtures.inactiveSpecialtyId})`,
  );
}

/* -------------------------------------------------------------------------- */

describe('booking module — real HTTP endpoints', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let patientAToken: string;
  let patientBToken: string;
  let doctorToken: string;
  let doctorUnbookableToken: string;
  let adminReadToken: string;
  let adminManageToken: string;
  let adminNoneToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    jest.spyOn(app.get(RazorpayClient), 'createOrder').mockImplementation(async (request) => ({
      id: `order_bk_${randomUUID().slice(0, 12)}`,
      entity: 'order',
      amount: request.amount,
      amount_paid: 0,
      amount_due: request.amount,
      currency: request.currency,
      receipt: request.receipt ?? null,
      status: 'created',
      attempts: 0,
      created_at: Math.floor(Date.now() / 1000),
      notes: request.notes ?? {},
    }));

    fixtures = await seedFixtures(db);

    async function signIn(mobileNumber: string, audience: 'patient' | 'doctor'): Promise<string> {
      const requested = await app.inject({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber, audience },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);
      const verified = await app.inject({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: '123456' },
      });
      return payload<{ accessToken: string }>(verified).accessToken;
    }

    patientAToken = await signIn(fixtures.patientAMobile, 'patient');
    patientBToken = await signIn(fixtures.patientBMobile, 'patient');
    doctorToken = await signIn(fixtures.doctorMobile, 'doctor');
    doctorUnbookableToken = await signIn(fixtures.doctorUnbookableMobile, 'doctor');

    async function mintAdmin(label: string, permissionKeys: string[]): Promise<string> {
      const [admin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `+9177${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, fullName: `Booking E2E Admin ${label}` })
        .returning({ id: adminsTable.id });
      adminIds.push(admin.id);
      for (const key of permissionKeys) {
        const [permission] = await db
          .select({ id: permissionsTable.id })
          .from(permissionsTable)
          .where(eq(permissionsTable.key, key));
        if (!permission) {
          throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts first.`);
        }
        await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: permission.id });
      }
      const tokens = await app.get(IdentityTokenService).mintTokenPair('admin', admin.id, 0);
      return tokens.accessToken;
    }

    adminReadToken = await mintAdmin('read-only', [PERMISSIONS.APPOINTMENTS_READ]);
    adminManageToken = await mintAdmin('manage', [PERMISSIONS.APPOINTMENTS_READ, PERMISSIONS.APPOINTMENTS_MANAGE]);
    adminNoneToken = await mintAdmin('no-permissions', []);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                          */
  /* ---------------------------------------------------------------------- */

  async function getSlots(doctorId: string, minHoursAhead = 0): Promise<string[]> {
    const from = new Date();
    const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);
    const response = await app.inject({
      method: 'GET',
      url: `/api/doctors/${doctorId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { authorization: `Bearer ${patientAToken}` },
    });
    const slots = payload<Array<{ startsAt: string }>>(response);
    const minMs = from.getTime() + (MIN_NOTICE_MINUTES + 30 + minHoursAhead * 60) * 60_000;
    return slots.map((s) => s.startsAt).filter((startsAt) => new Date(startsAt).getTime() > minMs);
  }

  function signedWebhook(body: unknown): { raw: string; signature: string } {
    const raw = JSON.stringify(body);
    const secret = app.get(RazorpayClient).getWebhookSecret();
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  function captureBody(amountPaise: number, orderId: string): Record<string, unknown> {
    return {
      entity: 'event',
      account_id: 'acc_bk_e2e',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_bk_e2e_${randomUUID().slice(0, 12)}`,
            entity: 'payment',
            amount: amountPaise,
            currency: 'INR',
            status: 'captured',
            order_id: orderId,
            method: 'upi',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  async function payAndWaitScheduled(consultationId: string, gatewayOrderId: string, totalPayablePaise: number): Promise<void> {
    const eventId = `evt_bk_${randomUUID()}`;
    postedWebhookEventIds.push(eventId);
    const { raw, signature } = signedWebhook(captureBody(totalPayablePaise, gatewayOrderId));
    const response = await app.inject({
      method: 'POST',
      url: PAYMENT_WEBHOOK_PATH,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
      payload: raw,
    });
    expect(response.statusCode).toBe(201);

    const deadline = Date.now() + 5_000;
    let status = 'pending_payment';
    while (status !== 'scheduled' && Date.now() < deadline) {
      const row = await db.execute(sql`select status from consultations where id = ${consultationId}`);
      status = (row.rows as Array<{ status: string }>)[0].status;
      if (status !== 'scheduled') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe('scheduled');
  }

  interface BookResult {
    consultationId: string;
    gatewayOrderId: string;
    totalPayablePaise: number;
  }

  async function createBooking(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: unknown }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { statusCode: response.statusCode, body: payload(response) };
  }

  async function bookAndPay(doctorId: string, minHoursAhead = 0): Promise<BookResult> {
    const slots = await getSlots(doctorId, minHoursAhead);
    expect(slots.length).toBeGreaterThan(0);
    const { statusCode, body } = await createBooking(patientAToken, {
      doctorId,
      specialtyId: fixtures.specialtyId,
      scheduledStartAt: slots[0],
    });
    expect(statusCode).toBe(201);
    const created = body as { booking: { id: string }; payment: { gatewayOrderId: string; breakdown: { totalPayable: string } } };
    const totalPayablePaise = Math.round(Number(created.payment.breakdown.totalPayable) * 100);
    await payAndWaitScheduled(created.booking.id, created.payment.gatewayOrderId, totalPayablePaise);
    return { consultationId: created.booking.id, gatewayOrderId: created.payment.gatewayOrderId, totalPayablePaise };
  }

  /* ======================================================================== */
  /* AUTH BOUNDARY                                                             */
  /* ======================================================================== */

  describe('auth boundary', () => {
    it('POST /bookings with no token -> 401', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/bookings', payload: {} });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('POST /bookings with a doctor token -> 403 WRONG_ACCOUNT_TYPE, not a validation error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { doctorId: fixtures.doctorId, specialtyId: fixtures.specialtyId, scheduledStartAt: new Date().toISOString() },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('GET /admin/bookings with a patient token -> 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/bookings',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('GET /admin/bookings with an admin token missing appointments.read -> 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/bookings',
        headers: { authorization: `Bearer ${adminNoneToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('GET /admin/bookings with appointments.read -> 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/bookings',
        headers: { authorization: `Bearer ${adminReadToken}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('POST /admin/bookings/:id/cancel with appointments.read but not appointments.manage -> 403 PERMISSION_DENIED (checked before the resource is even looked up)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/bookings/${randomUUID()}/cancel`,
        headers: { authorization: `Bearer ${adminReadToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  /* ======================================================================== */
  /* POST /bookings — validation and whitelist                                */
  /* ======================================================================== */

  describe('POST /bookings — validation', () => {
    it('missing doctorId -> 400 VALIDATION_FAILED', async () => {
      const { statusCode, body } = await createBooking(patientAToken, {
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      });
      expect(statusCode).toBe(400);
      expect((body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('an unrecognized field (including a spoofed patientId) is silently stripped by the whitelist ValidationPipe, never honoured', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
        // Neither field exists on CreateBookingDto. If whitelist:true ever
        // regressed to allow extra fields through, this would silently take
        // effect — exactly the bug class the discountCode field was added to
        // close (see app.e2e.integration.spec.ts's LINK 4 finding).
        patientId: fixtures.patientBId,
        totalPayable: '1.00',
      });
      expect(statusCode).toBe(201);
      const created = body as { booking: { id: string; patientId: string }; payment: { breakdown: { totalPayable: string } } };
      expect(created.booking.patientId).toBe(fixtures.patientAId);
      expect(created.payment.breakdown.totalPayable).toBe('618.00');
    });
  });

  /* ======================================================================== */
  /* POST /bookings — business-rule refusals                                  */
  /* ======================================================================== */

  describe('POST /bookings — business rules', () => {
    it('SPECIALTY_NOT_BOOKABLE for an inactive specialty -> 409', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.inactiveSpecialtyId,
        scheduledStartAt: slots[0],
      });
      expect(statusCode).toBe(409);
      expect((body as { code: string }).code).toBe('SPECIALTY_NOT_BOOKABLE');
    });

    it('CONCERN_NOT_BOOKABLE when the concern belongs to a different specialty -> 400', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        concernId: fixtures.concernMismatched,
        scheduledStartAt: slots[0],
      });
      expect(statusCode).toBe(400);
      expect((body as { code: string }).code).toBe('CONCERN_NOT_BOOKABLE');
    });

    it('DOCTOR_NOT_BOOKABLE for a doctor that is not verified and listed -> 409', async () => {
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorUnbookableId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      });
      expect(statusCode).toBe(409);
      expect((body as { code: string }).code).toBe('DOCTOR_NOT_BOOKABLE');
    });

    it('DOCTOR_SPECIALTY_MISMATCH when the doctor does not practise the given specialty -> 400', async () => {
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.otherSpecialtyId,
        scheduledStartAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      });
      expect(statusCode).toBe(400);
      expect((body as { code: string }).code).toBe('DOCTOR_SPECIALTY_MISMATCH');
    });

    it('SLOT_NOT_BOOKABLE (too_soon) when the slot is inside scheduling.min_notice_minutes -> 409', async () => {
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        // 30 minutes out — well inside the 120-minute default notice window.
        scheduledStartAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      expect(statusCode).toBe(409);
      expect((body as { code: string; reason?: string }).code).toBe('SLOT_NOT_BOOKABLE');
      expect((body as { reason?: string }).reason).toBe('too_soon');
    });

    it('double-booking the same slot is refused, not silently accepted twice', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const slot = slots[0];
      const first = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slot,
      });
      expect(first.statusCode).toBe(201);

      const second = await createBooking(patientBToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slot,
      });
      expect(second.statusCode).toBe(409);
      expect(['SLOT_NOT_BOOKABLE', 'SLOT_ALREADY_TAKEN']).toContain((second.body as { code: string }).code);
    });

    it('PAYMENT_SETUP_FAILED when the doctor\'s fee is zero (Razorpay refuses a zero-value order) -> 409, never the internal pricing code', async () => {
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorZeroFeeId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      });
      expect(statusCode).toBe(409);
      // Never PRICING_ZERO_VALUE_ORDER — booking.service.ts#createBooking
      // catches every payment-port throw and rewraps it.
      expect((body as { code: string }).code).toBe('PAYMENT_SETUP_FAILED');
    });

    it('success: a full booking with intakeAnswers and a concern is priced and persisted', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { statusCode, body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        concernId: fixtures.concernOk,
        scheduledStartAt: slots[0],
        intakeAnswers: { mood: 'low', durationWeeks: 3 },
      });
      expect(statusCode).toBe(201);
      const created = body as { booking: { id: string; status: string; concernId: string | null }; payment: { gatewayOrderId: string } };
      expect(created.booking.status).toBe('pending_payment');
      expect(created.booking.concernId).toBe(fixtures.concernOk);

      const row = await db.execute(sql`select intake_answers from consultations where id = ${created.booking.id}`);
      expect((row.rows as Array<{ intake_answers: unknown }>)[0].intake_answers).toEqual({ mood: 'low', durationWeeks: 3 });
    });
  });

  /* ======================================================================== */
  /* POST /bookings/instant                                                    */
  /* ======================================================================== */

  describe('POST /bookings/instant', () => {
    it('success: creates a doctor-less, unscheduled pending_payment consultation with no payment step', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings/instant',
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { specialtyId: fixtures.specialtyId },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; status: string; mode: string; doctorId: string | null; scheduledStartAt: string | null }>(response);
      expect(body.status).toBe('pending_payment');
      expect(body.mode).toBe('instant');
      expect(body.doctorId).toBeNull();
      expect(body.scheduledStartAt).toBeNull();

      const payments = await db.execute(sql`select count(*)::int as n from payments where consultation_id = ${body.id}`);
      expect((payments.rows as Array<{ n: number }>)[0].n).toBe(0);
    });

    it('missing specialtyId -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings/instant',
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('SPECIALTY_NOT_BOOKABLE for an inactive specialty -> 409', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings/instant',
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { specialtyId: fixtures.inactiveSpecialtyId },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_BOOKABLE');
    });

    it('CONCERN_NOT_BOOKABLE for a concern in a different specialty -> 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings/instant',
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { specialtyId: fixtures.specialtyId, concernId: fixtures.concernMismatched },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('CONCERN_NOT_BOOKABLE');
    });
  });

  /* ======================================================================== */
  /* GET /bookings — list                                                      */
  /* ======================================================================== */

  describe('GET /bookings', () => {
    it('invalid scope -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/bookings?scope=sideways',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a pending_payment booking appears under scope=upcoming and disappears once cancelled (then appears under scope=past)', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const upcomingBefore = await app.inject({
        method: 'GET',
        url: '/api/bookings?scope=upcoming',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      const upcomingIds = payload<Array<{ id: string }>>(upcomingBefore).map((b) => b.id);
      expect(upcomingIds).toContain(consultationId);

      await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {},
      });

      const upcomingAfter = await app.inject({
        method: 'GET',
        url: '/api/bookings?scope=upcoming',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(payload<Array<{ id: string }>>(upcomingAfter).map((b) => b.id)).not.toContain(consultationId);

      const past = await app.inject({
        method: 'GET',
        url: '/api/bookings?scope=past',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(payload<Array<{ id: string }>>(past).map((b) => b.id)).toContain(consultationId);
    });
  });

  /* ======================================================================== */
  /* GET /bookings/quote/:doctorId                                             */
  /* ======================================================================== */

  describe('GET /bookings/quote/:doctorId', () => {
    it('bad doctorId shape -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/bookings/quote/not-a-uuid',
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a nonexistent doctor -> 409 DOCTOR_NOT_BOOKABLE', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings/quote/${randomUUID()}`,
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_NOT_BOOKABLE');
    });

    it('success, and — the load-bearing claim — a preview NEVER inserts a price_quotes row', async () => {
      const before = await db.execute(
        sql`select count(*)::int as n from price_quotes where patient_id = ${fixtures.patientAId} and doctor_id = ${fixtures.doctorId}`,
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings/quote/${fixtures.doctorId}`,
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ totalPayable: string }>(response);
      expect(body.totalPayable).toBe('618.00');

      const after = await db.execute(
        sql`select count(*)::int as n from price_quotes where patient_id = ${fixtures.patientAId} and doctor_id = ${fixtures.doctorId}`,
      );
      expect((after.rows as Array<{ n: number }>)[0].n).toBe((before.rows as Array<{ n: number }>)[0].n);
    });
  });

  /* ======================================================================== */
  /* GET /bookings/:id — ownership leak protection                            */
  /* ======================================================================== */

  describe('GET /bookings/:id — ownership', () => {
    let patientAConsultationId: string;

    beforeAll(async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      patientAConsultationId = (body as { booking: { id: string } }).booking.id;
    });

    it('the owner can read it -> 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings/${patientAConsultationId}`,
        headers: { authorization: `Bearer ${patientAToken}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('a different patient gets 404, not 403 — and the SAME code as a truly nonexistent id, proving no existence leak', async () => {
      const notMine = await app.inject({
        method: 'GET',
        url: `/api/bookings/${patientAConsultationId}`,
        headers: { authorization: `Bearer ${patientBToken}` },
      });
      const nonexistent = await app.inject({
        method: 'GET',
        url: `/api/bookings/${randomUUID()}`,
        headers: { authorization: `Bearer ${patientBToken}` },
      });
      expect(notMine.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(payload<{ code: string }>(notMine).code).toBe('BOOKING_NOT_FOUND');
      expect(payload<{ code: string }>(notMine)).toEqual(payload<{ code: string }>(nonexistent));
    });
  });

  /* ======================================================================== */
  /* POST /bookings/:id/cancel — refund-policy branches                       */
  /* ======================================================================== */

  describe('POST /bookings/:id/cancel', () => {
    it('cancelling an unpaid pending_payment booking succeeds with no refund attempted (nothing was ever captured)', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { reason: 'Changed my mind' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('cancelled');

      const refunds = await db.execute(
        sql`select count(*)::int as n from refunds where payment_id in (select id from payments where consultation_id = ${consultationId})`,
      );
      expect((refunds.rows as Array<{ n: number }>)[0].n).toBe(0);

      const again = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {},
      });
      expect(again.statusCode).toBe(409);
      expect(payload<{ code: string }>(again).code).toBe('INVALID_STATE_TRANSITION');
    });

    it('not-owned -> 404 BOOKING_NOT_FOUND', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientBToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('BOOKING_NOT_FOUND');
    });

    it('REFUND POLICY — patient cancels a PAID booking with >=24h notice: automatically refunded in full', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 26);

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${booked.consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { reason: 'Plenty of notice' },
      });
      expect(response.statusCode).toBe(200);

      const refunds = await db.execute(
        sql`select amount, status from refunds where payment_id in (select id from payments where consultation_id = ${booked.consultationId})`,
      );
      expect(refunds.rows).toHaveLength(1);
      const refund = (refunds.rows as Array<{ amount: string; status: string }>)[0];
      expect(Math.round(Number(refund.amount) * 100)).toBe(booked.totalPayablePaise);
    });

    it('REFUND POLICY — patient cancels a PAID booking with under 2h notice: no refund is attempted (policy tier is 0%)', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 0);
      // Move the appointment to inside the 0%-refund tier — same fixture-owned
      // DB nudge app.e2e.integration.spec.ts uses to reach the video join
      // window, applied here to reach a specific refund-policy tier.
      await db.execute(
        sql`update consultations set scheduled_start_at = ${new Date(Date.now() + 30 * 60_000).toISOString()} where id = ${booked.consultationId}`,
      );

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${booked.consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);

      const refunds = await db.execute(
        sql`select count(*)::int as n from refunds where payment_id in (select id from payments where consultation_id = ${booked.consultationId})`,
      );
      expect((refunds.rows as Array<{ n: number }>)[0].n).toBe(0);
    });

    it('REFUND POLICY — a DOCTOR cancelling a PAID booking is never auto-refunded; it is filed to the admin resolution queue', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 5);

      const response = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/bookings/${booked.consultationId}/cancel`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { reason: 'Doctor unavailable' },
      });
      expect(response.statusCode).toBe(200);

      const refunds = await db.execute(
        sql`select count(*)::int as n from refunds where payment_id in (select id from payments where consultation_id = ${booked.consultationId})`,
      );
      expect((refunds.rows as Array<{ n: number }>)[0].n).toBe(0);

      const queued = await db.execute(
        sql`select metadata from audit_log where consultation_id = ${booked.consultationId} and entity_type = 'booking_admin_resolution'`,
      );
      expect(queued.rows.length).toBeGreaterThanOrEqual(1);
      const metadata = (queued.rows as Array<{ metadata: { kind?: string } }>)[0].metadata;
      expect(metadata.kind).toBe('refund_needs_review');

      const queueRoute = await app.inject({
        method: 'GET',
        url: '/api/admin/bookings/resolution-queue',
        headers: { authorization: `Bearer ${adminReadToken}` },
      });
      expect(queueRoute.statusCode).toBe(200);
      const queueRows = payload<Array<{ consultationId: string }>>(queueRoute);
      expect(queueRows.some((row) => row.consultationId === booked.consultationId)).toBe(true);
    });
  });

  /* ======================================================================== */
  /* POST /bookings/:id/reschedule                                            */
  /* ======================================================================== */

  describe('POST /bookings/:id/reschedule', () => {
    it('INVALID_STATE_TRANSITION when the booking is still unpaid (pending_payment is not reschedulable)', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const nextSlots = await getSlots(fixtures.doctorId);
      const differentSlot = nextSlots.find((s) => s !== slots[0]) ?? nextSlots[1];
      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/reschedule`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { scheduledStartAt: differentSlot },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_STATE_TRANSITION');
    });

    it('success: a PAID, scheduled booking is rescheduled to a new slot — the old one is cancelled and the payment moves across', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 3);
      const newSlots = await getSlots(fixtures.doctorId, 10);
      expect(newSlots.length).toBeGreaterThan(0);

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${booked.consultationId}/reschedule`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { scheduledStartAt: newSlots[0] },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; rescheduledFromConsultationId: string | null; status: string }>(response);
      expect(body.rescheduledFromConsultationId).toBe(booked.consultationId);

      const old = await db.execute(sql`select status, cancellation_reason from consultations where id = ${booked.consultationId}`);
      expect((old.rows as Array<{ status: string; cancellation_reason: string | null }>)[0].status).toBe('cancelled');
      expect((old.rows as Array<{ cancellation_reason: string | null }>)[0].cancellation_reason).toBe('Rescheduled');

      const payments = await db.execute(sql`select consultation_id from payments where gateway_order_id = ${booked.gatewayOrderId}`);
      expect((payments.rows as Array<{ consultation_id: string }>)[0].consultation_id).toBe(body.id);
    });

    it('SLOT_NOT_BOOKABLE (too_soon) when rescheduling into a slot inside the notice window', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 3);
      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${booked.consultationId}/reschedule`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { scheduledStartAt: new Date(Date.now() + 20 * 60_000).toISOString() },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string; reason?: string }>(response).code).toBe('SLOT_NOT_BOOKABLE');
    });
  });

  /* ======================================================================== */
  /* PATCH /bookings/:id/intake                                               */
  /* ======================================================================== */

  describe('PATCH /bookings/:id/intake', () => {
    it('success while pending_payment, then INVALID_STATE_TRANSITION once cancelled', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const saved = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${consultationId}/intake`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { answers: { sleep: 'poor' } },
      });
      expect(saved.statusCode).toBe(200);

      await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {},
      });

      const afterCancel = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${consultationId}/intake`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { answers: { sleep: 'better' } },
      });
      expect(afterCancel.statusCode).toBe(409);
      expect(payload<{ code: string }>(afterCancel).code).toBe('INVALID_STATE_TRANSITION');
    });

    it('answers must be an object -> 400 VALIDATION_FAILED', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${consultationId}/intake`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { answers: 'not an object' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  /* ======================================================================== */
  /* POST /bookings/:id/attachments                                          */
  /* ======================================================================== */

  describe('POST /bookings/:id/attachments', () => {
    it('success attaching the patient\'s own file, and DOCUMENT_NOT_ATTACHABLE for someone else\'s', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const [ownFile] = await db
        .insert(patientFilesTable)
        .values({
          fileCategory: 'report',
          patientId: fixtures.patientAId,
          storageKey: `bk-e2e-own-${randomUUID()}`,
          fileName: 'report.pdf',
        })
        .returning({ id: patientFilesTable.id });
      patientFileIds.push(ownFile.id);

      const [foreignFile] = await db
        .insert(patientFilesTable)
        .values({
          fileCategory: 'report',
          patientId: fixtures.patientBId,
          storageKey: `bk-e2e-foreign-${randomUUID()}`,
          fileName: 'not-yours.pdf',
        })
        .returning({ id: patientFilesTable.id });
      patientFileIds.push(foreignFile.id);

      const ok = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/attachments`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { fileId: ownFile.id },
      });
      expect(ok.statusCode).toBe(200);

      const foreign = await app.inject({
        method: 'POST',
        url: `/api/bookings/${consultationId}/attachments`,
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: { fileId: foreignFile.id },
      });
      expect(foreign.statusCode).toBe(404);
      expect(payload<{ code: string }>(foreign).code).toBe('DOCUMENT_NOT_ATTACHABLE');
    });
  });

  /* ======================================================================== */
  /* Doctor routes                                                             */
  /* ======================================================================== */

  describe('doctor routes', () => {
    it('GET /doctors/me/bookings/:id — not the assigned doctor -> 404 BOOKING_NOT_FOUND', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/doctors/me/bookings/${consultationId}`,
        headers: { authorization: `Bearer ${doctorUnbookableToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('BOOKING_NOT_FOUND');
    });

    it('POST .../no-show with no bearer token -> 401', async () => {
      const response = await app.inject({ method: 'POST', url: `/api/doctors/me/bookings/${randomUUID()}/no-show` });
      expect(response.statusCode).toBe(401);
    });

    it('POST .../no-show on a pending_payment (unpaid) booking -> 409 INVALID_STATE_TRANSITION', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/bookings/${consultationId}/no-show`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('INVALID_STATE_TRANSITION');
    });

    it('POST .../no-show on a scheduled (paid) booking -> 200, frees the slot', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 7);
      const response = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/bookings/${booked.consultationId}/no-show`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('no_show');
    });
  });

  /* ======================================================================== */
  /* Admin routes                                                              */
  /* ======================================================================== */

  describe('admin routes', () => {
    it('GET /admin/bookings/:id — bad UUID -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/bookings/not-a-uuid',
        headers: { authorization: `Bearer ${adminReadToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('GET /admin/bookings/:id — admin can read ANY booking regardless of ownership', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/bookings/${consultationId}`,
        headers: { authorization: `Bearer ${adminReadToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ id: string }>(response).id).toBe(consultationId);
    });

    it('POST /admin/bookings/:id/cancel — with appointments.manage succeeds; without it, 403', async () => {
      const slots = await getSlots(fixtures.doctorId);
      const { body } = await createBooking(patientAToken, {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: slots[0],
      });
      const consultationId = (body as { booking: { id: string } }).booking.id;

      const denied = await app.inject({
        method: 'POST',
        url: `/api/admin/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${adminReadToken}` },
        payload: {},
      });
      expect(denied.statusCode).toBe(403);
      expect(payload<{ code: string }>(denied).code).toBe('PERMISSION_DENIED');

      const allowed = await app.inject({
        method: 'POST',
        url: `/api/admin/bookings/${consultationId}/cancel`,
        headers: { authorization: `Bearer ${adminManageToken}` },
        payload: { reason: 'Admin action' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(payload<{ status: string }>(allowed).status).toBe('cancelled');
    });

    it('POST /admin/bookings/:id/no-show — success on a scheduled (paid) booking', async () => {
      const booked = await bookAndPay(fixtures.doctorId, 9);
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/bookings/${booked.consultationId}/no-show`,
        headers: { authorization: `Bearer ${adminManageToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('no_show');
    });

    it('POST /admin/bookings/sweep — runs the slot-hold sweep on demand and reports a shape, not an error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/bookings/sweep',
        headers: { authorization: `Bearer ${adminManageToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ examined: number; released: number; confirmed: number; stillHeld: number; failed: number }>(response);
      expect(typeof body.examined).toBe('number');
      expect(typeof body.failed).toBe('number');
    });

    it('POST /admin/bookings/sweep — without appointments.manage -> 403', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/bookings/sweep',
        headers: { authorization: `Bearer ${adminReadToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });
});
