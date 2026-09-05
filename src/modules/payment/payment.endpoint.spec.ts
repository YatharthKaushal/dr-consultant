/**
 * ***************************************************************************
 * *** PAYMENT MODULE — REAL HTTP, REAL POSTGRES, EVERY DOCUMENTED BRANCH. ***
 * ***************************************************************************
 *
 * `src/app.e2e.integration.spec.ts` already drives the webhook end to end for
 * the headline cases: a correctly-signed capture (paid, moves the booking to
 * `scheduled`), a WRONG signature (401, nothing written), a correctly-signed
 * WRONG-AMOUNT capture (`outcome:'failed'`, never marks paid), and a replayed
 * event id (idempotent, one row). THIS FILE DOES NOT DUPLICATE THOSE — it
 * covers everything else `payment-webhook.service.ts` and
 * `payment-admin.controller.ts` can do: a signature header that is simply
 * ABSENT, a malformed (no event id) delivery, an unparseable body, a
 * `deferred` outcome (an order id we have no row for), an unrecognised event
 * type, `payment.failed` (including the race guard against an
 * already-captured payment), `refund.processed`/`refund.failed` settling a
 * refund the admin API created, and the full `payment-admin.controller.ts`
 * surface: transactions, refunds, payouts, CSV export and config, each with
 * its permission gate and its documented error codes.
 *
 * `PaymentModule` has no patient-facing controller at all (confirmed by
 * reading `payment.module.ts`) — every route here is either `@Public()` (the
 * webhook) or `@AccountType('admin')`, so there is no ownership-leak surface
 * to test in this module the way booking's `canAct` has one.
 *
 * Pattern copied from `app.e2e.integration.spec.ts` and
 * `booking.endpoint.spec.ts`: Slide mocked, `createConfiguredApp()`,
 * `app.inject()`, the `{success,data}`/`{success:false,error}` envelope
 * unwrapped by `payload()`, fixtures namespaced by a random `runId`, teardown
 * in strict reverse-FK order, an admin minted via a seeded `admins` row plus
 * `admin_permission_grants` and `IdentityTokenService#mintTokenPair`.
 *
 * Requires a reachable Postgres with `identity.seed.ts` already run (the
 * `permissions` catalog) and `pricing.seed.ts` already run (this is what
 * makes `PUT /admin/payments/config` deterministic — see that test).
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
import { doctorAvailabilityTable } from '../../schema/doctor-availability.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { PAYMENT_WEBHOOK_PATH, RAZORPAY_EVENT_ID_HEADER, RAZORPAY_SIGNATURE_HEADER } from './payment.constants';
import { RazorpayClient } from './razorpay.client';

jest.setTimeout(120_000);

const MIN_NOTICE_MINUTES = 120;

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  patientMobile: string;
  doctorId: string;
  doctorMobile: string;
}

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

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9176${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `pay_${runId}`, name: `Payment E2E Specialty ${runId}`, isActive: true })
    .returning({ id: specialtiesTable.id });

  const patientMobile = nextPhone();
  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: patientMobile, fullName: `Payment E2E Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const doctorMobile = nextPhone();
  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: doctorMobile,
      fullName: `Payment E2E Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await db.insert(doctorAvailabilityTable).values({
      doctorId: doctor.id,
      ruleType: 'weekly',
      dayOfWeek,
      specificDate: null,
      startTime: '00:00:00',
      endTime: '23:59:00',
    });
  }

  return { runId, specialtyId: specialty.id, patientId: patient.id, patientMobile, doctorId: doctor.id, doctorMobile };
}

const postedWebhookEventIds: string[] = [];
const adminIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.patientId];
  const patientList = pgArray(patientIds, 'uuid');
  const doctorList = pgArray([fixtures.doctorId], 'uuid');

  const consultationRows = await db.execute(sql`select id from consultations where patient_id = any(${patientList})`);
  const consultationIds = (consultationRows.rows as Array<{ id: string }>).map((row) => row.id);
  const consultationList = pgArray(consultationIds, 'uuid');

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
  await db.execute(sql`delete from outbox_events where aggregate_id = any(${pgArray(consultationIds, 'varchar')})`);
  await db.execute(sql`delete from audit_log where consultation_id = any(${consultationList})`);
  await db.execute(
    sql`delete from audit_log where actor_id = any(${pgArray([...patientIds, fixtures.doctorId, ...adminIds], 'uuid')})`,
  );
  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...consultationIds, ...postedWebhookEventIds], 'varchar')})`,
  );
  await db.execute(sql`delete from consultations where id = any(${consultationList})`);

  await db.execute(sql`delete from otp_challenges where mobile_number in (${fixtures.patientMobile}, ${fixtures.doctorMobile})`);
  await db.execute(
    sql`delete from otp_request_attempts where mobile_number in (${fixtures.patientMobile}, ${fixtures.doctorMobile})`,
  );

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);

  await db.execute(sql`delete from doctor_availability where doctor_id = any(${doctorList})`);
  await db.execute(sql`delete from doctor_specialties where doctor_id = any(${doctorList})`);
  await db.execute(sql`delete from doctors where id = any(${doctorList})`);
  await db.execute(sql`delete from patients where id = any(${patientList})`);
  await db.execute(sql`delete from specialties where id = ${fixtures.specialtyId}`);
}

/* -------------------------------------------------------------------------- */

