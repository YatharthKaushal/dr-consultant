/**
 * *** REAL-HTTP ENDPOINT TESTS FOR THE VIDEO MODULE (M-14). ***
 *
 * Every other spec in `src/modules/video/` either mocks its collaborators
 * (`video.service.spec.ts`, `video-webhook.service.spec.ts`) or drives a real
 * database directly against a service/repository
 * (`video.webhook-idempotency.integration.spec.ts`). None of them go through
 * `JwtAuthGuard`, `AccountTypeGuard`, `PermissionGuard`, the `ValidationPipe`,
 * or the actual `@Controller` routing table. `app.e2e.integration.spec.ts`
 * drives the join-token route and the "a scheduled call never sets the
 * completion gate" finding through real HTTP, but it calls
 * `VideoWebhookService#handle` directly for every webhook delivery — the
 * signature-verification boundary itself, `video-webhook.controller.ts`, has
 * never been driven end to end anywhere in this codebase.
 *
 * This file:
 *   1. Drives every route on `VideoController`, `VideoAdminController` and
 *      `VideoWebhookController` through `app.inject()` — the real guard
 *      stack, the real `ValidationPipe`, the real webhook-safe JSON parser.
 *   2. Signs LiveKit webhook deliveries FOR REAL, using the same
 *      `AccessToken`/`jose` machinery `livekit.client.ts#mintJoinToken` uses
 *      to mint a token — see `signLivekitWebhook` below. `WebhookReceiver
 *      #receive` (read from `node_modules/livekit-server-sdk` for this test)
 *      verifies a JWT whose `sha256` claim is `base64(sha256(rawBody))`,
 *      issued with `iss = LIVEKIT_API_KEY` and signed with
 *      `LIVEKIT_API_SECRET` — exactly what `AccessToken#toJwt` produces when
 *      its `sha256` grant is set. No stub, no shortcut: this is the real SDK
 *      class the app itself uses, just handed a `sha256` grant instead of a
 *      `video` grant.
 *
 * ── Fixture isolation ───────────────────────────────────────────────────────
 *
 * Every unique column is namespaced by a per-run id. Consultations are
 * inserted directly (as `video.webhook-idempotency.integration.spec.ts`
 * does), not through booking/payment — a `payments` row with `status: 'paid'`
 * and a `consents` row are added by hand to satisfy `VideoService`'s own
 * gates. Teardown runs in strict reverse-FK order in `afterAll`.
 *
 * ── Requires a reachable Postgres and real LiveKit env vars ────────────────
 *
 * Reads `DATABASE_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` via
 * `getEnv()` after `loadEnvFiles()`, exactly as `app.bootstrap.ts` does — so
 * the signature this file computes is verified against the same secret the
 * running application reads.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AccessToken } from 'livekit-server-sdk';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { getEnv, loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { consentsTable } from '../../schema/consents.schema';
import { consultationParticipantsTable } from '../../schema/consultation-participants.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';
import { patientsTable } from '../../schema/patients.schema';
import { paymentsTable } from '../../schema/payments.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { IdentityTokenService } from '../identity/identity-token.service';

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/* Envelope unwrap — every response is `{success,data}` or `{success,error}`.  */
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
/* Signing a REAL LiveKit webhook delivery                                    */
/* -------------------------------------------------------------------------- */

/**
 * Builds a JWT `WebhookReceiver#receive` (the same class `livekit.client.ts`
 * uses to verify) accepts as genuine: `iss = apiKey`, HS256-signed with
 * `apiSecret`, carrying a `sha256` claim equal to `base64(sha256(rawBody))`.
 * This is the real `AccessToken` class from `livekit-server-sdk` — the exact
 * one `LivekitClient#mintJoinToken` uses — just given a `sha256` grant
 * instead of a `video` grant, which is all a genuine LiveKit server's webhook
 * JWT carries (confirmed by reading `WebhookReceiver.js`'s `receive` and
 * `AccessToken.js`'s `toJwt`/`TokenVerifier#verify`).
 */
async function signLivekitWebhook(rawBody: string, apiKey: string, apiSecret: string): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: 60 });
  token.sha256 = createHash('sha256').update(rawBody).digest('base64');
  return token.toJwt();
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  patientToken: string;
  otherPatientId: string;
  otherPatientToken: string;
  doctorId: string;
  doctorToken: string;
  otherDoctorId: string;
  otherDoctorToken: string;
  legalDocumentId: string;
  createdLegalDocumentId: string | null;
}

