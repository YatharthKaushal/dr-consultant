/**
 * *** CLARIFICATION OVER REAL HTTP. ***
 *
 * Drives every route in `clarification.controller.ts` (doctor-facing, both
 * the treating-doctor and expert roles) and `clarification-admin.controller
 * .ts` (governance) through `createConfiguredApp()` + `app.inject()` — the
 * same mechanism `app.e2e.integration.spec.ts` established — so the real
 * guard/pipe/service/database chain runs for every request.
 *
 * *** WHY TOKENS ARE MINTED DIRECTLY. *** See `governance.endpoint.spec.ts`'s
 * identical note: `IdentityTokenService.mintTokenPair` produces a real,
 * signed JWT verified through the SAME `resolveAccessToken` path
 * `JwtAuthGuard` calls. Proving the OTP sign-in screen is
 * `app.e2e.integration.spec.ts`'s job, not this file's.
 *
 * ── THE TWO CHECKS THIS FILE EXISTS TO PROVE OVER REAL HTTP ────────────────
 *
 * CHECK #1, "WHO MAY BE ASKED": `POST /admin/clarification-cases/:id/assign`
 * refuses a non-expert doctor with 409 `NOT_AN_EXPERT` — proved here by
 * actually trying to assign a `standard`-seniority doctor, not by reading
 * the service's own claim about it.
 *
 * CHECK #2, "WHAT THEY MAY SEE": two REAL cases are seeded, assigned to two
 * DIFFERENT experts. Expert A's `GET assigned` list is asserted to never
 * contain expert B's case id, and a direct `GET assigned/:id` by expert A
 * for expert B's case answers 404 — never 403, which would leak that the
 * case exists at all. `clarification.service.ts`'s own header says this was
 * "adversarially tested at the service layer already" — this proves it
 * holds through the real HTTP stack too, not only against a mocked
 * repository.
 *
 * ── THE DE-IDENTIFICATION GUARANTEE, PROVED STRUCTURALLY OVER HTTP ─────────
 *
 * `CreateClarificationCaseDto` has no `patientName`/`patientPhone`/
 * `patientAddress`/`patientEmail` field, and `clarification_cases` has no
 * such column — so this file POSTs a case with those four fields included
 * in the body ANYWAY (a client trying to send them, or a stale client build)
 * and asserts: (a) the global `ValidationPipe({ whitelist: true })` strips
 * them silently (201, not 400 — `app.bootstrap.ts` never sets
 * `forbidNonWhitelisted`), and (b) the raw JSON response text contains none
 * of the values that would have leaked, proving there is nowhere left for
 * them to travel through even a whitelist-bypass bug.
 *
 * Requires a reachable Postgres — reads `.env`/`.env.local` exactly as
 * `app.e2e.integration.spec.ts` does, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { clarificationCasesTable } from '../../schema/clarification-cases.schema';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
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
  specialtyId: string;
  patientId: string;
  treatingDoctor1Id: string;
  treatingDoctor2Id: string;
  expertAId: string;
  expertBId: string;
  standardDoctorId: string; // verified but NOT expert — CHECK #1's negative case
  adminFullId: string; // governance.read_clarifications + governance.manage_clarifications
  adminReadOnlyId: string; // governance.read_clarifications only
  adminNoneId: string;
  /** A real clinical record's consultation id — the one legal `sourceConsultationId`. */
  validSourceConsultationId: string;
}

