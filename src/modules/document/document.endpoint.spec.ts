/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR M-10 DOCUMENT. ***
 *
 * Every other spec here calls `PatientFileService`/`ReportRequestService`
 * directly, or (`patient-file.transaction.integration.spec.ts`) against real
 * Postgres but still through the service, never through a real multipart
 * HTTP request. This file drives every route on `DocumentController` and
 * `DocumentConsultationController` through `app.inject()` against the REAL
 * application — including a REAL multipart/form-data body, since
 * `@fastify/multipart` is registered globally by `app.bootstrap.ts` and
 * nothing in this repo has driven it end to end before.
 *
 * *** STORAGE IS STUBBED, DELIBERATELY, AT THE REAL DI-RESOLVED FACADE. ***
 * This dev database's `storage_providers` rows (s3, cloudinary) have no
 * environment credentials configured (`StorageRotationService` logs exactly
 * this at boot), so a real `StorageFacade.store()`/`getSignedUrl()` call
 * would genuinely throw and every upload/download in this file would 503
 * with `DOCUMENT_STORAGE_UNAVAILABLE` — a fact about this dev environment's
 * credentials, not about `modules/document`'s own logic, which is what this
 * file is testing. `jest.spyOn(app.get(StorageFacade), ...)` is the same
 * sanctioned pattern `app.e2e.integration.spec.ts` uses for
 * `RazorpayClient`/`ClinicalPdfService` — stubbing a real, DI-resolved
 * instance's method, not hand-wiring a fake module.
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
import { auditLogTable } from '../../schema/audit-log.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientFilesTable } from '../../schema/patient-files.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { reportRequestsTable } from '../../schema/report-requests.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { StorageFacade } from '../storage/storage.facade';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

/** An 8-byte PNG signature (`file-content-type.util.ts#sniffMimeType`) plus arbitrary padding — sniffs as `image/png` regardless of what a caller declares. */
function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body-for-endpoint-test')]);
}