const consultationIds: string[] = [];
const adminIds: string[] = [];
const doctorIds: string[] = [];
const patientIds: string[] = [];

async function seedFixtures(db: Database, app: NestFastifyApplication): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9197${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `videp_${runId}`, name: `Video Endpoint Specialty ${runId}`, canPrescribe: true, isActive: true })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Video Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  patientIds.push(patient.id);

  const [otherPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Video Stranger Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  patientIds.push(otherPatient.id);

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Video Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      presence: 'available_now',
    })
    .returning({ id: doctorsTable.id });
  doctorIds.push(doctor.id);
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [otherDoctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Video Stranger Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
    })
    .returning({ id: doctorsTable.id });
  doctorIds.push(otherDoctor.id);

  const [existingCurrent] = await db
    .select({ id: legalDocumentsTable.id })
    .from(legalDocumentsTable)
    .where(
      sql`${legalDocumentsTable.documentType} = 'teleconsultation_consent' and ${legalDocumentsTable.isCurrent} = true`,
    )
    .limit(1);

  let createdLegalDocumentId: string | null = null;
  let legalDocumentId: string;
  if (existingCurrent) {
    legalDocumentId = existingCurrent.id;
  } else {
    const [created] = await db
      .insert(legalDocumentsTable)
      .values({
        documentType: 'teleconsultation_consent',
        version: `videp-${runId}`,
        title: `Video Endpoint Consent ${runId}`,
        body: 'Test consent text. Created by video.endpoint.spec.ts and deleted by its teardown.',
        isCurrent: true,
      })
      .returning({ id: legalDocumentsTable.id });
    legalDocumentId = created.id;
    createdLegalDocumentId = created.id;
  }

  const tokens = app.get(IdentityTokenService);
  const patientToken = (await tokens.mintTokenPair('patient', patient.id, 0)).accessToken;
  const otherPatientToken = (await tokens.mintTokenPair('patient', otherPatient.id, 0)).accessToken;
  const doctorToken = (await tokens.mintTokenPair('doctor', doctor.id, 0)).accessToken;
  const otherDoctorToken = (await tokens.mintTokenPair('doctor', otherDoctor.id, 0)).accessToken;

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    patientToken,
    otherPatientId: otherPatient.id,
    otherPatientToken,
    doctorId: doctor.id,
    doctorToken,
    otherDoctorId: otherDoctor.id,
    otherDoctorToken,
    legalDocumentId,
    createdLegalDocumentId,
  };
}

/** Inserts one `consultations` row directly, bypassing booking/payment — the pattern `video.webhook-idempotency.integration.spec.ts` sets. */
async function insertConsultation(
  db: Database,
  fixtures: Fixtures,
  overrides: {
    mode?: 'scheduled' | 'instant';
    status?: 'scheduled' | 'in_progress' | 'awaiting_documentation' | 'completed' | 'cancelled' | 'awaiting_doctor';
    doctorId?: string | null;
    scheduledStartAt?: Date | null;
    patientId?: string;
  } = {},
): Promise<string> {
  const mode = overrides.mode ?? 'scheduled';
  const [row] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `VEP-${randomUUID().slice(0, 16)}`,
      patientId: overrides.patientId ?? fixtures.patientId,
      doctorId: overrides.doctorId === undefined ? fixtures.doctorId : overrides.doctorId,
      specialtyId: fixtures.specialtyId,
      mode,
      status: overrides.status ?? 'scheduled',
      scheduledStartAt: mode === 'instant' ? null : (overrides.scheduledStartAt ?? new Date(Date.now() + 5 * 60_000)),
      durationMinutes: 30,
    })
    .returning({ id: consultationsTable.id });
  consultationIds.push(row.id);
  return row.id;
}

async function markPaid(db: Database, consultationId: string): Promise<void> {
  await db.insert(paymentsTable).values({
    consultationId,
    consultationFee: '500.00',
    convenienceFeePct: '0',
    convenienceFee: '0',
    gstPct: '0',
    gstAmount: '0',
    status: 'paid',
    paidAt: new Date(),
  });
}

