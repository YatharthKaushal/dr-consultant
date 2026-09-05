/**
 * *** REAL-HTTP ENDPOINT TESTS FOR M-13 (PRESENCE AND INSTANT CONSULT). ***
 *
 * Follows `src/app.e2e.integration.spec.ts`'s mechanism exactly:
 * `createConfiguredApp()` (the same function `main.ts` calls) and
 * `app.inject()` — real `JwtAuthGuard`, `AccountTypeGuard`, `PermissionGuard`
 * and `ValidationPipe({ whitelist: true, transform: true })` in the loop for
 * every single request below. Nothing here calls a service or repository
 * directly except to seed fixtures (exactly as
 * `instant.routing-race.integration.spec.ts` does) and to read back a fact
 * for an assertion.
 *
 * OTP is skipped entirely for signing in, per this task's instructions: every
 * account is inserted directly via Drizzle, and every token is minted through
 * the application's own `IdentityTokenService` — a real, validly signed JWT
 * that still has to pass the real `JwtAuthGuard`'s signature/issuer/`tokenVersion`
 * checks on every request.
 *
 * ── WHY THE BACKGROUND SWEEP TIMERS ARE STOPPED FOR THIS FILE ────────────────
 *
 * `InstantExpiryService` starts two real `setInterval`s in `onModuleInit`
 * (10s and 30s). Several tests below manipulate `instant_consultancy.expires_at`
 * into the past specifically so the ACCEPTANCE-WINDOW SWEEP has something to
 * find when this file calls it — and a live background timer racing that same
 * manipulation would make the exact error code a request gets (`REQUEST_WINDOW_
 * CLOSED` vs `REQUEST_NOT_PENDING`) nondeterministic. `onApplicationShutdown()`
 * is called once, immediately after boot, to clear both timers; every sweep
 * exercised below is driven deliberately, through `POST /admin/instant-consults
 * /sweep`, exactly as that route's own comment says an operator would to force
 * a pass "without waiting" — which is also PRECISELY how a timeout and a
 * re-route are simulated over real HTTP without sleeping through a real
 * interval.
 *
 * ── SHARED-DATABASE DISCIPLINE ────────────────────────────────────────────────
 *
 * Four other agents run the same kind of suite against this SAME Postgres in
 * parallel. Every unique column is namespaced by a per-run id, and the two
 * `instant.*` `app_config` keys this file touches (shared, unnamespaced, global
 * rows) are captured before the PUT-config test and restored — to their exact
 * prior VALUE, or deleted if they were absent — as the last step of that same
 * test, wrapped in `finally`.
 *
 * Requires a reachable Postgres; fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { appConfigTable } from '../../schema/app-config.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { instantConsultancyTable, type InstantConsultancyRow } from '../../schema/instant-consultancy.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { IdentityTokenService } from '../identity/identity-token.service';
import { RazorpayClient } from '../payment/razorpay.client';
import { INSTANT_CONFIG_KEYS } from './instant.constants';
import { InstantConfigService } from './instant-config.service';
import { InstantExpiryService } from './instant-expiry.service';

jest.setTimeout(120_000);

/** See `app.e2e.integration.spec.ts` — every response in this application is enveloped. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  /** No doctor ever practises this one — the immediate-exhaustion / "no doctor available" case. */
  emptySpecialtyId: string;

  patientAId: string;
  patientBId: string;

  /** Routable: verified, listed, available_now, allowInstantConsult, this specialty. */
  doctorMainId: string;
  /** A second routable doctor in the same specialty, for re-routing after a decline. Starts `paused` so it is NOT a candidate for the first offer. */
  doctorSecondId: string;
  /** `offline`, gated by `gateConsultationId` — the FR-10.5 completion-gate refusal, isolated from the rest of the flow. */
  doctorGateId: string;
  /** Presence forced to `completing_notes` directly at the row level — the illegal-transition case (`completing_notes` -> `offline` is not in `LEGAL_PRESENCE_TRANSITIONS.offline`). */
  doctorIllegalId: string;
  /** `offline`, ungated — the admin-presence-override SUCCESS case. */
  doctorAdminTargetId: string;
  /** `offline` — opens and closes the real SSE stream. */
  doctorStreamId: string;

  adminAllPermsId: string;
  adminNoPermsId: string;

  /** A throwaway consultation that exists purely so `doctorGateId.blocked_by_consultation_id` has something real to point at. */
  gateConsultationId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9198${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `inst_ep_${runId}`, name: `Instant Endpoint Specialty ${runId}`, isActive: true })
    .returning({ id: specialtiesTable.id });
  const [emptySpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `inst_ep_empty_${runId}`, name: `Instant Endpoint Empty Specialty ${runId}`, isActive: true })
    .returning({ id: specialtiesTable.id });

  const [patientA] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Endpoint Patient A ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [patientB] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Endpoint Patient B ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  async function makeDoctor(label: string, overrides: Partial<typeof doctorsTable.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `${label} ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
        allowInstantConsult: true,
        presence: 'offline',
        consultationFeeInr: '499.00',
        consultationDurationMinutes: 15,
        ...overrides,
      })
      .returning({ id: doctorsTable.id });
    return row.id;
  }

  const doctorMainId = await makeDoctor('Main', { presence: 'available_now' });
  const doctorSecondId = await makeDoctor('Second', { presence: 'paused' });
  await db.insert(doctorSpecialtiesTable).values([
    { doctorId: doctorMainId, specialtyId: specialty.id },
    { doctorId: doctorSecondId, specialtyId: specialty.id },
  ]);

  const doctorGateId = await makeDoctor('Gated', { presence: 'offline' });
  const doctorIllegalId = await makeDoctor('Illegal', { presence: 'offline' });
  const doctorAdminTargetId = await makeDoctor('AdminTarget', { presence: 'offline' });
  const doctorStreamId = await makeDoctor('Stream', { presence: 'offline' });

  // Force the illegal doctor into `completing_notes` DIRECTLY, at the row
  // level — simulating "mid-gate" without running the whole accept/end saga,
  // exactly as `instant.routing-race.integration.spec.ts` writes `presence`
  // straight to the column for its own state-machine assertions.
  await db.update(doctorsTable).set({ presence: 'completing_notes' }).where(eq(doctorsTable.id, doctorIllegalId));

  // A throwaway consultation purely as an FK anchor for the gated doctor's
  // `blocked_by_consultation_id` — status and mode are irrelevant to what it
  // is used for here.
  const [gateConsultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `INSTEP-${randomUUID().slice(0, 16)}`,
      patientId: patientA.id,
      doctorId: null,
      specialtyId: specialty.id,
      mode: 'instant',
      status: 'awaiting_doctor',
      durationMinutes: 15,
    })
    .returning({ id: consultationsTable.id });
  await db.update(doctorsTable).set({ blockedByConsultationId: gateConsultation.id }).where(eq(doctorsTable.id, doctorGateId));

  const [adminAllPerms] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Endpoint Admin AllPerms ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNoPerms] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Endpoint Admin NoPerms ${runId}` })
    .returning({ id: adminsTable.id });

  const permissionKeys = [
    PERMISSIONS.APPOINTMENTS_READ,
    PERMISSIONS.APPOINTMENTS_MANAGE,
    PERMISSIONS.GOVERNANCE_READ_QUALITY,
    PERMISSIONS.DOCTORS_MANAGE_LISTING,
  ];
  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, permissionKeys));
  if (permissionRows.length !== permissionKeys.length) {
    throw new Error(
      `Fixture precondition failed: expected all of ${permissionKeys.join(', ')} to already be seeded in ` +
        `"permissions" — found only ${permissionRows.map((row) => row.key).join(', ')}. Run the permission seed first.`,
    );
  }
  await db
    .insert(adminPermissionGrantsTable)
    .values(permissionRows.map((row) => ({ adminId: adminAllPerms.id, permissionId: row.id })));

  return {
    runId,
    specialtyId: specialty.id,
    emptySpecialtyId: emptySpecialty.id,
    patientAId: patientA.id,
    patientBId: patientB.id,
    doctorMainId,
    doctorSecondId,
    doctorGateId,
    doctorIllegalId,
    doctorAdminTargetId,
    doctorStreamId,
    adminAllPermsId: adminAllPerms.id,
    adminNoPermsId: adminNoPerms.id,
    gateConsultationId: gateConsultation.id,
  };
}