async function grant(db: Database, adminId: string, key: string): Promise<void> {
  const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
  if (!permission) throw new Error(`Permission "${key}" is not seeded — has identity.seed.ts run against this database?`);
  await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permission.id });
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const mobile = (seq: number) => `CLR${runId}${seq}`.slice(0, 16);

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `clr_${runId}`, name: `Clarification Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: mobile(1), fullName: `Clarification Patient ${runId}` })
    .returning({ id: patientsTable.id });

  const [treatingDoctor1] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(2), fullName: `Treating Doctor 1 ${runId}` })
    .returning({ id: doctorsTable.id });
  const [treatingDoctor2] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(3), fullName: `Treating Doctor 2 ${runId}` })
    .returning({ id: doctorsTable.id });
  const [expertA] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(4), fullName: `Expert A ${runId}`, verificationStatus: 'verified', seniorityLevel: 'expert' })
    .returning({ id: doctorsTable.id });
  const [expertB] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(5), fullName: `Expert B ${runId}`, verificationStatus: 'verified', seniorityLevel: 'expert' })
    .returning({ id: doctorsTable.id });
  const [standardDoctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(6), fullName: `Standard Doctor ${runId}`, verificationStatus: 'verified', seniorityLevel: 'standard' })
    .returning({ id: doctorsTable.id });

  await db.insert(doctorSpecialtiesTable).values([
    { doctorId: treatingDoctor1.id, specialtyId: specialty.id },
    { doctorId: treatingDoctor2.id, specialtyId: specialty.id },
  ]);

  const [adminFull] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(7), fullName: `Clarification Admin (full) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminReadOnly] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(8), fullName: `Clarification Admin (read only) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(9), fullName: `Clarification Admin (none) ${runId}` })
    .returning({ id: adminsTable.id });

  await grant(db, adminFull.id, PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS);
  await grant(db, adminFull.id, PERMISSIONS.GOVERNANCE_MANAGE_CLARIFICATIONS);
  await grant(db, adminReadOnly.id, PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS);

  // One real clinical record — the only legal `sourceConsultationId`.
  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `CLR${runId}SRC`.slice(0, 24),
      patientId: patient.id,
      doctorId: treatingDoctor1.id,
      specialtyId: specialty.id,
      mode: 'scheduled',
      durationMinutes: 30,
    })
    .returning({ id: consultationsTable.id });
  await db.insert(clinicalRecordsTable).values({ consultationId: consultation.id, chiefComplaint: 'fixture', riskCategory: 'low' });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    treatingDoctor1Id: treatingDoctor1.id,
    treatingDoctor2Id: treatingDoctor2.id,
    expertAId: expertA.id,
    expertBId: expertB.id,
    standardDoctorId: standardDoctor.id,
    adminFullId: adminFull.id,
    adminReadOnlyId: adminReadOnly.id,
    adminNoneId: adminNone.id,
    validSourceConsultationId: consultation.id,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const doctorIds = [
    fixtures.treatingDoctor1Id,
    fixtures.treatingDoctor2Id,
    fixtures.expertAId,
    fixtures.expertBId,
    fixtures.standardDoctorId,
  ];
  const adminIds = [fixtures.adminFullId, fixtures.adminReadOnlyId, fixtures.adminNoneId];

  await db.delete(clarificationCasesTable).where(inArray(clarificationCasesTable.treatingDoctorId, doctorIds));
  await db.delete(clinicalRecordsTable).where(eq(clinicalRecordsTable.consultationId, fixtures.validSourceConsultationId));
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.validSourceConsultationId));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

describe('*** CLARIFICATION — every route, real HTTP ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: {
    treatingDoctor1: string;
    treatingDoctor2: string;
    expertA: string;
    expertB: string;
    standardDoctor: string;
    adminFull: string;
    adminReadOnly: string;
    adminNone: string;
    patient: string;
  };

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'admin' | 'doctor' | 'patient', id: string) =>
      (await tokenService.mintTokenPair(accountType, id, 0)).accessToken;

    tokens = {
      treatingDoctor1: await mint('doctor', fixtures.treatingDoctor1Id),
      treatingDoctor2: await mint('doctor', fixtures.treatingDoctor2Id),
      expertA: await mint('doctor', fixtures.expertAId),
      expertB: await mint('doctor', fixtures.expertBId),
      standardDoctor: await mint('doctor', fixtures.standardDoctorId),
      adminFull: await mint('admin', fixtures.adminFullId),
      adminReadOnly: await mint('admin', fixtures.adminReadOnlyId),
      adminNone: await mint('admin', fixtures.adminNoneId),
      patient: await mint('patient', fixtures.patientId),
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

  const validCasePayload = (overrides: Record<string, unknown> = {}) => ({
    title: 'Persistent low mood, needs a second opinion',
    briefHistory: 'Six weeks of low energy and poor sleep, no prior psychiatric history.',
    specificDoubt: 'Would you start an SSRI now or wait for one more review?',
    urgency: 'soon',
    ...overrides,
  });

  /* ====================================================================== */
  /* POST /clarification-cases — create a draft                             */
  /* ====================================================================== */

  describe('POST /api/clarification-cases', () => {
    it('401s with no token', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/clarification-cases', payload: validCasePayload() });
      expect(response.statusCode).toBe(401);
    });

    it('403s for a patient token — this whole module is doctor-only, on purpose (FR-12.7: nothing reaches the patient)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.patient),
        payload: validCasePayload(),
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('400s on a DTO validation failure (missing required specificDoubt)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: { title: 'x', briefHistory: 'y' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('404s when sourceConsultationId does not match any real clinical record', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ sourceConsultationId: randomUUID() }),
      });
      expect(response.statusCode).toBe(404);
    });

    it('201s with a real sourceConsultationId, and the created draft carries the deidentificationNotice', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ sourceConsultationId: fixtures.validSourceConsultationId }),
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ status: string; sourceConsultationId: string; deidentificationNotice?: string }>(response);
      expect(body.status).toBe('draft');
      expect(body.sourceConsultationId).toBe(fixtures.validSourceConsultationId);
      expect(typeof body.deidentificationNotice).toBe('string');
    });

    /**
     * *** THE DE-IDENTIFICATION GUARANTEE, OVER REAL HTTP. *** A client
     * (malicious or just stale) sends four fields the DTO does not declare
     * and the table has no column for. Proves the whitelist strips them
     * (201, not a leak) and that the raw response text carries none of the
     * values — never a field FOR name/phone/address/email, over the wire.
     */
    it('strips patientName/patientPhone/patientAddress/patientEmail — there is no field for a direct identifier anywhere in the response', async () => {
      const leakAttempt = {
        ...validCasePayload(),
        patientName: 'Jane Q. Doe',
        patientPhone: '+919999999999',
        patientAddress: '221B Baker Street',
        patientEmail: 'jane.doe@example.com',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: leakAttempt,
      });
      expect(response.statusCode).toBe(201);

      const rawBody = response.payload;
      expect(rawBody).not.toContain('Jane Q. Doe');
      expect(rawBody).not.toContain('+919999999999');
      expect(rawBody).not.toContain('221B Baker Street');
      expect(rawBody).not.toContain('jane.doe@example.com');

      const body = payload<Record<string, unknown>>(response);
      for (const forbiddenKey of ['patientName', 'patientPhone', 'patientAddress', 'patientEmail']) {
        expect(Object.keys(body)).not.toContain(forbiddenKey);
      }

      // And the row that actually landed in Postgres carries none of it either — never trust only the HTTP response.
      const raw = await db
        .select()
        .from(clarificationCasesTable)
        .where(eq(clarificationCasesTable.id, (body as { id: string }).id));
      const columns = Object.keys(raw[0]);
      expect(columns).not.toContain('patientName');
      expect(columns).not.toContain('patientPhone');
      expect(columns).not.toContain('patientAddress');
      expect(columns).not.toContain('patientEmail');
    });
  });

  /* ====================================================================== */
  /* The full lifecycle of ONE case — post, own reads, ownership leaks       */
  /* ====================================================================== */

  describe('the treating doctor\'s own lifecycle: draft -> posted, edit rules, ownership', () => {
    let caseId: string;

    it('creates a draft, then GET :id returns it to its own treating doctor', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ title: 'Lifecycle case' }),
      });
      expect(created.statusCode).toBe(201);
      caseId = payload<{ id: string }>(created).id;

      const own = await app.inject({
        method: 'GET',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(own.statusCode).toBe(200);
      expect(payload<{ id: string; status: string }>(own).status).toBe('draft');
    });

    it('404s (never 403) when a DIFFERENT doctor reads it — ownership leak check', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor2),
      });
      expect(response.statusCode).toBe(404);
    });

    it('PUT edits the draft in place', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor1),
        payload: { title: 'Lifecycle case, edited' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ title: string }>(response).title).toBe('Lifecycle case, edited');
    });

    it('404s when a different doctor tries to edit it', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor2),
        payload: { title: 'hijack attempt' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('POST :id/post moves draft -> posted', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseId}/post`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string; deidentificationNotice?: string }>(response).status).toBe('posted');
    });

    it('409s (NOT_A_DRAFT) editing a posted case — no "edit a posted case" path', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor1),
        payload: { title: 'too late' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CLARIFICATION_NOT_A_DRAFT');
    });

    it('the deidentificationNotice is gone once posted — nothing left for it to act on', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/clarification-cases/${caseId}`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(response.statusCode).toBe(200);
      expect(Object.keys(payload<Record<string, unknown>>(response))).not.toContain('deidentificationNotice');
    });

    it('409s (ILLEGAL_TRANSITION) posting an already-posted case', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseId}/post`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CLARIFICATION_ILLEGAL_TRANSITION');
    });

    it('404s when a different doctor tries to post/close it, never 403', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseId}/close`,
        headers: bearer(tokens.treatingDoctor2),
      });
      expect(response.statusCode).toBe(404);
    });

    it('GET (list own) for treatingDoctor1 includes this case; for treatingDoctor2 it does not', async () => {
      const mine = await app.inject({ method: 'GET', url: '/api/clarification-cases', headers: bearer(tokens.treatingDoctor1) });
      expect(mine.statusCode).toBe(200);
      const mineIds = payload<Array<{ id: string }>>(mine).map((c) => c.id);
      expect(mineIds).toContain(caseId);

      const theirs = await app.inject({ method: 'GET', url: '/api/clarification-cases', headers: bearer(tokens.treatingDoctor2) });
      expect(theirs.statusCode).toBe(200);
      const theirIds = payload<Array<{ id: string }>>(theirs).map((c) => c.id);
      expect(theirIds).not.toContain(caseId);
    });
  });

  /* ====================================================================== */
  /* Admin: assignment — CHECK #1 "who may be asked"                        */
  /* ====================================================================== */

  describe('admin assignment — governance.manage_clarifications, CHECK #1', () => {
    let postedCaseId: string;

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ title: 'Assignment target' }),
      });
      postedCaseId = payload<{ id: string }>(created).id;
      const posted = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${postedCaseId}/post`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(posted.statusCode).toBe(200);
    });

    it('401s with no token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        payload: { expertDoctorId: fixtures.expertAId },
      });
      expect(response.statusCode).toBe(401);
    });

    it('403s for an admin holding governance.read_clarifications but NOT governance.manage_clarifications', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        headers: bearer(tokens.adminReadOnly),
        payload: { expertDoctorId: fixtures.expertAId },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('400s on a DTO validation failure (expertDoctorId not a UUID)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('409s (NOT_AN_EXPERT) assigning a verified doctor who is NOT seniority=expert — CHECK #1 enforced', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: fixtures.standardDoctorId },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CLARIFICATION_NOT_AN_EXPERT');
    });

    it('200s assigning a genuine expert — posted -> awaiting_response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: fixtures.expertAId },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string; expertDoctorId: string }>(response);
      expect(body.status).toBe('awaiting_response');
      expect(body.expertDoctorId).toBe(fixtures.expertAId);
    });

    it('409s (ILLEGAL_TRANSITION) assigning again — no longer posted', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${postedCaseId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: fixtures.expertBId },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CLARIFICATION_ILLEGAL_TRANSITION');
    });
  });

  /* ====================================================================== */
  /* Admin tracker — governance.read_clarifications                         */
  /* ====================================================================== */

  describe('admin tracker reads — governance.read_clarifications', () => {
    it('401s / 403s the list and detail reads without the permission', async () => {
      const noToken = await app.inject({ method: 'GET', url: '/api/admin/clarification-cases' });
      expect(noToken.statusCode).toBe(401);

      const wrongType = await app.inject({
        method: 'GET',
        url: '/api/admin/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');

      const noPermission = await app.inject({
        method: 'GET',
        url: '/api/admin/clarification-cases',
        headers: bearer(tokens.adminNone),
      });
      expect(noPermission.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPermission).code).toBe('PERMISSION_DENIED');
    });

    it('200s the list AND the detail read for an admin holding the permission — includes sourceConsultationId (the full governance view, not the expert view)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ title: 'Admin tracker target', sourceConsultationId: fixtures.validSourceConsultationId }),
      });
      const caseId = payload<{ id: string }>(created).id;

      const list = await app.inject({
        method: 'GET',
        url: '/api/admin/clarification-cases?status=draft',
        headers: bearer(tokens.adminReadOnly),
      });
      expect(list.statusCode).toBe(200);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/clarification-cases/${caseId}`,
        headers: bearer(tokens.adminReadOnly),
      });
      expect(detail.statusCode).toBe(200);
      const body = payload<{ sourceConsultationId: string | null }>(detail);
      expect(body.sourceConsultationId).toBe(fixtures.validSourceConsultationId);
    });

    it('404s the detail read for a well-formed but non-existent case id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/clarification-cases/${randomUUID()}`,
        headers: bearer(tokens.adminReadOnly),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* CHECK #2, over real HTTP: the expert's read scope                      */
  /* ====================================================================== */

  describe('CHECK #2 — the expert never sees another expert\'s case', () => {
    let caseForExpertA: string;
    let caseForExpertB: string;

    beforeAll(async () => {
      // Case for expert A, via treatingDoctor1.
      const createdA = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor1),
        payload: validCasePayload({ title: 'For expert A', sourceConsultationId: fixtures.validSourceConsultationId }),
      });
      caseForExpertA = payload<{ id: string }>(createdA).id;
      await app.inject({ method: 'POST', url: `/api/clarification-cases/${caseForExpertA}/post`, headers: bearer(tokens.treatingDoctor1) });
      const assignA = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${caseForExpertA}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: fixtures.expertAId },
      });
      expect(assignA.statusCode).toBe(200);

      // Case for expert B, via treatingDoctor2 — a genuinely different case.
      const createdB = await app.inject({
        method: 'POST',
        url: '/api/clarification-cases',
        headers: bearer(tokens.treatingDoctor2),
        payload: validCasePayload({ title: 'For expert B' }),
      });
      caseForExpertB = payload<{ id: string }>(createdB).id;
      await app.inject({ method: 'POST', url: `/api/clarification-cases/${caseForExpertB}/post`, headers: bearer(tokens.treatingDoctor2) });
      const assignB = await app.inject({
        method: 'POST',
        url: `/api/admin/clarification-cases/${caseForExpertB}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { expertDoctorId: fixtures.expertBId },
      });
      expect(assignB.statusCode).toBe(200);
    });

    it('expert A\'s GET /assigned list contains their own case, and NEVER expert B\'s', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/clarification-cases/assigned',
        headers: bearer(tokens.expertA),
      });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((c) => c.id);
      expect(ids).toContain(caseForExpertA);
      expect(ids).not.toContain(caseForExpertB);
    });

    it('expert B\'s GET /assigned list contains their own case, and NEVER expert A\'s', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/clarification-cases/assigned',
        headers: bearer(tokens.expertB),
      });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((c) => c.id);
      expect(ids).toContain(caseForExpertB);
      expect(ids).not.toContain(caseForExpertA);
    });

    it('expert A reading their OWN assigned case gets 200, and the expert view has no sourceConsultationId field at all', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/clarification-cases/assigned/${caseForExpertA}`,
        headers: bearer(tokens.expertA),
      });
      expect(response.statusCode).toBe(200);
      const body = payload<Record<string, unknown>>(response);
      expect(Object.keys(body)).not.toContain('sourceConsultationId');
      // And the value that WOULD have leaked is not anywhere in the raw text either.
      expect(response.payload).not.toContain(fixtures.validSourceConsultationId);
    });

    it('*** THE CRITICAL CHECK *** — expert A reading expert B\'s case by id gets 404, never 403 (never confirms it exists)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/clarification-cases/assigned/${caseForExpertB}`,
        headers: bearer(tokens.expertA),
      });
      expect(response.statusCode).toBe(404);
    });

    it('expert A cannot respond to expert B\'s case either — same 404, not 403, and nothing is written', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/assigned/${caseForExpertB}/respond`,
        headers: bearer(tokens.expertA),
        payload: { messageType: 'comment', body: 'trying to reach a case that is not mine' },
      });
      expect(response.statusCode).toBe(404);

      const row = await db
        .select({ messages: clarificationCasesTable.messages })
        .from(clarificationCasesTable)
        .where(eq(clarificationCasesTable.id, caseForExpertB));
      expect((row[0].messages as unknown[]).length).toBe(0);
    });

    it('400s a respond call with an invalid messageType', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/assigned/${caseForExpertA}/respond`,
        headers: bearer(tokens.expertA),
        payload: { messageType: 'not-a-real-type', body: 'x' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('expert A responds with a comment: awaiting_response -> response_received', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/assigned/${caseForExpertA}/respond`,
        headers: bearer(tokens.expertA),
        payload: { messageType: 'comment', body: 'Suggest starting sertraline 50mg.' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('response_received');
    });

    it('409s a second respond call — the expert cannot pile a second message onto their own turn', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/assigned/${caseForExpertA}/respond`,
        headers: bearer(tokens.expertA),
        payload: { messageType: 'comment', body: 'again' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CLARIFICATION_ILLEGAL_TRANSITION');
    });

    it('the treating doctor marks it reviewed, then closes it', async () => {
      const reviewed = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseForExpertA}/review`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(reviewed.statusCode).toBe(200);
      expect(payload<{ status: string }>(reviewed).status).toBe('reviewed');

      const closed = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseForExpertA}/close`,
        headers: bearer(tokens.treatingDoctor1),
      });
      expect(closed.statusCode).toBe(200);
      expect(payload<{ status: string; closedAt: string | null }>(closed).status).toBe('closed');
      expect(payload<{ closedAt: string | null }>(closed).closedAt).not.toBeNull();
    });

    it('expert B requests clarification instead: awaiting_response -> clarification_asked, then the treating doctor replies back to awaiting_response', async () => {
      const asked = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/assigned/${caseForExpertB}/respond`,
        headers: bearer(tokens.expertB),
        payload: { messageType: 'clarification_request', body: 'What was the actual dose used last time?' },
      });
      expect(asked.statusCode).toBe(200);
      expect(payload<{ status: string }>(asked).status).toBe('clarification_asked');

      // The wrong doctor cannot reply on someone else's case — same 404 discipline.
      const wrongReplier = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseForExpertB}/reply`,
        headers: bearer(tokens.treatingDoctor1),
        payload: { messageType: 'comment', body: 'not my case' },
      });
      expect(wrongReplier.statusCode).toBe(404);

      const replied = await app.inject({
        method: 'POST',
        url: `/api/clarification-cases/${caseForExpertB}/reply`,
        headers: bearer(tokens.treatingDoctor2),
        payload: { messageType: 'comment', body: '20mg, once daily.' },
      });
      expect(replied.statusCode).toBe(200);
      expect(payload<{ status: string; messages: unknown[] }>(replied).status).toBe('awaiting_response');
      expect(payload<{ messages: unknown[] }>(replied).messages.length).toBe(2);
    });
  });
});