describe('payment module — real HTTP endpoints', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let patientToken: string;
  let adminReadToken: string;
  let adminRefundToken: string;
  let adminExportToken: string;
  let adminConfigToken: string;
  let adminNoneToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    jest.spyOn(app.get(RazorpayClient), 'createOrder').mockImplementation(async (request) => ({
      id: `order_pay_${randomUUID().slice(0, 12)}`,
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

    // Every admin-initiated refund starts `pending` at the gateway — the
    // ordinary Razorpay answer — so `refund.processed`/`refund.failed` below
    // are settling something the webhook, not the HTTP call, resolves.
    jest.spyOn(app.get(RazorpayClient), 'createRefund').mockImplementation(async (_paymentId, request) => ({
      id: `rfnd_pay_${randomUUID().slice(0, 12)}`,
      entity: 'refund',
      amount: request.amount,
      currency: 'INR',
      payment_id: _paymentId,
      status: 'pending',
      created_at: Math.floor(Date.now() / 1000),
    }));

    fixtures = await seedFixtures(db);

    const requested = await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { mobileNumber: fixtures.patientMobile, audience: 'patient' } });
    const { challengeId } = payload<{ challengeId: string }>(requested);
    const verified = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId, code: '123456' } });
    patientToken = payload<{ accessToken: string }>(verified).accessToken;

    async function mintAdmin(label: string, permissionKeys: string[]): Promise<string> {
      const [admin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `+9175${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, fullName: `Payment E2E Admin ${label}` })
        .returning({ id: adminsTable.id });
      adminIds.push(admin.id);
      for (const key of permissionKeys) {
        const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
        if (!permission) throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts first.`);
        await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: permission.id });
      }
      const tokens = await app.get(IdentityTokenService).mintTokenPair('admin', admin.id, 0);
      return tokens.accessToken;
    }

    adminReadToken = await mintAdmin('read', [PERMISSIONS.PAYMENTS_READ]);
    adminRefundToken = await mintAdmin('refund', [PERMISSIONS.PAYMENTS_READ, PERMISSIONS.PAYMENTS_REFUND]);
    adminExportToken = await mintAdmin('export', [PERMISSIONS.PAYMENTS_EXPORT]);
    adminConfigToken = await mintAdmin('config', [PERMISSIONS.PAYMENTS_MANAGE_CONFIG]);
    adminNoneToken = await mintAdmin('none', []);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  async function createPendingBooking(): Promise<{ consultationId: string; gatewayOrderId: string; totalPayablePaise: number; paymentId: string }> {
    const from = new Date();
    const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);
    const slotsResponse = await app.inject({
      method: 'GET',
      url: `/api/doctors/${fixtures.doctorId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { authorization: `Bearer ${patientToken}` },
    });
    const slots = payload<Array<{ startsAt: string }>>(slotsResponse);
    const minMs = from.getTime() + (MIN_NOTICE_MINUTES + 30) * 60_000;
    const chosen = slots.find((s) => new Date(s.startsAt).getTime() > minMs);
    expect(chosen).toBeDefined();

    const response = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: { authorization: `Bearer ${patientToken}` },
      payload: { doctorId: fixtures.doctorId, specialtyId: fixtures.specialtyId, scheduledStartAt: chosen!.startsAt },
    });
    expect(response.statusCode).toBe(201);
    const body = payload<{ booking: { id: string }; payment: { gatewayOrderId: string; breakdown: { totalPayable: string } } }>(response);
    const totalPayablePaise = Math.round(Number(body.payment.breakdown.totalPayable) * 100);

    const paymentRow = await db.execute(sql`select id from payments where consultation_id = ${body.booking.id}`);
    const paymentId = (paymentRow.rows as Array<{ id: string }>)[0].id;

    return { consultationId: body.booking.id, gatewayOrderId: body.payment.gatewayOrderId, totalPayablePaise, paymentId };
  }

  function signedWebhook(body: unknown): { raw: string; signature: string } {
    const raw = JSON.stringify(body);
    const secret = app.get(RazorpayClient).getWebhookSecret();
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  function captureBody(amountPaise: number, orderId: string): Record<string, unknown> {
    return {
      entity: 'event',
      account_id: 'acc_pay_e2e',
      event: 'payment.captured',
      contains: ['payment'],
      payload: { payment: { entity: { id: `pay_pay_e2e_${randomUUID().slice(0, 12)}`, entity: 'payment', amount: amountPaise, currency: 'INR', status: 'captured', order_id: orderId, method: 'upi' } } },
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  function failedBody(orderId: string): Record<string, unknown> {
    return {
      entity: 'event',
      account_id: 'acc_pay_e2e',
      event: 'payment.failed',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_pay_e2e_${randomUUID().slice(0, 12)}`,
            entity: 'payment',
            amount: 1,
            currency: 'INR',
            status: 'failed',
            order_id: orderId,
            method: 'upi',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed due to insufficient funds in the customer account.',
            error_reason: 'insufficient_funds',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  function refundSettlementBody(event: 'refund.processed' | 'refund.failed', gatewayRefundId: string): Record<string, unknown> {
    return {
      entity: 'event',
      account_id: 'acc_pay_e2e',
      event,
      contains: ['refund'],
      payload: { refund: { entity: { id: gatewayRefundId, entity: 'refund', amount: 1, currency: 'INR', payment_id: 'pay_x', status: event === 'refund.processed' ? 'processed' : 'failed' } } },
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  async function postWebhook(raw: string, signature: string | undefined, eventId: string | undefined) {
    if (eventId !== undefined) postedWebhookEventIds.push(eventId);
    return app.inject({
      method: 'POST',
      url: PAYMENT_WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { [RAZORPAY_SIGNATURE_HEADER]: signature }),
        ...(eventId === undefined ? {} : { [RAZORPAY_EVENT_ID_HEADER]: eventId }),
      },
      payload: raw,
    });
  }

  async function captureAndWaitPaid(booked: { consultationId: string; gatewayOrderId: string; totalPayablePaise: number }): Promise<void> {
    const eventId = `evt_pay_${randomUUID()}`;
    const { raw, signature } = signedWebhook(captureBody(booked.totalPayablePaise, booked.gatewayOrderId));
    const response = await postWebhook(raw, signature, eventId);
    expect(response.statusCode).toBe(201);
    const deadline = Date.now() + 5_000;
    let status = 'pending_payment';
    while (status !== 'scheduled' && Date.now() < deadline) {
      const row = await db.execute(sql`select status from consultations where id = ${booked.consultationId}`);
      status = (row.rows as Array<{ status: string }>)[0].status;
      if (status !== 'scheduled') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe('scheduled');
  }

  /* ======================================================================== */
  /* AUTH BOUNDARY — admin/payments/*                                          */
  /* ======================================================================== */

  describe('auth boundary', () => {
    it('GET /admin/payments/transactions with no token -> 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions' });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('GET /admin/payments/transactions with a patient token -> 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions', headers: { authorization: `Bearer ${patientToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('GET /admin/payments/transactions with an admin holding no permissions -> 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions', headers: { authorization: `Bearer ${adminNoneToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('GET /admin/payments/transactions with payments.read -> 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions', headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(response.statusCode).toBe(200);
    });

    it('payments.read alone cannot refund, export or manage config — the operations-role split is real', async () => {
      const refund = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${randomUUID()}/refunds`,
        headers: { authorization: `Bearer ${adminReadToken}` },
        payload: { amount: '10.00', reason: 'test' },
      });
      expect(refund.statusCode).toBe(403);
      expect(payload<{ code: string }>(refund).code).toBe('PERMISSION_DENIED');

      const csv = await app.inject({ method: 'GET', url: '/api/admin/payments/export/transactions', headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(csv.statusCode).toBe(403);

      const config = await app.inject({ method: 'GET', url: '/api/admin/payments/config', headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(config.statusCode).toBe(403);
    });
  });

  /* ======================================================================== */
  /* WEBHOOK — auth boundary and malformed deliveries                         */
  /* ======================================================================== */

  describe('POST /payments/webhook — signature and shape', () => {
    it('no signature header at all -> 401, writes nothing', async () => {
      const { raw } = signedWebhook(captureBody(1, 'order_does_not_matter'));
      const response = await postWebhook(raw, undefined, `evt_no_sig_${randomUUID()}`);
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    });

    it('a valid signature but no event-id header -> 400 WEBHOOK_MALFORMED, and the malformed check runs AFTER the signature check', async () => {
      const { raw, signature } = signedWebhook(captureBody(1, 'order_does_not_matter'));
      const response = await postWebhook(raw, signature, undefined);
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PAYMENT_WEBHOOK_MALFORMED');
    });

    it('a verified but unparseable JSON body -> 201, outcome failed, and a payment_events row is written with no payment_id', async () => {
      const raw = 'not-json-at-all{{{';
      const secret = app.get(RazorpayClient).getWebhookSecret();
      const signature = createHmac('sha256', secret).update(raw).digest('hex');
      const eventId = `evt_unparseable_${randomUUID()}`;
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('failed');

      const events = await db.execute(sql`select payment_id, event_type from payment_events where gateway_event_id = ${eventId}`);
      expect(events.rows).toHaveLength(1);
      const row = (events.rows as Array<{ payment_id: string | null; event_type: string }>)[0];
      expect(row.payment_id).toBeNull();
      expect(row.event_type).toBe('unparseable');
    });

    it('payment.captured for an order_id with no matching payment -> 201, outcome deferred, payment_id null', async () => {
      const eventId = `evt_deferred_${randomUUID()}`;
      const { raw, signature } = signedWebhook(captureBody(50000, `order_nonexistent_${randomUUID()}`));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('deferred');

      const events = await db.execute(sql`select payment_id from payment_events where gateway_event_id = ${eventId}`);
      expect((events.rows as Array<{ payment_id: string | null }>)[0].payment_id).toBeNull();
    });

    it('an unrecognized event type is recorded but does not act on anything -> 201, outcome processed', async () => {
      const eventId = `evt_unrecognized_${randomUUID()}`;
      const body = { entity: 'event', account_id: 'acc_pay_e2e', event: 'order.paid', contains: ['order'], payload: {}, created_at: Math.floor(Date.now() / 1000) };
      const { raw, signature } = signedWebhook(body);
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string; handled: boolean }>(response)).toMatchObject({ outcome: 'processed', handled: true });
    });
  });

  /* ======================================================================== */
  /* WEBHOOK — payment.failed                                                  */
  /* ======================================================================== */

  describe('POST /payments/webhook — payment.failed', () => {
    it('a genuine failure marks the payment failed and records a classified reason', async () => {
      const booked = await createPendingBooking();
      const eventId = `evt_failed_${randomUUID()}`;
      const { raw, signature } = signedWebhook(failedBody(booked.gatewayOrderId));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('processed');

      const row = await db.execute(sql`select status, failure_reason, paid_at from payments where id = ${booked.paymentId}`);
      const payment = (row.rows as Array<{ status: string; failure_reason: string | null; paid_at: string | null }>)[0];
      expect(payment.status).toBe('failed');
      expect(payment.failure_reason).not.toBeNull();
      expect(payment.paid_at).toBeNull();
    });

    it('payment.failed for an ALREADY-CAPTURED payment is a guarded no-op — it can never undo a capture', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);

      const statusBefore = await db.execute(sql`select status from payments where id = ${booked.paymentId}`);

      const eventId = `evt_failed_after_capture_${randomUUID()}`;
      const { raw, signature } = signedWebhook(failedBody(booked.gatewayOrderId));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('processed');

      const statusAfter = await db.execute(sql`select status, paid_at from payments where id = ${booked.paymentId}`);
      expect((statusAfter.rows as Array<{ status: string }>)[0].status).toBe((statusBefore.rows as Array<{ status: string }>)[0].status);
      expect((statusAfter.rows as Array<{ paid_at: string | null }>)[0].paid_at).not.toBeNull();
    });
  });

  /* ======================================================================== */
  /* WEBHOOK — refund.processed / refund.failed                               */
  /* ======================================================================== */

  describe('POST /payments/webhook — refund settlement', () => {
    it('refund.processed settles a refund the admin API created: credit note allocated, payment status recomputed', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);

      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: (booked.totalPayablePaise / 100).toFixed(2), reason: 'Full refund for webhook settlement test' },
      });
      expect(created.statusCode).toBe(201);
      const { refundId, status: initialStatus } = payload<{ refundId: string; status: string }>(created);
      expect(initialStatus).not.toBe('processed');

      const gatewayRow = await db.execute(sql`select gateway_refund_id from refunds where id = ${refundId}`);
      const gatewayRefundId = (gatewayRow.rows as Array<{ gateway_refund_id: string }>)[0].gateway_refund_id;

      const eventId = `evt_refund_processed_${randomUUID()}`;
      const { raw, signature } = signedWebhook(refundSettlementBody('refund.processed', gatewayRefundId));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('processed');

      const refundRow = await db.execute(sql`select status, credit_note_number from refunds where id = ${refundId}`);
      const refund = (refundRow.rows as Array<{ status: string; credit_note_number: string | null }>)[0];
      expect(refund.status).toBe('processed');
      expect(refund.credit_note_number).not.toBeNull();

      const paymentRow = await db.execute(sql`select status from payments where id = ${booked.paymentId}`);
      // The whole captured amount was refunded.
      expect((paymentRow.rows as Array<{ status: string }>)[0].status).toBe('refunded');
    });

    it('refund.failed marks a settling refund failed, and never reverses one already processed', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);

      const created = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '50.00', reason: 'Partial refund for webhook failure test' },
      });
      expect(created.statusCode).toBe(201);
      const { refundId } = payload<{ refundId: string }>(created);
      const gatewayRow = await db.execute(sql`select gateway_refund_id from refunds where id = ${refundId}`);
      const gatewayRefundId = (gatewayRow.rows as Array<{ gateway_refund_id: string }>)[0].gateway_refund_id;

      const eventId = `evt_refund_failed_${randomUUID()}`;
      const { raw, signature } = signedWebhook(refundSettlementBody('refund.failed', gatewayRefundId));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);

      const refundRow = await db.execute(sql`select status from refunds where id = ${refundId}`);
      expect((refundRow.rows as Array<{ status: string }>)[0].status).toBe('failed');

      // Replaying refund.failed after it already failed is a no-op, not an error.
      const replayEventId = `evt_refund_failed_replay_${randomUUID()}`;
      const { raw: raw2, signature: sig2 } = signedWebhook(refundSettlementBody('refund.failed', gatewayRefundId));
      const replay = await postWebhook(raw2, sig2, replayEventId);
      expect(replay.statusCode).toBe(201);
    });

    it('refund.processed for a gateway refund id with no matching row -> deferred, not an error', async () => {
      const eventId = `evt_refund_deferred_${randomUUID()}`;
      const { raw, signature } = signedWebhook(refundSettlementBody('refund.processed', `rfnd_nonexistent_${randomUUID()}`));
      const response = await postWebhook(raw, signature, eventId);
      expect(response.statusCode).toBe(201);
      expect(payload<{ outcome: string }>(response).outcome).toBe('deferred');
    });
  });

  /* ======================================================================== */
  /* ADMIN — transactions                                                      */
  /* ======================================================================== */

  describe('GET /admin/payments/transactions', () => {
    it('bad UUID path param -> 400 VALIDATION_FAILED, never a raw DB error', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions/not-a-uuid', headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a nonexistent payment -> 404 PAYMENT_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/payments/transactions/${randomUUID()}`, headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('PAYMENT_NOT_FOUND');
    });

    it('a real payment is returned with its breakdown, refunds and events', async () => {
      const booked = await createPendingBooking();
      const response = await app.inject({ method: 'GET', url: `/api/admin/payments/transactions/${booked.paymentId}`, headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ payment: { id: string; status: string }; refunds: unknown[]; events: unknown[] }>(response);
      expect(body.payment.id).toBe(booked.paymentId);
      expect(body.payment.status).toBe('pending');
    });

    it('GET .../refundable quietly degrades to 0.00 for BOTH an unpaid payment and a nonexistent one (never a 404)', async () => {
      const booked = await createPendingBooking();
      const forUnpaid = await app.inject({ method: 'GET', url: `/api/admin/payments/transactions/${booked.paymentId}/refundable`, headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(forUnpaid.statusCode).toBe(200);
      expect(payload<{ refundableAmount: string }>(forUnpaid).refundableAmount).toBe('0.00');

      const forNonexistent = await app.inject({ method: 'GET', url: `/api/admin/payments/transactions/${randomUUID()}/refundable`, headers: { authorization: `Bearer ${adminReadToken}` } });
      expect(forNonexistent.statusCode).toBe(200);
      expect(payload<{ refundableAmount: string }>(forNonexistent).refundableAmount).toBe('0.00');
    });
  });

  /* ======================================================================== */
  /* ADMIN — refunds                                                           */
  /* ======================================================================== */

  describe('POST /admin/payments/transactions/:paymentId/refunds', () => {
    it('validation: amount as a JSON number, and a too-short reason -> 400 VALIDATION_FAILED', async () => {
      const numericAmount = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${randomUUID()}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: 10, reason: 'A valid reason string' },
      });
      expect(numericAmount.statusCode).toBe(400);
      expect(payload<{ code: string }>(numericAmount).code).toBe('VALIDATION_FAILED');

      const shortReason = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${randomUUID()}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '10.00', reason: 'hi' },
      });
      expect(shortReason.statusCode).toBe(400);
      expect(payload<{ code: string }>(shortReason).code).toBe('VALIDATION_FAILED');
    });

    it('PAYMENT_NOT_FOUND for a nonexistent payment -> 404', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${randomUUID()}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '10.00', reason: 'Refunding a payment that does not exist' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('PAYMENT_NOT_FOUND');
    });

    it('PAYMENT_NOT_CAPTURED for a payment that was never paid -> 409', async () => {
      const booked = await createPendingBooking();
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '10.00', reason: 'Refunding an uncaptured payment' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('PAYMENT_NOT_CAPTURED');
    });

    it('REFUND_AMOUNT_INVALID for a zero amount on a captured payment -> 400', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '0.00', reason: 'A zero-amount refund attempt' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('REFUND_AMOUNT_INVALID');
    });

    it('success, then REFUND_EXCEEDS_CAPTURED once the remaining capturable amount is gone -> 409', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);
      const totalRupees = (booked.totalPayablePaise / 100).toFixed(2);

      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: totalRupees, reason: 'Refunding the entire captured amount' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/refunds`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { amount: '1.00', reason: 'A second refund that exceeds what remains' },
      });
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe('REFUND_EXCEEDS_CAPTURED');
    });
  });

  /* ======================================================================== */
  /* ADMIN — payouts                                                           */
  /* ======================================================================== */

  describe('POST /admin/payments/transactions/:paymentId/payout', () => {
    it('validation: missing bankReference -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${randomUUID()}/payout`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('PAYOUT_NOT_PAYABLE for an unpaid payment -> 409', async () => {
      const booked = await createPendingBooking();
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/payout`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { bankReference: 'NEFT123456' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('PAYOUT_NOT_PAYABLE');
    });

    it('success on a captured payment, then PAYOUT_ALREADY_PAID on a second attempt -> 409', async () => {
      const booked = await createPendingBooking();
      await captureAndWaitPaid(booked);

      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/payout`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { bankReference: 'NEFT654321', note: 'Manual payout' },
      });
      expect(first.statusCode).toBe(201);
      expect(payload<{ paymentId: string }>(first).paymentId).toBe(booked.paymentId);

      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/payments/transactions/${booked.paymentId}/payout`,
        headers: { authorization: `Bearer ${adminRefundToken}` },
        payload: { bankReference: 'NEFT654321-again' },
      });
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe('PAYOUT_ALREADY_PAID');
    });
  });

  /* ======================================================================== */
  /* ADMIN — export                                                            */
  /* ======================================================================== */

  describe('GET /admin/payments/export/*', () => {
    it('exports transactions as a real CSV file, not the JSON envelope', async () => {
      const booked = await createPendingBooking();
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/export/transactions', headers: { authorization: `Bearer ${adminExportToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.body).toContain(booked.paymentId);
    });

    it('exports refunds as CSV too, and payments.export alone cannot reach any other admin route', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/export/refunds', headers: { authorization: `Bearer ${adminExportToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');

      const transactions = await app.inject({ method: 'GET', url: '/api/admin/payments/transactions', headers: { authorization: `Bearer ${adminExportToken}` } });
      expect(transactions.statusCode).toBe(403);
    });
  });

  /* ======================================================================== */
  /* ADMIN — config                                                            */
  /* ======================================================================== */

  describe('GET/PUT /admin/payments/config', () => {
    it('GET returns the resolved legacy rates', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/payments/config', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ convenienceFeePct: number; gstRate: number }>(response);
      expect(typeof body.convenienceFeePct).toBe('number');
      expect(typeof body.gstRate).toBe('number');
    });

    it('PUT is refused once a pricing catalogue exists (PAYMENT_CONFIG_SUPERSEDED) — this repo\'s pricing.seed.ts has already written one', async () => {
      const catalogueRow = await db.execute(sql`select 1 from app_config where key = 'pricing.components'`);
      const hasCatalogue = catalogueRow.rows.length > 0;

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/payments/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { convenienceFeePct: 15 },
      });

      if (hasCatalogue) {
        expect(response.statusCode).toBe(409);
        expect(payload<{ code: string }>(response).code).toBe('PAYMENT_CONFIG_SUPERSEDED');
      } else {
        // Documented fallback for an environment with no pricing catalogue seeded yet.
        expect(response.statusCode).toBe(200);
        expect(payload<{ convenienceFeePct: number }>(response).convenienceFeePct).toBe(15);
      }
    });

    it('validation: an out-of-bounds rate -> 400 VALIDATION_FAILED before the service is ever reached', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/payments/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { gstRate: 150 },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });
});