/** Idempotent — `(patient_id, legal_document_id)` is unique, and several tests share the one fixture patient. */
async function grantConsent(db: Database, fixtures: Fixtures, patientId: string): Promise<void> {
  await db
    .insert(consentsTable)
    .values({
      patientId,
      legalDocumentId: fixtures.legalDocumentId,
      documentType: 'teleconsultation_consent',
    })
    .onConflictDoNothing();
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const consultationList = pgArray(consultationIds, 'uuid');
  await db.execute(sql`delete from consultation_participants where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from payments where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from consents where patient_id = any(${pgArray(patientIds, 'uuid')})`);
  await db.execute(sql`delete from outbox_events where aggregate_id = any(${pgArray(consultationIds, 'varchar')})`);
  await db.execute(sql`delete from audit_log where consultation_id = any(${consultationList})`);
  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...consultationIds, ...doctorIds, ...patientIds, ...adminIds], 'varchar')})`,
  );
  await db.execute(sql`delete from consultations where id = any(${consultationList})`);

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.delete(adminsTable).where(sql`${adminsTable.id} = any(${pgArray(adminIds, 'uuid')})`);

  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.otherDoctorId));
  await db.delete(doctorsTable).where(sql`${doctorsTable.id} = any(${pgArray(doctorIds, 'uuid')})`);
  await db.delete(patientsTable).where(sql`${patientsTable.id} = any(${pgArray(patientIds, 'uuid')})`);
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));

  if (fixtures.createdLegalDocumentId !== null) {
    await db.delete(legalDocumentsTable).where(eq(legalDocumentsTable.id, fixtures.createdLegalDocumentId));
  }
}

let adminPhoneSeq = 10;

/** Mints an admin token holding exactly the given permissions (possibly none). */
async function mintAdminToken(
  db: Database,
  app: NestFastifyApplication,
  runId: string,
  ...permissionKeys: string[]
): Promise<string> {
  const [admin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `+9196${runId.slice(0, 6)}${String(adminPhoneSeq++).padStart(2, '0')}`, fullName: `Video Admin ${runId}` })
    .returning({ id: adminsTable.id });
  adminIds.push(admin.id);

  for (const key of permissionKeys) {
    const [perm] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
    if (!perm) throw new Error(`Fixture precondition failed: permission "${key}" is not seeded.`);
    await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: perm.id });
  }

  return (await app.get(IdentityTokenService).mintTokenPair('admin', admin.id, 0)).accessToken;
}

/* ========================================================================== */

describe('*** VIDEO MODULE — REAL HTTP ENDPOINT TESTS ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let apiKey: string;
  let apiSecret: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    const env = getEnv();
    apiKey = env.LIVEKIT_API_KEY;
    apiSecret = env.LIVEKIT_API_SECRET;
    fixtures = await seedFixtures(db, app);
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

  /* ======================================================================== */
  /* GET /api/video/config                                                    */
  /* ======================================================================== */

  describe('GET /api/video/config', () => {
    it('401s with no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/video/config' });
      expect(res.statusCode).toBe(401);
    });

    it('403s for an admin — this route is patient/doctor only', async () => {
      const adminToken = await mintAdminToken(db, app, fixtures.runId);
      const res = await app.inject({ method: 'GET', url: '/api/video/config', headers: auth(adminToken) });
      expect(res.statusCode).toBe(403);
    });

    it('200s for a patient and for a doctor, carrying the LiveKit server URL', async () => {
      for (const token of [fixtures.patientToken, fixtures.doctorToken]) {
        const res = await app.inject({ method: 'GET', url: '/api/video/config', headers: auth(token) });
        expect(res.statusCode).toBe(200);
        expect(payload<{ serverUrl: string }>(res).serverUrl).toBe(getEnv().LIVEKIT_URL);
      }
    });
  });

  /* ======================================================================== */
  /* POST /api/video/consultations/:id/token                                  */
  /* ======================================================================== */

  describe('POST /api/video/consultations/:id/token', () => {
    it('400s on a malformed consultation id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/video/consultations/not-a-uuid/token',
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('401s with no token', async () => {
      const id = await insertConsultation(db, fixtures);
      const res = await app.inject({ method: 'POST', url: `/api/video/consultations/${id}/token` });
      expect(res.statusCode).toBe(401);
    });

    it('404s for a consultation that does not exist — same code as "not yours"', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${randomUUID()}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_CONSULTATION_NOT_FOUND');
    });

    it('404s (not 403) for a real consultation that belongs to a stranger — ownership never leaks via a different status code', async () => {
      const id = await insertConsultation(db, fixtures);
      const strangerRes = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.otherPatientToken),
      });
      const missingRes = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${randomUUID()}/token`,
        headers: auth(fixtures.otherPatientToken),
      });
      expect(strangerRes.statusCode).toBe(missingRes.statusCode);
      expect(payload<{ code: string }>(strangerRes).code).toBe(payload<{ code: string }>(missingRes).code);
    });

    it('409 VIDEO_DOCTOR_NOT_ASSIGNED — the assigned patient of a doctor-less consultation', async () => {
      const id = await insertConsultation(db, fixtures, { doctorId: null, status: 'awaiting_doctor' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_DOCTOR_NOT_ASSIGNED');
    });

    it('409 VIDEO_CONSULTATION_NOT_JOINABLE — a completed consultation', async () => {
      const id = await insertConsultation(db, fixtures, { status: 'completed' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_CONSULTATION_NOT_JOINABLE');
    });

    it('409 VIDEO_JOIN_WINDOW_NOT_OPEN — a scheduled slot far in the future', async () => {
      const id = await insertConsultation(db, fixtures, {
        scheduledStartAt: new Date(Date.now() + 3 * 60 * 60_000),
      });
      // Neither paid nor consented — irrelevant, since the window gate runs before both.
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_JOIN_WINDOW_NOT_OPEN');
    });

    it('409 VIDEO_PAYMENT_NOT_COMPLETED — inside the window, but unpaid', async () => {
      const id = await insertConsultation(db, fixtures, { scheduledStartAt: new Date(Date.now() + 5 * 60_000) });
      // Unconsented too — irrelevant, since the payment gate runs before consent.
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_PAYMENT_NOT_COMPLETED');
    });

    it('409 VIDEO_CONSENT_REQUIRED — paid, inside the window, but the patient never accepted teleconsultation consent', async () => {
      const id = await insertConsultation(db, fixtures, { scheduledStartAt: new Date(Date.now() + 5 * 60_000) });
      await markPaid(db, id);
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_CONSENT_REQUIRED');
    });

    it('200s and mints a real join token for BOTH the patient and the doctor once every gate clears, and audits both', async () => {
      const id = await insertConsultation(db, fixtures, { scheduledStartAt: new Date(Date.now() + 5 * 60_000) });
      await markPaid(db, id);
      await grantConsent(db, fixtures, fixtures.patientId);

      for (const [party, token] of [
        ['patient', fixtures.patientToken],
        ['doctor', fixtures.doctorToken],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/video/consultations/${id}/token`,
          headers: auth(token),
        });
        expect(res.statusCode).toBe(200);
        const ticket = payload<{ token: string; roomName: string; party: string; serverUrl: string }>(res);
        expect(ticket.party).toBe(party);
        expect(ticket.roomName).toBe(`consult-${id}`);
        expect(ticket.token.split('.')).toHaveLength(3);
      }

      const audits = await db.execute(
        sql`select count(*)::int as n from audit_log where consultation_id = ${id} and entity_type = 'video_join_token'`,
      );
      expect((audits.rows as Array<{ n: number }>)[0].n).toBe(2);
    });

    it('a call already in_progress may still mint a token (reconnect) even though its slot has passed', async () => {
      const id = await insertConsultation(db, fixtures, {
        status: 'in_progress',
        scheduledStartAt: new Date(Date.now() - 3 * 60 * 60_000),
      });
      await markPaid(db, id);
      await grantConsent(db, fixtures, fixtures.patientId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(200);
    });

    it('an INSTANT consultation (no scheduled time) is never subject to the join window', async () => {
      const id = await insertConsultation(db, fixtures, { mode: 'instant', status: 'scheduled' });
      await markPaid(db, id);
      await grantConsent(db, fixtures, fixtures.patientId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/token`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  /* ======================================================================== */
  /* GET /api/video/consultations/:id/session                                 */
  /* ======================================================================== */

  describe('GET /api/video/consultations/:id/session', () => {
    it('401s with no token', async () => {
      const id = await insertConsultation(db, fixtures);
      const res = await app.inject({ method: 'GET', url: `/api/video/consultations/${id}/session` });
      expect(res.statusCode).toBe(401);
    });

    it('404s for a stranger, matching the "does not exist" case', async () => {
      const id = await insertConsultation(db, fixtures);
      const strangerRes = await app.inject({
        method: 'GET',
        url: `/api/video/consultations/${id}/session`,
        headers: auth(fixtures.otherPatientToken),
      });
      expect(strangerRes.statusCode).toBe(404);
    });

    it('200s for both the patient and the doctor on the consultation', async () => {
      const id = await insertConsultation(db, fixtures);
      for (const token of [fixtures.patientToken, fixtures.doctorToken]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/video/consultations/${id}/session`,
          headers: auth(token),
        });
        expect(res.statusCode).toBe(200);
        expect(payload<{ consultationId: string }>(res).consultationId).toBe(id);
      }
    });
  });

  /* ======================================================================== */
  /* GET /api/video/consultations/:id/room                                    */
  /* ======================================================================== */

  describe('GET /api/video/consultations/:id/room', () => {
    it('403s for a patient — this route narrows to doctor only', async () => {
      const id = await insertConsultation(db, fixtures);
      const res = await app.inject({
        method: 'GET',
        url: `/api/video/consultations/${id}/room`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s for a doctor who is not assigned to this consultation', async () => {
      const id = await insertConsultation(db, fixtures);
      const res = await app.inject({
        method: 'GET',
        url: `/api/video/consultations/${id}/room`,
        headers: auth(fixtures.otherDoctorToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("200s for the assigned doctor, composing the patient, consent, session and prior-history", async () => {
      const id = await insertConsultation(db, fixtures);
      await grantConsent(db, fixtures, fixtures.patientId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/video/consultations/${id}/room`,
        headers: auth(fixtures.doctorToken),
      });
      expect(res.statusCode).toBe(200);
      const body = payload<{ consultationId: string; consent: { hasCurrentConsent: boolean }; documentsEndpoint: string }>(res);
      expect(body.consultationId).toBe(id);
      expect(body.consent.hasCurrentConsent).toBe(true);
      expect(body.documentsEndpoint).toBe(`/api/consultations/${id}/documents`);
    });
  });

  /* ======================================================================== */
  /* POST /api/video/consultations/:id/end                                    */
  /* ======================================================================== */

  describe('POST /api/video/consultations/:id/end', () => {
    it('403s for a patient — ending a call is the doctor’s act', async () => {
      const id = await insertConsultation(db, fixtures, { status: 'in_progress' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.patientToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s for a doctor not on the consultation', async () => {
      const id = await insertConsultation(db, fixtures, { status: 'in_progress' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.otherDoctorToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it('*** FIX PROVEN OVER REAL HTTP *** ending a SCHEDULED call moves it to awaiting_documentation and returns the doctor to the routing pool', async () => {
      const id = await insertConsultation(db, fixtures, { mode: 'scheduled', status: 'in_progress' });
      await db.update(doctorsTable).set({ presence: 'in_consultation' }).where(eq(doctorsTable.id, fixtures.doctorId));

      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.doctorToken),
      });
      expect(res.statusCode).toBe(200);
      const body = payload<{ changed: boolean; status: string; presenceReleased?: boolean }>(res);
      expect(body.changed).toBe(true);
      expect(body.status).toBe('awaiting_documentation');
      expect(body.presenceReleased).toBe(true);

      const fresh = await db.execute(sql`select status from consultations where id = ${id}`);
      expect((fresh.rows as Array<{ status: string }>)[0].status).toBe('awaiting_documentation');
      const doctorRow = await db.execute(sql`select presence from doctors where id = ${fixtures.doctorId}`);
      expect((doctorRow.rows as Array<{ presence: string }>)[0].presence).toBe('available_now');
    });

    it('ending an INSTANT call sets the completion gate instead of releasing presence', async () => {
      const id = await insertConsultation(db, fixtures, { mode: 'instant', status: 'in_progress' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.doctorToken),
      });
      expect(res.statusCode).toBe(200);
      const body = payload<{ changed: boolean; status: string; completionGateSet?: boolean }>(res);
      expect(body.changed).toBe(true);
      expect(body.completionGateSet).toBe(true);

      const doctorRow = await db.execute(sql`select blocked_by_consultation_id from doctors where id = ${fixtures.doctorId}`);
      expect((doctorRow.rows as Array<{ blocked_by_consultation_id: string | null }>)[0].blocked_by_consultation_id).toBe(id);
      // Clear the gate directly for the next test — this file's fixture doctor is reused across cases.
      await db.update(doctorsTable).set({ blockedByConsultationId: null }).where(eq(doctorsTable.id, fixtures.doctorId));
    });

    it('is idempotent: calling it a second time changes nothing', async () => {
      const id = await insertConsultation(db, fixtures, { mode: 'scheduled', status: 'in_progress' });
      const first = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.doctorToken),
      });
      expect(payload<{ changed: boolean }>(first).changed).toBe(true);

      const second = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${id}/end`,
        headers: auth(fixtures.doctorToken),
      });
      expect(second.statusCode).toBe(200);
      expect(payload<{ changed: boolean }>(second).changed).toBe(false);
    });
  });

  /* ======================================================================== */
  /* POST /api/video/webhook — real signature, real HTTP                      */
  /* ======================================================================== */

  describe('POST /api/video/webhook (real LiveKit signature verification)', () => {
    async function post(rawBody: string, authHeader: string | undefined) {
      return app.inject({
        method: 'POST',
        url: '/api/video/webhook',
        headers: { 'content-type': 'application/json', ...(authHeader === undefined ? {} : { authorization: authHeader }) },
        payload: rawBody,
      });
    }

    function eventBody(event: string, roomName: string, participant?: Record<string, unknown>): string {
      return JSON.stringify({
        event,
        id: `evt_${randomUUID()}`,
        room: { name: roomName },
        ...(participant ? { participant } : {}),
      });
    }

    it('401s an unsigned delivery, and writes nothing', async () => {
      const id = await insertConsultation(db, fixtures);
      const body = eventBody('participant_joined', `consult-${id}`, {
        sid: `PA_${randomUUID()}`,
        identity: `patient:${fixtures.patientId}`,
      });
      const res = await post(body, undefined);
      expect(res.statusCode).toBe(401);
      expect(payload<{ code: string }>(res).code).toBe('VIDEO_WEBHOOK_SIGNATURE_INVALID');
      const rows = await db.execute(sql`select count(*)::int as n from consultation_participants where consultation_id = ${id}`);
      expect((rows.rows as Array<{ n: number }>)[0].n).toBe(0);
    });

    it('401s a delivery signed with the WRONG secret', async () => {
      const id = await insertConsultation(db, fixtures);
      const body = eventBody('participant_joined', `consult-${id}`, {
        sid: `PA_${randomUUID()}`,
        identity: `patient:${fixtures.patientId}`,
      });
      const badSig = await signLivekitWebhook(body, apiKey, 'wrong-secret-entirely-not-the-real-one');
      const res = await post(body, badSig);
      expect(res.statusCode).toBe(401);
    });

    it('401s a correctly-signed delivery whose BODY was tampered with after signing', async () => {
      const id = await insertConsultation(db, fixtures);
      const originalBody = eventBody('participant_joined', `consult-${id}`, {
        sid: `PA_${randomUUID()}`,
        identity: `patient:${fixtures.patientId}`,
      });
      const signature = await signLivekitWebhook(originalBody, apiKey, apiSecret);
      const tamperedBody = originalBody.replace('participant_joined', 'room_finished');
      const res = await post(tamperedBody, signature);
      expect(res.statusCode).toBe(401);
    });

    it('200s and ignores an event for a room this platform did not name', async () => {
      const body = eventBody('participant_joined', 'some-other-apps-room-42');
      const signature = await signLivekitWebhook(body, apiKey, apiSecret);
      const res = await post(body, signature);
      expect(res.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(res).outcome).toBe('ignored');
    });

    it('200s and ignores an event type this module does not act on', async () => {
      const id = await insertConsultation(db, fixtures);
      const body = eventBody('room_started', `consult-${id}`);
      const signature = await signLivekitWebhook(body, apiKey, apiSecret);
      const res = await post(body, signature);
      expect(res.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(res).outcome).toBe('ignored');
    });

    it('*** THE REAL SIGNED CHAIN *** participant_joined -> in_progress (and the doctor leaves the routing pool), participant_left, then room_finished -> awaiting_documentation (and the doctor returns to the pool for a SCHEDULED call)', async () => {
      const id = await insertConsultation(db, fixtures, { mode: 'scheduled', status: 'scheduled' });
      await db.update(doctorsTable).set({ presence: 'available_now' }).where(eq(doctorsTable.id, fixtures.doctorId));

      const patientSid = `PA_p_${randomUUID().slice(0, 12)}`;
      const doctorSid = `PA_d_${randomUUID().slice(0, 12)}`;

      const patientJoinBody = eventBody('participant_joined', `consult-${id}`, {
        sid: patientSid,
        identity: `patient:${fixtures.patientId}`,
      });
      const patientJoinSig = await signLivekitWebhook(patientJoinBody, apiKey, apiSecret);
      const patientJoinRes = await post(patientJoinBody, patientJoinSig);
      expect(patientJoinRes.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(patientJoinRes).outcome).toBe('processed');

      const doctorJoinBody = eventBody('participant_joined', `consult-${id}`, {
        sid: doctorSid,
        identity: `doctor:${fixtures.doctorId}`,
      });
      const doctorJoinSig = await signLivekitWebhook(doctorJoinBody, apiKey, apiSecret);
      const doctorJoinRes = await post(doctorJoinBody, doctorJoinSig);
      expect(doctorJoinRes.statusCode).toBe(200);

      // Redelivery of the same join is a genuine no-op, decided by Postgres.
      const replay = await post(patientJoinBody, patientJoinSig);
      expect(payload<{ outcome: string }>(replay).outcome).toBe('duplicate');

      const statusAfterJoin = await db.execute(sql`select status from consultations where id = ${id}`);
      expect((statusAfterJoin.rows as Array<{ status: string }>)[0].status).toBe('in_progress');

      const doctorAfterJoin = await db.execute(sql`select presence from doctors where id = ${fixtures.doctorId}`);
      expect((doctorAfterJoin.rows as Array<{ presence: string }>)[0].presence).toBe('in_consultation');

      const rowsAfterJoin = await db.execute(
        sql`select count(*)::int as n from consultation_participants where consultation_id = ${id}`,
      );
      expect((rowsAfterJoin.rows as Array<{ n: number }>)[0].n).toBe(2);

      const patientLeftBody = eventBody('participant_left', `consult-${id}`, {
        sid: patientSid,
        identity: `patient:${fixtures.patientId}`,
        disconnect_reason: 'CLIENT_INITIATED',
      });
      const patientLeftSig = await signLivekitWebhook(patientLeftBody, apiKey, apiSecret);
      const patientLeftRes = await post(patientLeftBody, patientLeftSig);
      expect(payload<{ outcome: string }>(patientLeftRes).outcome).toBe('processed');

      // One participant leaving is not the end of the call.
      const stillRunning = await db.execute(sql`select status from consultations where id = ${id}`);
      expect((stillRunning.rows as Array<{ status: string }>)[0].status).toBe('in_progress');

      const closedRow = await db.execute(
        sql`select disconnect_reason from consultation_participants where livekit_participant_sid = ${patientSid}`,
      );
      expect((closedRow.rows as Array<{ disconnect_reason: string | null }>)[0].disconnect_reason).toBe('CLIENT_INITIATED');

      const finishedBody = eventBody('room_finished', `consult-${id}`);
      const finishedSig = await signLivekitWebhook(finishedBody, apiKey, apiSecret);
      const finishedRes = await post(finishedBody, finishedSig);
      expect(payload<{ outcome: string }>(finishedRes).outcome).toBe('processed');

      const finalStatus = await db.execute(sql`select status from consultations where id = ${id}`);
      expect((finalStatus.rows as Array<{ status: string }>)[0].status).toBe('awaiting_documentation');

      const doctorAfterEnd = await db.execute(sql`select presence from doctors where id = ${fixtures.doctorId}`);
      expect((doctorAfterEnd.rows as Array<{ presence: string }>)[0].presence).toBe('available_now');

      // A second room_finished is a no-op — decided by `transitionConsultationStatus`, not re-checked here.
      const secondFinish = await post(finishedBody, await signLivekitWebhook(finishedBody, apiKey, apiSecret));
      expect(payload<{ outcome: string }>(secondFinish).outcome).toBe('duplicate');

      const audits = await db.execute(
        sql`select count(*)::int as n from audit_log where consultation_id = ${id} and entity_type = 'video_session'`,
      );
      expect((audits.rows as Array<{ n: number }>)[0].n).toBeGreaterThanOrEqual(3);
    });

    it('an identity naming an account that is NOT this consultation’s patient or doctor is verified but recorded nowhere', async () => {
      const id = await insertConsultation(db, fixtures);
      const body = eventBody('participant_joined', `consult-${id}`, {
        sid: `PA_${randomUUID()}`,
        identity: `patient:${fixtures.otherPatientId}`,
      });
      const signature = await signLivekitWebhook(body, apiKey, apiSecret);
      const res = await post(body, signature);
      expect(res.statusCode).toBe(200);
      expect(payload<{ outcome: string }>(res).outcome).toBe('ignored');
      const rows = await db.execute(sql`select count(*)::int as n from consultation_participants where consultation_id = ${id}`);
      expect((rows.rows as Array<{ n: number }>)[0].n).toBe(0);
    });
  });

  /* ======================================================================== */
  /* admin/video                                                              */
  /* ======================================================================== */

  describe('GET /api/admin/video/config', () => {
    it('401s with no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/video/config' });
      expect(res.statusCode).toBe(401);
    });

    it('403s for a doctor account', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/video/config', headers: auth(fixtures.doctorToken) });
      expect(res.statusCode).toBe(403);
    });

    it('403s for an admin with no appointments.read permission', async () => {
      const token = await mintAdminToken(db, app, fixtures.runId);
      const res = await app.inject({ method: 'GET', url: '/api/admin/video/config', headers: auth(token) });
      expect(res.statusCode).toBe(403);
    });

    it('200s for an admin holding appointments.read', async () => {
      const token = await mintAdminToken(db, app, fixtures.runId, PERMISSIONS.APPOINTMENTS_READ);
      const res = await app.inject({ method: 'GET', url: '/api/admin/video/config', headers: auth(token) });
      expect(res.statusCode).toBe(200);
      const body = payload<{ joinTokenTtlSeconds: number; joinWindowMinutes: number }>(res);
      expect(typeof body.joinTokenTtlSeconds).toBe('number');
      expect(typeof body.joinWindowMinutes).toBe('number');
    });
  });

  describe('PUT /api/admin/video/config', () => {
    it('403s for an admin holding only appointments.read (needs appointments.manage)', async () => {
      const token = await mintAdminToken(db, app, fixtures.runId, PERMISSIONS.APPOINTMENTS_READ);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/video/config',
        headers: auth(token),
        payload: { joinWindowMinutes: 20 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s on a value outside VIDEO_CONFIG_BOUNDS — the ValidationPipe is real', async () => {
      const token = await mintAdminToken(db, app, fixtures.runId, PERMISSIONS.APPOINTMENTS_MANAGE);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/video/config',
        headers: auth(token),
        payload: { joinWindowMinutes: 999 }, // max is 120
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s for an admin holding appointments.manage, writes the value and an audit row, then restores the default', async () => {
      const token = await mintAdminToken(db, app, fixtures.runId, PERMISSIONS.APPOINTMENTS_MANAGE);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/video/config',
        headers: auth(token),
        payload: { joinWindowMinutes: 20 },
      });
      expect(res.statusCode).toBe(200);

      const configRow = await db.execute(sql`select value from app_config where key = 'video.join_window_minutes'`);
      expect(Number((configRow.rows as Array<{ value: unknown }>)[0].value)).toBe(20);

      const auditRow = await db.execute(
        sql`select count(*)::int as n from audit_log where entity_type = 'video_config' and entity_id = 'video.join_window_minutes'`,
      );
      expect((auditRow.rows as Array<{ n: number }>)[0].n).toBeGreaterThanOrEqual(1);

      // Restore, so this file's own earlier join-window assertions (15 minutes) remain valid for any later re-run of this suite.
      const restore = await app.inject({
        method: 'PUT',
        url: '/api/admin/video/config',
        headers: auth(token),
        payload: { joinWindowMinutes: 15 },
      });
      expect(restore.statusCode).toBe(200);
    });
  });

  describe('GET /api/admin/video/consultations/:id/session', () => {
    it('403s for an admin with no appointments.read permission', async () => {
      const id = await insertConsultation(db, fixtures);
      const token = await mintAdminToken(db, app, fixtures.runId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/video/consultations/${id}/session`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('200s for an admin holding appointments.read, for ANY consultation — no ownership check applies to an admin', async () => {
      const id = await insertConsultation(db, fixtures);
      const token = await mintAdminToken(db, app, fixtures.runId, PERMISSIONS.APPOINTMENTS_READ);
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/video/consultations/${id}/session`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      expect(payload<{ consultationId: string }>(res).consultationId).toBe(id);
    });
  });
});