/** Builds a real multipart/form-data body: text fields plus one file part, in that order (fields BEFORE the file — `multipart-file.util.ts` only guarantees fields placed before or after the file are both read, but before is simplest to reason about here). */
function buildMultipart(fields: Record<string, string>, file: { fieldName?: string; fileName: string; contentType: string; bytes: Buffer } | null): { body: Buffer; contentType: string } {
  const boundary = `----EndpointTestBoundary${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName ?? 'file'}"; filename="${file.fileName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  patient2Id: string;
  doctorId: string;
  otherDoctorId: string;
  consultationId: string; // open, patient <-> doctor
  completedConsultationId: string; // completed, patient <-> doctor
  adminClinicalReadId: string; // clinical.read_records
  adminNoPermId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9193${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `docep_${runId}`, name: `Document Endpoint Specialty ${runId}`, canPrescribe: false })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Doc Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [patient2] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Doc Endpoint Patient 2 ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  async function makeDoctor(label: string): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}`, verificationStatus: 'verified', isListed: true })
      .returning({ id: doctorsTable.id });
    await db.insert(doctorSpecialtiesTable).values({ doctorId: row.id, specialtyId: specialty.id, isPrimary: true });
    return row.id;
  }
  const doctorId = await makeDoctor('Doc Endpoint Doctor');
  const otherDoctorId = await makeDoctor('Doc Endpoint Other Doctor');

  async function makeConsultation(status: 'scheduled' | 'completed', suffix: string): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `DOCEP-${runId}-${suffix}`,
        patientId: patient.id,
        doctorId,
        specialtyId: specialty.id,
        mode: 'scheduled',
        status,
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }
  const consultationId = await makeConsultation('scheduled', '1');
  const completedConsultationId = await makeConsultation('completed', '2');

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` }).returning({ id: adminsTable.id });
    return row.id;
  }
  const adminClinicalReadId = await makeAdmin('Doc Admin ClinicalRead');
  const adminNoPermId = await makeAdmin('Doc Admin NoPerm');

  const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, 'clinical.read_records'));
  if (!permission) throw new Error('Expected clinical.read_records to be seeded in `permissions` (run npm run db:seed).');
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminClinicalReadId, permissionId: permission.id });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    patient2Id: patient2.id,
    doctorId,
    otherDoctorId,
    consultationId,
    completedConsultationId,
    adminClinicalReadId,
    adminNoPermId,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [fixtures.adminClinicalReadId, fixtures.adminNoPermId];
  const doctorIds = [fixtures.doctorId, fixtures.otherDoctorId];
  const patientIds = [fixtures.patientId, fixtures.patient2Id];
  const consultationIds = [fixtures.consultationId, fixtures.completedConsultationId];

  await db.delete(patientFilesTable).where(inArray(patientFilesTable.patientId, patientIds));
  await db.delete(reportRequestsTable).where(inArray(reportRequestsTable.consultationId, consultationIds));
  // `audit_log.actor_id`/`entity_id`/`consultation_id` carry no FK (see that
  // schema's own comment), so leaving a row behind cannot block any delete
  // below — cleaned up anyway, by both consultation and actor, since an
  // upload with no `consultationId` at all (several in this file) writes an
  // audit row the consultation-scoped clause alone would miss.
  await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, [...patientIds, ...doctorIds, ...adminIds]));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/* -------------------------------------------------------------------------- */

describe('M-10 Document — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let patientToken: string;
  let patient2Token: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  let adminClinicalReadToken: string;
  let adminNoPermToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    // Stubbed for the reason explained in the file header — no real S3/Cloudinary credentials exist here.
    jest.spyOn(app.get(StorageFacade), 'store').mockImplementation(async (input) => ({
      storageKey: `test-storage-key/${randomUUID()}/${input.fileName}`,
      sizeBytes: input.buffer.length,
    }));
    jest.spyOn(app.get(StorageFacade), 'getSignedUrl').mockImplementation(async (storageKey) => `https://storage.test.invalid/${storageKey}?signed=1`);

    const tokenService = app.get(IdentityTokenService);
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
    patient2Token = (await tokenService.mintTokenPair('patient', fixtures.patient2Id, 0)).accessToken;
    doctorToken = (await tokenService.mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
    otherDoctorToken = (await tokenService.mintTokenPair('doctor', fixtures.otherDoctorId, 0)).accessToken;
    adminClinicalReadToken = (await tokenService.mintTokenPair('admin', fixtures.adminClinicalReadId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
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

  async function upload(token: string, fields: Record<string, string>, opts: { noFile?: boolean; contentType?: string; bytes?: Buffer } = {}) {
    const { body, contentType } = buildMultipart(
      fields,
      opts.noFile ? null : { fileName: 'test.png', contentType: opts.contentType ?? 'image/png', bytes: opts.bytes ?? pngBytes() },
    );
    return app.inject({ method: 'POST', url: '/api/documents', headers: { ...auth(token), 'content-type': contentType }, payload: body });
  }

  /* ====================================================================== */
  /* POST /documents — real multipart, real StorageFacade (stubbed)          */
  /* ====================================================================== */

  describe('POST /documents — multipart upload', () => {
    it('uploads a photo with no consultationId', async () => {
      const res = await upload(patientToken, { category: 'photo' });
      expect(res.statusCode).toBe(201);
      const body = payload<{ id: string; fileCategory: string; fileName: string; consultationId: string | null }>(res);
      expect(body.fileCategory).toBe('photo');
      expect(body.consultationId).toBeNull();
      expect((body as unknown as { storageKey?: unknown }).storageKey).toBeUndefined();

      const [row] = await db.select().from(patientFilesTable).where(eq(patientFilesTable.id, body.id));
      expect(row.patientId).toBe(fixtures.patientId);
      expect(row.storageKey).toMatch(/^test-storage-key\//);
    });

    it('uploads against the caller\'s own consultationId; a consultation belonging to someone else 404s', async () => {
      const own = await upload(patientToken, { category: 'report', consultationId: fixtures.consultationId });
      expect(own.statusCode).toBe(201);
      expect(payload<{ consultationId: string }>(own).consultationId).toBe(fixtures.consultationId);

      const notMine = await upload(patient2Token, { category: 'report', consultationId: fixtures.consultationId });
      expect(notMine.statusCode).toBe(404);
      expect(payload<{ code: string }>(notMine).code).toBe('DOCUMENT_CONSULTATION_NOT_FOUND');
    });

    it('a reportRequestId fulfils the open request atomically; an already-closed one is refused 409', async () => {
      const [reportRequest] = await db
        .insert(reportRequestsTable)
        .values({ consultationId: fixtures.consultationId, title: `Blood test ${fixtures.runId}` })
        .returning({ id: reportRequestsTable.id });

      const res = await upload(patientToken, { category: 'report', reportRequestId: reportRequest.id });
      expect(res.statusCode).toBe(201);
      const body = payload<{ consultationId: string; reportRequestId: string }>(res);
      expect(body.consultationId).toBe(fixtures.consultationId);
      expect(body.reportRequestId).toBe(reportRequest.id);

      const [updated] = await db.select({ status: reportRequestsTable.status }).from(reportRequestsTable).where(eq(reportRequestsTable.id, reportRequest.id));
      expect(updated.status).toBe('fulfilled');

      const again = await upload(patientToken, { category: 'report', reportRequestId: reportRequest.id });
      expect(again.statusCode).toBe(409);
      expect(payload<{ code: string }>(again).code).toBe('DOCUMENT_REPORT_REQUEST_NOT_OPEN');
    });

    it('a reportRequestId belonging to another patient\'s consultation 404s', async () => {
      const [reportRequest] = await db
        .insert(reportRequestsTable)
        .values({ consultationId: fixtures.consultationId, title: `Not yours ${fixtures.runId}` })
        .returning({ id: reportRequestsTable.id });
      const res = await upload(patient2Token, { category: 'report', reportRequestId: reportRequest.id });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('DOCUMENT_REPORT_REQUEST_NOT_FOUND');
    });

    it('a consultationId that disagrees with the reportRequestId\'s own consultation is refused 400', async () => {
      const [reportRequest] = await db
        .insert(reportRequestsTable)
        .values({ consultationId: fixtures.consultationId, title: `Mismatch ${fixtures.runId}` })
        .returning({ id: reportRequestsTable.id });
      const res = await upload(patientToken, { category: 'report', reportRequestId: reportRequest.id, consultationId: fixtures.completedConsultationId });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('prescription_pdf and clarification_attachment are rejected by NAME, not just "unknown category"', async () => {
      const prescription = await upload(patientToken, { category: 'prescription_pdf' });
      expect(prescription.statusCode).toBe(400);
      expect(payload<{ code: string }>(prescription).code).toBe('DOCUMENT_CATEGORY_NOT_UPLOADABLE');

      const clarification = await upload(patientToken, { category: 'clarification_attachment' });
      expect(clarification.statusCode).toBe(400);
      expect(payload<{ code: string }>(clarification).code).toBe('DOCUMENT_CATEGORY_NOT_UPLOADABLE');

      const unknown = await upload(patientToken, { category: 'not_a_real_category' });
      expect(unknown.statusCode).toBe(400);
      expect(payload<{ code: string }>(unknown).code).toBe('DOCUMENT_CATEGORY_NOT_UPLOADABLE');
    });

    it('a declared content-type that disagrees with the actual bytes is refused 415 — never revealing which check failed', async () => {
      // Real PNG bytes, declared as image/jpeg.
      const res = await upload(patientToken, { category: 'photo' }, { contentType: 'image/jpeg' });
      expect(res.statusCode).toBe(415);
      expect(payload<{ code: string }>(res).code).toBe('DOCUMENT_INVALID_FILE_TYPE');
    });

    it('a content-type outright unsupported (e.g. text/plain) is refused 415', async () => {
      const res = await upload(patientToken, { category: 'photo' }, { contentType: 'text/plain', bytes: Buffer.from('just some text, not a real file') });
      expect(res.statusCode).toBe(415);
    });

    it('a request with no file part at all is refused 400 MULTIPART_NO_FILE', async () => {
      const res = await upload(patientToken, { category: 'photo' }, { noFile: true });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('MULTIPART_NO_FILE');
    });

    it('unauthenticated is 401, wrong account type (doctor token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const { body, contentType } = buildMultipart({ category: 'photo' }, { fileName: 'x.png', contentType: 'image/png', bytes: pngBytes() });
      const anon = await app.inject({ method: 'POST', url: '/api/documents', headers: { 'content-type': contentType }, payload: body });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'POST', url: '/api/documents', headers: { ...auth(doctorToken), 'content-type': contentType }, payload: body });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* GET /documents/me                                                       */
  /* ====================================================================== */

  describe('GET /documents/me', () => {
    it("lists only the caller's own files, filterable by category", async () => {
      await upload(patientToken, { category: 'medical_history' });
      const all = await app.inject({ method: 'GET', url: '/api/documents/me', headers: auth(patientToken) });
      expect(all.statusCode).toBe(200);
      const rows = payload<Array<{ fileCategory: string; patientId: string }>>(all);
      expect(rows.length).toBeGreaterThan(0);

      const filtered = await app.inject({ method: 'GET', url: '/api/documents/me?category=medical_history', headers: auth(patientToken) });
      expect(payload<Array<{ fileCategory: string }>>(filtered).every((r) => r.fileCategory === 'medical_history')).toBe(true);

      const other = await app.inject({ method: 'GET', url: '/api/documents/me', headers: auth(patient2Token) });
      const otherIds = payload<Array<{ patientId: string }>>(other).map((r) => r.patientId);
      expect(new Set(otherIds)).not.toContain(fixtures.patientId);
    });

    it('validation: an unknown category is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents/me?category=not_a_real_category', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* GET /documents/:id/download — ownership AND the prescription_pdf gate   */
  /* ====================================================================== */

  describe('GET /documents/:id/download', () => {
    async function insertFile(category: 'photo' | 'prescription_pdf', patientId: string, consultationId: string | null = null): Promise<string> {
      const [row] = await db
        .insert(patientFilesTable)
        .values({
          fileCategory: category,
          patientId,
          consultationId,
          storageKey: `test-storage-key/${randomUUID()}`,
          fileName: `${category}-${randomUUID()}.pdf`,
        })
        .returning({ id: patientFilesTable.id });
      return row.id;
    }

    it('the owning patient downloads; an unrelated patient gets the SAME 404 a nonexistent id gets', async () => {
      const fileId = await insertFile('photo', fixtures.patientId);

      const owner = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(patientToken) });
      expect(owner.statusCode).toBe(200);
      const body = payload<{ url: string; expiresAt: string }>(owner);
      expect(body.url).toContain('signed=1');

      const stranger = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(patient2Token) });
      const nonexistent = await app.inject({ method: 'GET', url: `/api/documents/${randomUUID()}/download`, headers: auth(patient2Token) });
      expect(stranger.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(payload<{ code: string }>(stranger)).toEqual(payload<{ code: string }>(nonexistent));
      expect(payload<{ code: string }>(stranger).code).toBe('DOCUMENT_FILE_NOT_FOUND');
    });

    it('the treating doctor downloads a file for a patient they have consulted; an unrelated doctor 404s', async () => {
      const fileId = await insertFile('photo', fixtures.patientId);

      const treating = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(doctorToken) });
      expect(treating.statusCode).toBe(200);

      const unrelated = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(otherDoctorToken) });
      expect(unrelated.statusCode).toBe(404);
    });

    /**
     * *** THE FIX THIS TASK ASKS TO BE RE-VERIFIED: NARROWED TO
     * `prescription_pdf`, NOT EVERY CATEGORY. ***
     */
    it('*** any admin (even holding zero permissions) can download a non-prescription_pdf category — the gate is NOT applied there ***', async () => {
      const fileId = await insertFile('photo', fixtures.patientId);
      const res = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(adminNoPermToken) });
      expect(res.statusCode).toBe(200);
    });

    it('*** prescription_pdf IS gated: an admin without clinical.read_records 404s, one who holds it succeeds and the read is audited ***', async () => {
      const fileId = await insertFile('prescription_pdf', fixtures.patientId, fixtures.consultationId);

      const withoutPermission = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(adminNoPermToken) });
      expect(withoutPermission.statusCode).toBe(404);
      expect(payload<{ code: string }>(withoutPermission).code).toBe('DOCUMENT_FILE_NOT_FOUND');

      const withPermission = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(adminClinicalReadToken) });
      expect(withPermission.statusCode).toBe(200);

      const auditRows = await db
        .select()
        .from(auditLogTable)
        .where(eq(auditLogTable.entityId, fileId));
      expect(auditRows.some((row) => row.actorId === fixtures.adminClinicalReadId && row.action === 'read')).toBe(true);

      // The refused attempt above wrote NO audit row for that admin.
      expect(auditRows.some((row) => row.actorId === fixtures.adminNoPermId)).toBe(false);
    });

    it('a patient cannot download another patient\'s prescription_pdf either (patient branch is ownership-only, no permission concept)', async () => {
      const fileId = await insertFile('prescription_pdf', fixtures.patientId, fixtures.consultationId);
      const res = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download`, headers: auth(patient2Token) });
      expect(res.statusCode).toBe(404);
    });

    it('validation: a malformed id is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents/not-a-uuid/download', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('unauthenticated is 401', async () => {
      const fileId = await insertFile('photo', fixtures.patientId);
      const res = await app.inject({ method: 'GET', url: `/api/documents/${fileId}/download` });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* DELETE /documents/:id                                                   */
  /* ====================================================================== */

  describe('DELETE /documents/:id', () => {
    it('the owner soft-deletes their own upload', async () => {
      const uploaded = payload<{ id: string }>(await upload(patientToken, { category: 'photo' }));
      const res = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}`, headers: auth(patientToken) });
      expect(res.statusCode).toBe(204);

      const [row] = await db.select({ deletedAt: patientFilesTable.deletedAt }).from(patientFilesTable).where(eq(patientFilesTable.id, uploaded.id));
      expect(row.deletedAt).not.toBeNull();

      // Already deleted — deleting again 404s, not a repeat 204.
      const again = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}`, headers: auth(patientToken) });
      expect(again.statusCode).toBe(404);
    });

    it('a file attached to a COMPLETED consultation cannot be deleted — 409', async () => {
      const uploaded = payload<{ id: string }>(await upload(patientToken, { category: 'report', consultationId: fixtures.completedConsultationId }));
      const res = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}`, headers: auth(patientToken) });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('DOCUMENT_DELETE_BLOCKED_COMPLETED');
    });

    it('deleting another patient\'s file 404s the same way a nonexistent id does', async () => {
      const uploaded = payload<{ id: string }>(await upload(patientToken, { category: 'photo' }));
      const res = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}`, headers: auth(patient2Token) });
      expect(res.statusCode).toBe(404);
    });

    it('unauthenticated is 401, wrong account type (doctor token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const uploaded = payload<{ id: string }>(await upload(patientToken, { category: 'photo' }));
      const anon = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}` });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'DELETE', url: `/api/documents/${uploaded.id}`, headers: auth(doctorToken) });
      expect(wrongType.statusCode).toBe(403);
    });
  });

  /* ====================================================================== */
  /* GET /documents/report-requests/me                                       */
  /* ====================================================================== */

  describe('GET /documents/report-requests/me', () => {
    it("lists the patient's own report requests across all their consultations", async () => {
      const [reportRequest] = await db
        .insert(reportRequestsTable)
        .values({ consultationId: fixtures.consultationId, title: `Own listing ${fixtures.runId}` })
        .returning({ id: reportRequestsTable.id });

      const res = await app.inject({ method: 'GET', url: '/api/documents/report-requests/me', headers: auth(patientToken) });
      expect(res.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(res).map((r) => r.id)).toContain(reportRequest.id);
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents/report-requests/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Doctor side: /consultations/:id/report-requests, /consultations/:id/documents */
  /* ====================================================================== */

  describe('doctor report-request routes — treating doctor only', () => {
    it('the treating doctor raises, lists and cancels a report request; a non-treating doctor 404s on every route', async () => {
      const raised = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/report-requests`,
        headers: auth(doctorToken),
        payload: { title: 'Latest blood work', reason: 'Follow-up' },
      });
      expect(raised.statusCode).toBe(201);
      const reportRequest = payload<{ id: string; status: string }>(raised);
      expect(reportRequest.status).toBe('open');

      const wrongDoctorRaise = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/report-requests`,
        headers: auth(otherDoctorToken),
        payload: { title: 'Should not work' },
      });
      expect(wrongDoctorRaise.statusCode).toBe(404);

      const list = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/report-requests`, headers: auth(doctorToken) });
      expect(payload<Array<{ id: string }>>(list).map((r) => r.id)).toContain(reportRequest.id);

      const wrongDoctorList = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/report-requests`, headers: auth(otherDoctorToken) });
      expect(wrongDoctorList.statusCode).toBe(404);

      const wrongDoctorCancel = await app.inject({
        method: 'PATCH',
        url: `/api/consultations/${fixtures.consultationId}/report-requests/${reportRequest.id}/cancel`,
        headers: auth(otherDoctorToken),
      });
      expect(wrongDoctorCancel.statusCode).toBe(404);

      const cancelled = await app.inject({
        method: 'PATCH',
        url: `/api/consultations/${fixtures.consultationId}/report-requests/${reportRequest.id}/cancel`,
        headers: auth(doctorToken),
      });
      expect(cancelled.statusCode).toBe(200);
      expect(payload<{ status: string }>(cancelled).status).toBe('cancelled');

      const cancelAgain = await app.inject({
        method: 'PATCH',
        url: `/api/consultations/${fixtures.consultationId}/report-requests/${reportRequest.id}/cancel`,
        headers: auth(doctorToken),
      });
      expect(cancelAgain.statusCode).toBe(409);
      expect(payload<{ code: string }>(cancelAgain).code).toBe('DOCUMENT_REPORT_REQUEST_NOT_OPEN');
    });

    it('validation: raising with an empty title is refused 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/report-requests`,
        headers: auth(doctorToken),
        payload: { title: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/report-requests` });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/report-requests`, headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  describe('GET /consultations/:id/documents — the doctor cross-consultation history read (rule 6)', () => {
    it('the treating doctor sees every medical_history file for the patient, regardless of which consultation it was attached to', async () => {
      await upload(patientToken, { category: 'medical_history' }); // no consultationId at all

      const res = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/documents`, headers: auth(doctorToken) });
      expect(res.statusCode).toBe(200);
      const rows = payload<Array<{ fileCategory: string }>>(res);
      expect(rows.some((r) => r.fileCategory === 'medical_history')).toBe(true);
    });

    it('a doctor with NO relationship to the patient 404s the whole request rather than an empty list', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/documents`, headers: auth(otherDoctorToken) });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('DOCUMENT_CONSULTATION_NOT_FOUND');
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/consultations/${fixtures.consultationId}/documents` });
      expect(res.statusCode).toBe(401);
    });
  });
});