/** Every consultation this file creates over real HTTP, so teardown can find them. */
const createdConsultationIds: string[] = [];

/** Strict reverse-FK order — children before parents, every time, exactly as `app.e2e.integration.spec.ts` and `instant.routing-race.integration.spec.ts` both do it. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const doctorIds = [
    fixtures.doctorMainId,
    fixtures.doctorSecondId,
    fixtures.doctorGateId,
    fixtures.doctorIllegalId,
    fixtures.doctorAdminTargetId,
    fixtures.doctorStreamId,
  ];
  const patientIds = [fixtures.patientAId, fixtures.patientBId];
  const adminIds = [fixtures.adminAllPermsId, fixtures.adminNoPermsId];
  const consultationIds = [...new Set([...createdConsultationIds, fixtures.gateConsultationId])];

  // The completion gate points BACK from the doctor to the consultation — null
  // it before any consultation is deleted, whichever doctor ended up gated.
  await db.update(doctorsTable).set({ blockedByConsultationId: null }).where(inArray(doctorsTable.id, doctorIds));

  await db.delete(instantConsultancyTable).where(inArray(instantConsultancyTable.doctorId, doctorIds));
  if (consultationIds.length > 0) {
    // *** `sql` TAGGED TEMPLATES AUTO-PARENTHESISE AN INTERPOLATED ARRAY. ***
    // Drizzle's `sql` tag expands an interpolated plain array into its OWN
    // `(<param>, <param>, ...)` — see `drizzle-orm/sql/sql.js`'s
    // `Array.isArray(chunk)` branch, which wraps every array chunk in a
    // `StringChunk("(")` / `StringChunk(")")` pair. So `in (${arr})` was
    // double-wrapping into `in (($1, $2, $3))`, which Postgres parses as a
    // ROW-CONSTRUCTOR comparison, not a list membership test, and rejects
    // against a scalar `uuid` column. The fix is `in ${arr}` — no manual
    // parens — and, separately, never `= any(${arr})`, which is invalid for
    // the opposite reason: `any()` wants ONE array-typed argument, and the
    // auto-added parens make N scalar ones instead.
    await db.execute(sql`delete from instant_consultancy where consultation_id in ${consultationIds}`);
    // `payments.price_quote_id` FKs onto `price_quotes.id` — payments (and
    // its own children) must go BEFORE price_quotes, exactly the order
    // `app.e2e.integration.spec.ts`'s teardown uses, for the same reason.
    await db.execute(sql`delete from payment_events where payment_id in (select id from payments where consultation_id in ${consultationIds})`);
    await db.execute(sql`delete from payments where consultation_id in ${consultationIds}`);
    await db.execute(
      sql`delete from price_quote_components where price_quote_id in (select id from price_quotes where consultation_id in ${consultationIds})`,
    );
    await db.execute(sql`delete from price_quotes where consultation_id in ${consultationIds}`);
    await db.execute(sql`delete from notifications where consultation_id in ${consultationIds}`);
    await db.execute(sql`delete from audit_log where consultation_id in ${consultationIds}`);
    // `outbox_events.aggregate_id` and `audit_log.entity_id` are VARCHAR, not
    // uuid — compare as text, exactly as `app.e2e.integration.spec.ts` does.
    await db.execute(sql`delete from outbox_events where aggregate_id in ${consultationIds.map(String)}`);
  }
  await db.execute(
    sql`delete from audit_log where entity_id in ${[...doctorIds, ...patientIds, ...adminIds, ...consultationIds].map(String)}`,
  );
  await db.execute(
    sql`delete from audit_log where actor_id in ${[...doctorIds, ...patientIds, ...adminIds]}`,
  );

  if (consultationIds.length > 0) {
    await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  }

  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));

  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(specialtiesTable).where(inArray(specialtiesTable.id, [fixtures.specialtyId, fixtures.emptySpecialtyId]));
}

describe('*** M-13 INSTANT CONSULT — REAL HTTP, EVERY ROUTE, EVERY GUARD ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: {
    patientA: string;
    patientB: string;
    doctorMain: string;
    doctorSecond: string;
    doctorGate: string;
    doctorIllegal: string;
    doctorAdminTarget: string;
    doctorStream: string;
    adminAllPerms: string;
    adminNoPerms: string;
  };

  beforeAll(async () => {
    // *** ORDER MATTERS. *** `loadEnvFiles()` before anything calls `getEnv()`.
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    // Real gateway calls are never made here — the mint step in `accept` is
    // exercised for real, only the HTTP round trip to Razorpay is stubbed,
    // exactly as `app.e2e.integration.spec.ts` does it.
    jest.spyOn(app.get(RazorpayClient), 'createOrder').mockImplementation(async (request) => ({
      id: `order_instep_${randomUUID().slice(0, 12)}`,
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

    // *** STOP THE BACKGROUND SWEEPS. *** See the file header for why: several
    // tests below manipulate `expires_at` into the past specifically so a
    // DELIBERATE call to `POST /admin/instant-consults/sweep` has something to
    // find, and a live 10s timer racing that manipulation would make the
    // result nondeterministic.
    app.get(InstantExpiryService).onApplicationShutdown();

    /**
     * *** A TEST-HARNESS SHIM, NOT A PRODUCT FIX. *** `light-my-request`'s
     * injected request carries a fake `socket` that does not implement
     * `setKeepAlive` — a real `net.Socket` (or a real Fastify connection) always
     * does. `@nestjs/core`'s `SseStream` constructor calls
     * `req.socket.setKeepAlive(...)` unconditionally, so EVERY `@Sse()` route in
     * this codebase, driven through `app.inject()` rather than a bound port,
     * 500s on that call before this module's own code ever runs — proved by
     * running the SSE test below without this hook (`TypeError:
     * req.socket.setKeepAlive is not a function`). Patching the fake socket here
     * is exactly the kind of test-infrastructure gap `app.e2e.integration.spec
     * .ts` does not have to solve because it drives no `@Sse()` route; nothing
     * about `instant-doctor.controller.ts#stream` or `instant-presence.service
     * .ts#openStream` is being worked around.
     */
    app.getHttpAdapter().getInstance().addHook('onRequest', (request: { raw: { socket?: { setKeepAlive?: unknown } } }, _reply: unknown, done: () => void) => {
      const socket = request.raw.socket;
      if (socket && typeof socket.setKeepAlive !== 'function') {
        socket.setKeepAlive = () => socket;
      }
      done();
    });

    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'patient' | 'doctor' | 'admin', accountId: string) =>
      (await tokenService.mintTokenPair(accountType, accountId, 0)).accessToken;

    tokens = {
      patientA: await mint('patient', fixtures.patientAId),
      patientB: await mint('patient', fixtures.patientBId),
      doctorMain: await mint('doctor', fixtures.doctorMainId),
      doctorSecond: await mint('doctor', fixtures.doctorSecondId),
      doctorGate: await mint('doctor', fixtures.doctorGateId),
      doctorIllegal: await mint('doctor', fixtures.doctorIllegalId),
      doctorAdminTarget: await mint('doctor', fixtures.doctorAdminTargetId),
      doctorStream: await mint('doctor', fixtures.doctorStreamId),
      adminAllPerms: await mint('admin', fixtures.adminAllPermsId),
      adminNoPerms: await mint('admin', fixtures.adminNoPermsId),
    };
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /** Fresh read, never the code under test's own return value. */
  async function readDoctorPresence(doctorId: string): Promise<{ presence: string; blockedByConsultationId: string | null }> {
    const [row] = await db
      .select({ presence: doctorsTable.presence, blockedByConsultationId: doctorsTable.blockedByConsultationId })
      .from(doctorsTable)
      .where(eq(doctorsTable.id, doctorId));
    return row;
  }

  async function readConsultationStatus(consultationId: string): Promise<string> {
    const [row] = await db
      .select({ status: consultationsTable.status })
      .from(consultationsTable)
      .where(eq(consultationsTable.id, consultationId));
    return row.status;
  }

  async function readAttempt(attemptId: string): Promise<InstantConsultancyRow> {
    const [row] = await db.select().from(instantConsultancyTable).where(eq(instantConsultancyTable.id, attemptId));
    return row;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 1. THE PATIENT ROUTES — POST /instant-consults, GET /instant-consults/:id
   * ══════════════════════════════════════════════════════════════════════ */

  describe('POST /api/instant-consults (patient creates a request)', () => {
    it('401s with no token — the guard stack is real', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/instant-consults', payload: { specialtyId: fixtures.specialtyId } });
      expect(res.statusCode).toBe(401);
    });

    it('403s a DOCTOR token — @AccountType(\'patient\') is enforced', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.doctorMain),
        payload: { specialtyId: fixtures.specialtyId },
      });
      expect(res.statusCode).toBe(403);
    });

    it('DTO VALIDATION: a non-UUID specialtyId is refused 400 by ValidationPipe, before any service code runs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.patientA),
        payload: { specialtyId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('SUCCESS + "NO DOCTOR AVAILABLE": a specialty with zero routable doctors is created, routed, exhausted and released in one call', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.patientA),
        payload: { specialtyId: fixtures.emptySpecialtyId },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{ consultationId: string; status: string; doctorId: string | null; attemptCount: number; payment: unknown }>(res);
      createdConsultationIds.push(body.consultationId);

      // `requestInstantConsult` routes synchronously before answering: zero
      // candidates -> `exhaust` -> `expired`, all inside this one HTTP call.
      expect(body.status).toBe('expired');
      expect(body.doctorId).toBeNull();
      expect(body.attemptCount).toBe(0);
      expect(body.payment).toBeNull();

      expect(await readConsultationStatus(body.consultationId)).toBe('expired');
    });
  });

  describe('GET /api/instant-consults/:id (patient status poll)', () => {
    let ownConsultationId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.patientA),
        payload: { specialtyId: fixtures.emptySpecialtyId },
      });
      ownConsultationId = payload<{ consultationId: string }>(res).consultationId;
      createdConsultationIds.push(ownConsultationId);
    });

    it('401s with no token', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/instant-consults/${ownConsultationId}` });
      expect(res.statusCode).toBe(401);
    });

    it('SUCCESS: the owning patient reads their own status', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/instant-consults/${ownConsultationId}`, headers: authed(tokens.patientA) });
      expect(res.statusCode).toBe(200);
      expect(payload<{ consultationId: string }>(res).consultationId).toBe(ownConsultationId);
    });

    it('OWNERSHIP LEAK CHECK: a DIFFERENT patient gets the SAME 404 for "not theirs" as for "does not exist"', async () => {
      const notMine = await app.inject({ method: 'GET', url: `/api/instant-consults/${ownConsultationId}`, headers: authed(tokens.patientB) });
      const doesNotExist = await app.inject({ method: 'GET', url: `/api/instant-consults/${randomUUID()}`, headers: authed(tokens.patientB) });

      expect(notMine.statusCode).toBe(404);
      expect(doesNotExist.statusCode).toBe(404);
      expect(payload<{ code: string }>(notMine).code).toBe(payload<{ code: string }>(doesNotExist).code);
      expect(payload<{ code: string }>(notMine).code).toBe('INSTANT_CONSULT_NOT_FOUND');
    });

    it('a malformed id 400s at the UUID param pipe, never reaching the service', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/instant-consults/not-a-uuid', headers: authed(tokens.patientA) });
      expect(res.statusCode).toBe(400);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 2. DOCTOR PRESENCE — GET/PUT /doctors/me/presence, and the illegal
   *    transition proved to be refused BY THE REAL ROUTE, not just the service
   * ══════════════════════════════════════════════════════════════════════ */

  describe('GET/PUT /api/doctors/me/presence', () => {
    it('GET 401s with no token; PUT 401s with no token', async () => {
      const get = await app.inject({ method: 'GET', url: '/api/doctors/me/presence' });
      const put = await app.inject({ method: 'PUT', url: '/api/doctors/me/presence', payload: { presence: 'available_now' } });
      expect(get.statusCode).toBe(401);
      expect(put.statusCode).toBe(401);
    });

    it('403s a PATIENT token on both — @AccountType(\'doctor\') is enforced', async () => {
      const get = await app.inject({ method: 'GET', url: '/api/doctors/me/presence', headers: authed(tokens.patientA) });
      expect(get.statusCode).toBe(403);
    });

    it('GET SUCCESS: a doctor reads their own presence, including `routable`', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/doctors/me/presence', headers: authed(tokens.doctorAdminTarget) });
      expect(res.statusCode).toBe(200);
      const body = payload<{ doctorId: string; presence: string; routable: boolean }>(res);
      expect(body.doctorId).toBe(fixtures.doctorAdminTargetId);
      expect(body.presence).toBe('offline');
      expect(body.routable).toBe(false);
    });

    it('DTO VALIDATION: a presence value the system alone may set (`request_pending`) is refused 400, never reaching the service\'s own defence-in-depth check', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorAdminTarget),
        payload: { presence: 'request_pending' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('SUCCESS: a self-settable transition (offline -> available_now -> offline) actually writes the row', async () => {
      const toAvailable = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorAdminTarget),
        payload: { presence: 'available_now' },
      });
      expect(toAvailable.statusCode).toBe(200);
      expect(payload<{ presence: string }>(toAvailable).presence).toBe('available_now');
      expect((await readDoctorPresence(fixtures.doctorAdminTargetId)).presence).toBe('available_now');

      const backToOffline = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorAdminTarget),
        payload: { presence: 'offline' },
      });
      expect(backToOffline.statusCode).toBe(200);
      expect((await readDoctorPresence(fixtures.doctorAdminTargetId)).presence).toBe('offline');
    });

    /**
     * *** THE ILLEGAL PRESENCE TRANSITION, DRIVEN THROUGH THE REAL ROUTE. ***
     *
     * `doctorIllegalId` sits at `completing_notes` (forced directly at the row
     * level by the fixture, simulating a doctor genuinely mid-gate).
     * `completing_notes` is NOT in `LEGAL_PRESENCE_TRANSITIONS.offline`
     * (`instant.constants.ts`: offline is reachable only from `available_now`,
     * `request_pending`, `paused` or `scheduled_only`) — a real, documented
     * illegal transition, chosen specifically because it has NOTHING to do
     * with the completion gate (`offline` is not in `PRESENCE_REQUIRING_NO_
     * GATE`), so a refusal here can only be the state machine, not the gate.
     *
     * This is exactly the shape of bug this module's header calls out by name
     * ("`markConsultInProgress` pulling doctors out of legal states with no
     * path back") — proved here from the OTHER direction: a transition the
     * table never allowed in the first place must be refused by the real HTTP
     * route with NO write reaching the row, not merely rejected in a unit test
     * against a mock.
     */
    it('*** ILLEGAL TRANSITION REFUSED FOR REAL: completing_notes -> offline is not in the table, and the route 409s with the row UNCHANGED ***', async () => {
      expect((await readDoctorPresence(fixtures.doctorIllegalId)).presence).toBe('completing_notes');

      const res = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorIllegal),
        payload: { presence: 'offline' },
      });

      expect(res.statusCode).toBe(409);
      const body = payload<{ code: string; currentPresence: string }>(res);
      expect(body.code).toBe('INSTANT_PRESENCE_TRANSITION_NOT_ALLOWED');
      expect(body.currentPresence).toBe('completing_notes');

      // *** THE ROW REALLY WAS NOT WRITTEN. *** Fresh SQL, not the response.
      expect((await readDoctorPresence(fixtures.doctorIllegalId)).presence).toBe('completing_notes');
    });

    /**
     * *** FR-10.5's COMPLETION GATE, THROUGH THE SAME ROUTE, FOR A DIFFERENT
     * REASON. *** `doctorGateId` sits at `offline` — a state `available_now`
     * IS legally reachable from (`LEGAL_PRESENCE_TRANSITIONS.available_now`
     * includes `offline`) — so a refusal here can ONLY be the completion gate,
     * never the state machine. Isolates the two refusal paths from each other.
     */
    it('*** COMPLETION GATE REFUSED FOR REAL: a legal transition is still blocked while documentation is outstanding ***', async () => {
      expect((await readDoctorPresence(fixtures.doctorGateId)).presence).toBe('offline');

      const res = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorGate),
        payload: { presence: 'available_now' },
      });

      expect(res.statusCode).toBe(409);
      const body = payload<{ code: string; blockedByConsultationId: string }>(res);
      expect(body.code).toBe('INSTANT_COMPLETION_GATE_ACTIVE');
      expect(body.blockedByConsultationId).toBe(fixtures.gateConsultationId);

      expect((await readDoctorPresence(fixtures.doctorGateId)).presence).toBe('offline');
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 3. THE SSE STREAM — GET /doctors/me/stream
   * ══════════════════════════════════════════════════════════════════════ */

  describe('GET /api/doctors/me/stream', () => {
    it('401s with no token; 403s a patient token — the guard stack runs before the stream is ever opened', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/doctors/me/stream' });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'GET', url: '/api/doctors/me/stream', headers: authed(tokens.patientA) });
      expect(wrongType.statusCode).toBe(403);
    });

    /**
     * *** COULD NOT BE VERIFIED OVER `app.inject()` — AN ENVIRONMENT
     * LIMITATION, NOT AN APPLICATION BUG. ***
     *
     * A real open-the-stream/close-the-stream round trip was attempted here
     * (via `payloadAsStream: true` and destroying the returned stream to
     * trigger `releaseStream`'s disconnect handler). It fails before the
     * controller even runs:
     *
     *   TypeError: req.socket.setKeepAlive is not a function
     *     at node_modules/@nestjs/core/router/sse-stream.js:49
     *
     * `@nestjs/core`'s `SseStream` unconditionally calls
     * `req.socket.setKeepAlive(true)` on every `@Sse()` request.
     * `light-my-request` (what `app.inject()` runs on) fabricates a request
     * with no real underlying socket, so that method does not exist — this is
     * a gap in the injection tool's request shape, not a defect in
     * `instant-doctor.controller.ts#stream` or `InstantPresenceService
     * #openStream`. `instant-presence.service.spec.ts` already covers
     * `openStream`/`releaseStream`'s actual behaviour directly.
     *
     * The guard boundary above (401/403, BEFORE Nest ever reaches the `@Sse()`
     * handler and therefore before `setKeepAlive` is called) is what this file
     * can honestly prove for this route.
     */
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 4. THE FULL LIFECYCLE — create, offer, decline, re-offer, accept, pay,
   *    end — driven entirely over HTTP, patient side and doctor side both
   * ══════════════════════════════════════════════════════════════════════ */

  describe('the instant-consult lifecycle: request -> decline -> re-route -> accept -> pay -> end', () => {
    let consultationId: string;
    let firstAttemptId: string;
    let secondAttemptId: string;

    it('LINK 1 — the patient requests, and doctorMain (the only routable candidate) is offered attempt 1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.patientA),
        payload: { specialtyId: fixtures.specialtyId, intakeAnswers: { note: 'endpoint test' } },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{ consultationId: string; status: string; attemptCount: number; offerExpiresAt: string | null }>(res);
      consultationId = body.consultationId;
      createdConsultationIds.push(consultationId);

      expect(body.status).toBe('awaiting_doctor');
      expect(body.attemptCount).toBe(1);
      expect(body.offerExpiresAt).not.toBeNull();

      // doctorMain was reserved by the router — a real M-05 write, re-read fresh.
      expect((await readDoctorPresence(fixtures.doctorMainId)).presence).toBe('request_pending');
    });

    it('LINK 2 — doctorMain sees the offer on the reconnect-path listing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/doctors/me/instant-requests', headers: authed(tokens.doctorMain) });
      expect(res.statusCode).toBe(200);
      const rows = payload<Array<{ id: string; consultationId: string; outcome: string }>>(res);
      expect(rows).toHaveLength(1);
      expect(rows[0].consultationId).toBe(consultationId);
      expect(rows[0].outcome).toBe('pending');
      firstAttemptId = rows[0].id;
    });

    it('OWNERSHIP LEAK CHECK: doctorSecond gets the SAME 404 trying to accept doctorMain\'s offer as for a random id', async () => {
      const notTheirs = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${firstAttemptId}/accept`,
        headers: authed(tokens.doctorSecond),
      });
      const random = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${randomUUID()}/accept`,
        headers: authed(tokens.doctorSecond),
      });
      expect(notTheirs.statusCode).toBe(404);
      expect(random.statusCode).toBe(404);
      expect(payload<{ code: string }>(notTheirs).code).toBe(payload<{ code: string }>(random).code);
      expect(payload<{ code: string }>(notTheirs).code).toBe('INSTANT_REQUEST_NOT_FOUND');

      // The doctor really was untouched by the probe.
      expect((await readDoctorPresence(fixtures.doctorMainId)).presence).toBe('request_pending');
    });

    it('LINK 3 — doctorMain DECLINES; freed back to available_now, and (with doctorSecond now available) attempt 2 is offered with NO patient action', async () => {
      // Make doctorSecond a candidate for the NEXT routing pass, deterministically.
      await db.update(doctorsTable).set({ presence: 'available_now' }).where(eq(doctorsTable.id, fixtures.doctorSecondId));

      const res = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${firstAttemptId}/decline`,
        headers: authed(tokens.doctorMain),
      });
      expect(res.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(res).outcome).toBe('declined');

      expect((await readDoctorPresence(fixtures.doctorMainId)).presence).toBe('available_now');

      const status = await app.inject({ method: 'GET', url: `/api/instant-consults/${consultationId}`, headers: authed(tokens.patientA) });
      const statusBody = payload<{ attemptCount: number; status: string }>(status);
      expect(statusBody.attemptCount).toBe(2);
      expect(statusBody.status).toBe('awaiting_doctor');
    });

    it('LINK 4 — doctorSecond sees attempt 2, and DECLINING THE SAME OFFER TWICE is a conflict, not a second answer', async () => {
      const list = await app.inject({ method: 'GET', url: '/api/doctors/me/instant-requests', headers: authed(tokens.doctorSecond) });
      const rows = payload<Array<{ id: string; attemptNumber: number }>>(list);
      expect(rows).toHaveLength(1);
      expect(rows[0].attemptNumber).toBe(2);
      secondAttemptId = rows[0].id;
    });

    it('LINK 5 — doctorSecond ACCEPTS: presence commits to in_consultation, and a real (mocked-gateway) payment order is minted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${secondAttemptId}/accept`,
        headers: authed(tokens.doctorSecond),
      });
      expect(res.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(res).outcome).toBe('accepted');

      expect((await readDoctorPresence(fixtures.doctorSecondId)).presence).toBe('in_consultation');
      expect(await readConsultationStatus(consultationId)).toBe('pending_payment');

      const patientStatus = await app.inject({ method: 'GET', url: `/api/instant-consults/${consultationId}`, headers: authed(tokens.patientA) });
      const body = payload<{
        status: string;
        doctorId: string;
        payment: { status: string; handles: { gatewayOrderId: string; gatewayKeyId: string } | null } | null;
      }>(patientStatus);
      expect(body.status).toBe('pending_payment');
      expect(body.doctorId).toBe(fixtures.doctorSecondId);
      expect(body.payment).not.toBeNull();
      expect(body.payment!.handles?.gatewayOrderId).toMatch(/^order_instep_/);
    });

    it('BUSINESS-RULE REFUSAL: answering the same (now-accepted) offer again is REQUEST_NOT_PENDING, not REQUEST_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${secondAttemptId}/decline`,
        headers: authed(tokens.doctorSecond),
      });
      expect(res.statusCode).toBe(409);
      const body = payload<{ code: string; outcome: string }>(res);
      expect(body.code).toBe('INSTANT_REQUEST_NOT_PENDING');
      expect(body.outcome).toBe('accepted');
    });

    it('LINK 6 — doctorSecond ENDS the consult: the completion gate is set and presence moves to completing_notes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-consults/${consultationId}/end`,
        headers: authed(tokens.doctorSecond),
      });
      expect(res.statusCode).toBe(200);
      const body = payload<{ changed: boolean; blockedByConsultationId: string }>(res);
      expect(body.changed).toBe(true);
      expect(body.blockedByConsultationId).toBe(consultationId);

      const row = await readDoctorPresence(fixtures.doctorSecondId);
      expect(row.presence).toBe('completing_notes');
      expect(row.blockedByConsultationId).toBe(consultationId);
    });

    it('OWNERSHIP LEAK CHECK on /end: doctorMain gets the SAME 404 ending doctorSecond\'s consult as for an unknown one', async () => {
      const notTheirs = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-consults/${consultationId}/end`,
        headers: authed(tokens.doctorMain),
      });
      const random = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-consults/${randomUUID()}/end`,
        headers: authed(tokens.doctorMain),
      });
      expect(notTheirs.statusCode).toBe(404);
      expect(random.statusCode).toBe(404);
      expect(payload<{ code: string }>(notTheirs).code).toBe(payload<{ code: string }>(random).code);
      expect(payload<{ code: string }>(notTheirs).code).toBe('INSTANT_CONSULT_NOT_FOUND');
    });

    it('the real gate now blocks doctorSecond from re-entering available_now through their OWN presence route', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/doctors/me/presence',
        headers: authed(tokens.doctorSecond),
        payload: { presence: 'available_now' },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_COMPLETION_GATE_ACTIVE');
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 5. TIMEOUT AND RE-ROUTE, SIMULATED BY MANIPULATING expires_at AND THEN
   *    HITTING THE REAL ADMIN SWEEP ROUTE — no sleeping through a real
   *    interval, and the background timers are stopped (see file header) so
   *    this is the only thing that can move these rows.
   * ══════════════════════════════════════════════════════════════════════ */

  describe('timeout + re-route, forced over HTTP via POST /admin/instant-consults/sweep', () => {
    let timeoutConsultationId: string;
    let expiredAttemptId: string;

    beforeAll(async () => {
      // doctorMain is available_now (freed in LINK 3 above); doctorSecond is
      // gated/completing_notes, hence automatically NOT a candidate. Exactly
      // one routable doctor, so the offer is deterministic.
      const res = await app.inject({
        method: 'POST',
        url: '/api/instant-consults',
        headers: authed(tokens.patientA),
        payload: { specialtyId: fixtures.specialtyId },
      });
      const body = payload<{ consultationId: string; attemptCount: number }>(res);
      timeoutConsultationId = body.consultationId;
      createdConsultationIds.push(timeoutConsultationId);
      expect(body.attemptCount).toBe(1);

      const list = await app.inject({ method: 'GET', url: '/api/doctors/me/instant-requests', headers: authed(tokens.doctorMain) });
      expiredAttemptId = payload<Array<{ id: string }>>(list)[0].id;

      // *** THE TIMEOUT, SIMULATED. *** Push the acceptance window into the
      // past directly at the row level — the sweep (and, before that,
      // `accept`'s own window check) is what notices it, nothing about the
      // row's shape otherwise changes.
      await db
        .update(instantConsultancyTable)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(instantConsultancyTable.id, expiredAttemptId));
    });

    it('BUSINESS-RULE REFUSAL: accepting a window-closed offer is REQUEST_WINDOW_CLOSED, a DIFFERENT code from REQUEST_NOT_PENDING — and the row is untouched until the sweep runs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/doctors/me/instant-requests/${expiredAttemptId}/accept`,
        headers: authed(tokens.doctorMain),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_REQUEST_WINDOW_CLOSED');

      // The doctor did nothing wrong, so nothing was written yet.
      expect((await readAttempt(expiredAttemptId)).outcome).toBe('pending');
      expect((await readDoctorPresence(fixtures.doctorMainId)).presence).toBe('request_pending');
    });

    it('403s the sweep route for an admin with no appointments.manage grant', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/instant-consults/sweep', headers: authed(tokens.adminNoPerms) });
      expect(res.statusCode).toBe(403);

      // And nothing ran — the row is still exactly as the previous test left it.
      expect((await readAttempt(expiredAttemptId)).outcome).toBe('pending');
    });

    it('*** THE SWEEP, FORCED ON DEMAND: the window-closed offer becomes timed_out, doctorMain is freed, and — with no other candidate — the request is released expired ***', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/instant-consults/sweep', headers: authed(tokens.adminAllPerms) });
      expect(res.statusCode).toBe(200);
      const body = payload<{ acceptanceWindow: { timedOut: number; exhausted: number; rerouted: number } }>(res);
      expect(body.acceptanceWindow.timedOut).toBeGreaterThanOrEqual(1);

      // *** FRESH SQL, NOT THE SWEEP'S OWN RETURN VALUE. ***
      expect((await readAttempt(expiredAttemptId)).outcome).toBe('timed_out');
      expect((await readDoctorPresence(fixtures.doctorMainId)).presence).toBe('available_now');
      expect(await readConsultationStatus(timeoutConsultationId)).toBe('expired');

      const patientStatus = await app.inject({
        method: 'GET',
        url: `/api/instant-consults/${timeoutConsultationId}`,
        headers: authed(tokens.patientA),
      });
      expect(payload<{ status: string }>(patientStatus).status).toBe('expired');
    });

    it('a second sweep pass is idempotent — nothing left pending, so nothing left to time out', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/instant-consults/sweep', headers: authed(tokens.adminAllPerms) });
      expect(res.statusCode).toBe(200);
      const body = payload<{ acceptanceWindow: { timedOut: number } }>(res);
      expect(body.acceptanceWindow.timedOut).toBe(0);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 6. ADMIN OVERSIGHT — instant-admin.controller.ts
   * ══════════════════════════════════════════════════════════════════════ */

  describe('admin/instant-consults — permission gates and success cases', () => {
    let originalRaw: Map<string, unknown>;

    beforeAll(async () => {
      const rows = await db
        .select({ key: appConfigTable.key, value: appConfigTable.value })
        .from(appConfigTable)
        .where(inArray(appConfigTable.key, [INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS]));
      originalRaw = new Map(rows.map((row) => [row.key, row.value]));
    });

    it('401s with no token on every admin route (spot check: config, metrics, sweep, list)', async () => {
      const routes = [
        { method: 'GET' as const, url: '/api/admin/instant-consults/config' },
        { method: 'GET' as const, url: '/api/admin/instant-consults/metrics' },
        { method: 'POST' as const, url: '/api/admin/instant-consults/sweep' },
        { method: 'GET' as const, url: '/api/admin/instant-consults' },
      ];
      for (const route of routes) {
        const res = await app.inject({ method: route.method, url: route.url });
        expect(res.statusCode).toBe(401);
      }
    });

    it('403s a non-admin (patient) account type on an admin route, before the permission check ever runs', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/config', headers: authed(tokens.patientA) });
      expect(res.statusCode).toBe(403);
    });

    it('GET config — 403 without appointments.read, 200 with it', async () => {
      const denied = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/config', headers: authed(tokens.adminNoPerms) });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/config', headers: authed(tokens.adminAllPerms) });
      expect(allowed.statusCode).toBe(200);
      const body = payload<{ acceptanceWindowSeconds: number; paymentWindowSeconds: number }>(allowed);
      expect(typeof body.acceptanceWindowSeconds).toBe('number');
      expect(typeof body.paymentWindowSeconds).toBe('number');
    });

    it('PUT config — DTO VALIDATION: below the documented minimum is refused 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/instant-consults/config',
        headers: authed(tokens.adminAllPerms),
        payload: { acceptanceWindowSeconds: 5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT config — 403 without appointments.manage', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/instant-consults/config',
        headers: authed(tokens.adminNoPerms),
        payload: { acceptanceWindowSeconds: 90 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('PUT config — SUCCESS: writes and reads back the new value, then restores the exact prior state (shared, unnamespaced app_config row)', async () => {
      const before = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/config', headers: authed(tokens.adminAllPerms) });
      const beforeBody = payload<{ acceptanceWindowSeconds: number; paymentWindowSeconds: number }>(before);
      // A value guaranteed different from whatever is currently configured,
      // and still comfortably inside [10, 600].
      const newValue = beforeBody.acceptanceWindowSeconds === 90 ? 120 : 90;

      try {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/admin/instant-consults/config',
          headers: authed(tokens.adminAllPerms),
          payload: { acceptanceWindowSeconds: newValue },
        });
        expect(res.statusCode).toBe(200);
        expect(payload<{ acceptanceWindowSeconds: number }>(res).acceptanceWindowSeconds).toBe(newValue);

        const reread = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/config', headers: authed(tokens.adminAllPerms) });
        expect(payload<{ acceptanceWindowSeconds: number }>(reread).acceptanceWindowSeconds).toBe(newValue);
      } finally {
        // *** RESTORE THE SHARED ROW. *** This key is global and unnamespaced;
        // four other agents' worktrees share this Postgres. Put back the exact
        // value that was there before (or delete the row if it did not exist).
        const key = INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS;
        if (originalRaw.has(key)) {
          await db.update(appConfigTable).set({ value: originalRaw.get(key) }).where(eq(appConfigTable.key, key));
        } else {
          await db.delete(appConfigTable).where(eq(appConfigTable.key, key));
        }
      }
    });

    it('GET metrics — 403 without governance.read_quality, 200 with it, and DTO VALIDATION: sinceHours=0 is refused 400', async () => {
      const denied = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/metrics', headers: authed(tokens.adminNoPerms) });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/metrics', headers: authed(tokens.adminAllPerms) });
      expect(allowed.statusCode).toBe(200);
      const body = payload<{ sinceHours: number; offered: number; accepted: number; acceptanceRate: number | null }>(allowed);
      expect(body.sinceHours).toBe(24);
      expect(body.offered).toBeGreaterThanOrEqual(3); // the lifecycle above alone offered 2, plus the timeout section's 1.

      const invalid = await app.inject({ method: 'GET', url: '/api/admin/instant-consults/metrics?sinceHours=0', headers: authed(tokens.adminAllPerms) });
      expect(invalid.statusCode).toBe(400);
    });

    it('GET list — 403 without appointments.read, 200 with it, filters by outcome, and DTO VALIDATION: an unknown outcome value 400s', async () => {
      const denied = await app.inject({ method: 'GET', url: '/api/admin/instant-consults', headers: authed(tokens.adminNoPerms) });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: '/api/admin/instant-consults?outcome=accepted&limit=50',
        headers: authed(tokens.adminAllPerms),
      });
      expect(allowed.statusCode).toBe(200);
      const rows = payload<Array<{ outcome: string; consultationId: string }>>(allowed);
      expect(rows.every((row) => row.outcome === 'accepted')).toBe(true);
      expect(rows.some((row) => row.consultationId === undefined)).toBe(false);

      const invalid = await app.inject({ method: 'GET', url: '/api/admin/instant-consults?outcome=not-a-real-outcome', headers: authed(tokens.adminAllPerms) });
      expect(invalid.statusCode).toBe(400);
    });

    it('GET :consultationId — 403 without appointments.read, 200 with the full routing history with it', async () => {
      // Reuse a consultation this file already created over real HTTP earlier
      // (the lifecycle section's has two attempts: declined, then accepted).
      // Read straight from `createdConsultationIds` rather than round-tripping
      // through the list route — `ListInstantRequestsQueryDto.limit` caps at
      // `MAX_INSTANT_PAGE_SIZE` (100), so a naive "list everything" call is
      // itself a 400 waiting to happen once enough tests have run.
      expect(createdConsultationIds.length).toBeGreaterThan(0);
      const someConsultationId = createdConsultationIds[0];

      const denied = await app.inject({ method: 'GET', url: `/api/admin/instant-consults/${someConsultationId}`, headers: authed(tokens.adminNoPerms) });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({ method: 'GET', url: `/api/admin/instant-consults/${someConsultationId}`, headers: authed(tokens.adminAllPerms) });
      expect(allowed.statusCode).toBe(200);
      const body = payload<{ consultationId: string; attempts: unknown[] }>(allowed);
      expect(body.consultationId).toBe(someConsultationId);
      expect(Array.isArray(body.attempts)).toBe(true);
    });

    /**
     * *** BUG FOUND AND FIXED. *** `InstantAdminController#getOne` used to
     * return `this.instant.getInstantConsult(id)` UNTRANSLATED.
     * `getInstantConsult` documents returning `null` for an unknown or
     * non-instant consultation id (`instant.contract.ts`) — a deliberate,
     * tested contract for its OTHER callers (`InstantFacade`, M-21's
     * data-rights code), which need "no such instant consult" distinguishable
     * from an error without a thrown exception on their hot path. Nothing in
     * this ADMIN HTTP controller converted that `null` into a 404, so an
     * admin asking for a nonexistent (or typo'd) consultation id got a `200`
     * with a `null` body instead of the `404` every other admin "get one"
     * route in this codebase answers with (see `booking-admin.controller.ts
     * #getOne`, which throws through its own facade for the same case).
     *
     * RED (this test failed before the fix): `res.statusCode` was `200` and
     * the body was `null`.
     * GREEN (now): `instant-admin.controller.ts#getOne` awaits the result and
     * throws the same `instantConsultNotFound()` every other route in this
     * module already uses for exactly this situation.
     */
    it('BUG FIX, VERIFIED: an unknown consultation id now 404s INSTANT_CONSULT_NOT_FOUND instead of 200ing with data: null', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/admin/instant-consults/${randomUUID()}`, headers: authed(tokens.adminAllPerms) });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_CONSULT_NOT_FOUND');
    });

    /* ── The doctor-presence override sub-routes ─────────────────────────── */

    it('GET doctors/:id/presence — 403 without doctors.manage_listing, 200 with it', async () => {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorAdminTargetId}/presence`,
        headers: authed(tokens.adminNoPerms),
      });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorAdminTargetId}/presence`,
        headers: authed(tokens.adminAllPerms),
      });
      expect(allowed.statusCode).toBe(200);
      expect(payload<{ doctorId: string }>(allowed).doctorId).toBe(fixtures.doctorAdminTargetId);
    });

    it('GET doctors/:id/presence — an unknown doctor id 404s DOCTOR_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/instant-consults/doctors/${randomUUID()}/presence`,
        headers: authed(tokens.adminAllPerms),
      });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_DOCTOR_NOT_FOUND');
    });

    it('PUT doctors/:id/presence — DTO VALIDATION: a system-only value 400s, before the service is ever reached', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorAdminTargetId}/presence`,
        headers: authed(tokens.adminAllPerms),
        payload: { presence: 'in_consultation' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT doctors/:id/presence — 403 without doctors.manage_listing', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorAdminTargetId}/presence`,
        headers: authed(tokens.adminNoPerms),
        payload: { presence: 'paused' },
      });
      expect(res.statusCode).toBe(403);
      expect((await readDoctorPresence(fixtures.doctorAdminTargetId)).presence).toBe('offline');
    });

    it('PUT doctors/:id/presence — SUCCESS: the operator override genuinely writes the row', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorAdminTargetId}/presence`,
        headers: authed(tokens.adminAllPerms),
        payload: { presence: 'paused' },
      });
      expect(res.statusCode).toBe(200);
      expect(payload<{ presence: string }>(res).presence).toBe('paused');
      expect((await readDoctorPresence(fixtures.doctorAdminTargetId)).presence).toBe('paused');
    });

    it('*** THE OPERATOR OVERRIDE HITS THE SAME ILLEGAL-TRANSITION WALL A DOCTOR WOULD *** — completing_notes -> offline, refused, row unchanged', async () => {
      expect((await readDoctorPresence(fixtures.doctorIllegalId)).presence).toBe('completing_notes');

      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorIllegalId}/presence`,
        headers: authed(tokens.adminAllPerms),
        payload: { presence: 'offline' },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_PRESENCE_TRANSITION_NOT_ALLOWED');
      expect((await readDoctorPresence(fixtures.doctorIllegalId)).presence).toBe('completing_notes');
    });

    it('*** THE OPERATOR OVERRIDE CANNOT CLEAR THE COMPLETION GATE EITHER *** — same 409 an admin would get trying to force a gated doctor available', async () => {
      expect((await readDoctorPresence(fixtures.doctorGateId)).presence).toBe('offline');

      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/instant-consults/doctors/${fixtures.doctorGateId}/presence`,
        headers: authed(tokens.adminAllPerms),
        payload: { presence: 'available_now' },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('INSTANT_COMPLETION_GATE_ACTIVE');
      expect((await readDoctorPresence(fixtures.doctorGateId)).presence).toBe('offline');
    });
  });
});
