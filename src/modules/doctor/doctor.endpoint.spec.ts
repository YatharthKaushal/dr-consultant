/**
 * *** REAL-HTTP ENDPOINT TESTS — `doctor` MODULE. ***
 *
 * Drives every route in `doctor.controller.ts` and
 * `doctor-admin.controller.ts` through `createConfiguredApp()` +
 * `app.inject()` — real guards, real `ValidationPipe`, real database, and a
 * REAL multipart upload built with the `form-data` package (no test in this
 * codebase has driven a multipart route over HTTP before this).
 *
 * *** THE ONE THING MOCKED: `StorageFacade.store()`. *** This dev/test
 * environment has no S3/Cloudinary credentials configured (see the boot
 * warnings any run of this suite prints: "Storage provider ... active in
 * the database but its environment credentials are not set"), so a genuine
 * upload attempt answers a real, honest 503 `DOCTOR_DOCUMENT_UPLOAD_FAILED`
 * — proved once below, unmocked, exactly as a client would see it today.
 * To exercise the review workflow (which needs a document to actually
 * exist), `StorageFacade.store` is spied to return a fake
 * `StoredFileResult`, the same discipline `app.e2e.integration.spec.ts`
 * uses for `RazorpayClient.createOrder` and `ClinicalPdfService
 * .generateForConsultation` — mock exactly the third-party dependency this
 * environment cannot reach, keep every real validation path (MIME
 * allowlist + magic-byte content sniffing) genuinely exercised.
 */
import { randomUUID } from 'node:crypto';
import FormData from 'form-data';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import type { AccountType } from '../../schema/enums.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { StorageFacade } from '../storage/storage.facade';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(90_000);

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

/** Real PNG magic bytes (`89 50 4E 47 0D 0A 1A 0A`) plus filler — passes `file-content-type.util.ts`'s sniff as `image/png`. */
function pngBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)]);
}

/** Real PDF magic bytes (`%PDF`) plus filler — passes the sniff as `application/pdf`. */
function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 0)]);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixtures {
  runId: string;
  patientId: string;
  /** Never promoted through verification — used for /doctors/me, documents, and as the review-workflow target. */
  doctorSelfId: string;
  doctorSelfMobile: string;
  /** Dedicated to the admin verification/listing/fee/expert-role/specialty state machine, kept apart so its session revocation never affects doctorSelf. */
  doctorWorkflowId: string;
  specialtyAId: string;
  specialtyBId: string;
  adminAllId: string;
  adminNoneId: string;
  /** DOCTORS_READ only — proves GOVERNANCE_READ_QUALITY gates reliability separately. */
  adminNoGovernanceId: string;
}

async function permissionId(db: Database, key: string): Promise<string> {
  const [row] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
  if (!row) {
    throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts against this database first.`);
  }
  return row.id;
}

async function grant(db: Database, adminId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: await permissionId(db, key) });
  }
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9175${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [patient] = await db.insert(patientsTable).values({ mobileNumber: nextPhone(), fullName: `Doctor-test Patient ${runId}`, status: 'active' }).returning({ id: patientsTable.id });

  const doctorSelfMobile = nextPhone();
  const [doctorSelf] = await db.insert(doctorsTable).values({ mobileNumber: doctorSelfMobile, fullName: `Doctor Self ${runId}` }).returning({ id: doctorsTable.id });

  const [doctorWorkflow] = await db.insert(doctorsTable).values({ mobileNumber: nextPhone(), fullName: `Doctor Workflow ${runId}` }).returning({ id: doctorsTable.id });

  const [specialtyA] = await db.insert(specialtiesTable).values({ code: `doc_a_${runId}`, name: `Doctor Specialty A ${runId}`, canPrescribe: false, isActive: true }).returning({ id: specialtiesTable.id });
  const [specialtyB] = await db.insert(specialtiesTable).values({ code: `doc_b_${runId}`, name: `Doctor Specialty B ${runId}`, canPrescribe: false, isActive: true }).returning({ id: specialtiesTable.id });

  const [adminAll] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Doctor Admin All ${runId}` }).returning({ id: adminsTable.id });
  const [adminNone] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Doctor Admin None ${runId}` }).returning({ id: adminsTable.id });
  const [adminNoGovernance] = await db.insert(adminsTable).values({ mobileNumber: nextPhone(), fullName: `Doctor Admin NoGov ${runId}` }).returning({ id: adminsTable.id });

  await grant(db, adminAll.id, [
    PERMISSIONS.DOCTORS_READ,
    PERMISSIONS.DOCTORS_CREATE,
    PERMISSIONS.DOCTORS_UPDATE,
    PERMISSIONS.DOCTORS_VERIFY,
    PERMISSIONS.DOCTORS_MANAGE_LISTING,
    PERMISSIONS.DOCTORS_MANAGE_FEE,
    PERMISSIONS.DOCTORS_MANAGE_EXPERT_ROLE,
    PERMISSIONS.GOVERNANCE_READ_QUALITY,
  ]);
  await grant(db, adminNoGovernance.id, [PERMISSIONS.DOCTORS_READ]);

  return {
    runId,
    patientId: patient.id,
    doctorSelfId: doctorSelf.id,
    doctorSelfMobile,
    doctorWorkflowId: doctorWorkflow.id,
    specialtyAId: specialtyA.id,
    specialtyBId: specialtyB.id,
    adminAllId: adminAll.id,
    adminNoneId: adminNone.id,
    adminNoGovernanceId: adminNoGovernance.id,
  };
}

/** Doctors created via POST /admin/doctors — tracked for teardown. */
const createdDoctorIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const doctorIds = [fixtures.doctorSelfId, fixtures.doctorWorkflowId, ...createdDoctorIds];
  const adminIds = [fixtures.adminAllId, fixtures.adminNoneId, fixtures.adminNoGovernanceId];
  const specialtyIds = [fixtures.specialtyAId, fixtures.specialtyBId];

  await db.execute(sql`delete from doctor_documents where doctor_id = any(${pgArray(doctorIds, 'uuid')})`);
  await db.execute(sql`delete from doctor_specialties where doctor_id = any(${pgArray(doctorIds, 'uuid')})`);
  await db.execute(sql`update doctors set blocked_by_consultation_id = null where id = any(${pgArray(doctorIds, 'uuid')})`);
  await db.execute(sql`delete from doctors where id = any(${pgArray(doctorIds, 'uuid')})`);
  await db.execute(sql`delete from specialties where id = any(${pgArray(specialtyIds, 'uuid')})`);

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from patients where id = ${fixtures.patientId}`);

  await db.execute(
    sql`delete from audit_log where actor_id = any(${pgArray([...doctorIds, ...adminIds, fixtures.patientId], 'uuid')}) or entity_id = any(${pgArray([...doctorIds, ...specialtyIds], 'varchar')})`,
  );
}

/* -------------------------------------------------------------------------- */

describe('doctor module — real HTTP endpoint tests', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;

  const tokens: Record<string, string> = {};

  async function mint(accountType: AccountType, accountId: string, tokenVersion = 0): Promise<string> {
    const pair = await tokenService.mintTokenPair(accountType, accountId, tokenVersion);
    return pair.accessToken;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /** Builds a real multipart/form-data body for POST /doctors/me/documents. */
  function multipartUpload(fields: { documentType?: string; file?: { buffer: Buffer; filename: string; contentType: string } }) {
    const form = new FormData();
    if (fields.documentType !== undefined) form.append('documentType', fields.documentType);
    if (fields.file) form.append('file', fields.file.buffer, { filename: fields.file.filename, contentType: fields.file.contentType });
    return { headers: form.getHeaders(), payload: form.getBuffer() };
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    tokenService = app.get(IdentityTokenService);

    fixtures = await seedFixtures(db);

    tokens.patient = await mint('patient', fixtures.patientId);
    tokens.doctorSelf = await mint('doctor', fixtures.doctorSelfId);
    tokens.doctorWorkflow = await mint('doctor', fixtures.doctorWorkflowId);
    tokens.adminAll = await mint('admin', fixtures.adminAllId);
    tokens.adminNone = await mint('admin', fixtures.adminNoneId);
    tokens.adminNoGovernance = await mint('admin', fixtures.adminNoGovernanceId);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ====================================================================== */
  /* GET/PATCH /doctors/me                                                   */
  /* ====================================================================== */

  describe('GET /doctors/me', () => {
    it("returns the caller's own profile with specialties and documents arrays", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me', headers: auth(tokens.doctorSelf) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; specialties: unknown[]; documents: unknown[]; tokenVersion?: unknown }>(response);
      expect(body.id).toBe(fixtures.doctorSelfId);
      expect(body.specialties).toEqual([]);
      expect(body.documents).toEqual([]);
      expect(body).not.toHaveProperty('tokenVersion');
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me' });
      expect(response.statusCode).toBe(401);
    });

    it('a patient token is refused — 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  describe('PATCH /doctors/me', () => {
    it('updates bio and languages', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me',
        headers: auth(tokens.doctorSelf),
        payload: { bio: 'Ten years of practice.', languages: ['en', 'hi'] },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ bio: string; languages: string[] }>(response);
      expect(body.bio).toBe('Ten years of practice.');
      expect(body.languages).toEqual(['en', 'hi']);
    });

    it('a bio over 4000 characters is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me',
        headers: auth(tokens.doctorSelf),
        payload: { bio: 'x'.repeat(4001) },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('more than 20 languages is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/doctors/me',
        headers: auth(tokens.doctorSelf),
        payload: { languages: Array.from({ length: 21 }, (_, i) => `lang${i}`) },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a patient token is refused — 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'PATCH', url: '/api/doctors/me', headers: auth(tokens.patient), payload: { bio: 'x' } });
      expect(response.statusCode).toBe(403);
    });
  });

  /* ====================================================================== */
  /* POST /doctors/me/documents — real multipart, one genuinely unmocked 503 */
  /* ====================================================================== */

  describe('POST /doctors/me/documents — validation, all before storage is ever called', () => {
    it('an invalid documentType is a clean 400 INVALID_DOCUMENT_TYPE', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'not_a_real_type', file: { buffer: pngBuffer(), filename: 'x.png', contentType: 'image/png' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_INVALID_DOCUMENT_TYPE');
    });

    it('no file part at all is a clean 400 MULTIPART_NO_FILE', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo' });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('MULTIPART_NO_FILE');
    });

    it('*** BUSINESS RULE *** a PDF declared for profile_photo (image-only allowlist) is refused — 415 DOCTOR_INVALID_FILE_TYPE', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo', file: { buffer: pdfBuffer(), filename: 'x.pdf', contentType: 'application/pdf' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(415);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_INVALID_FILE_TYPE');
    });

    it('*** CONTENT SNIFFING, NOT THE DECLARED HEADER *** PNG bytes declared as image/jpeg are refused — the byte signature does not match', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo', file: { buffer: pngBuffer(), filename: 'x.jpg', contentType: 'image/jpeg' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(415);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_INVALID_FILE_TYPE');
    });

    it('a patient token is refused — 403 WRONG_ACCOUNT_TYPE', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo', file: { buffer: pngBuffer(), filename: 'x.png', contentType: 'image/png' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.patient) }, payload: body });
      expect(response.statusCode).toBe(403);
    });

    /**
     * *** THE ONE GENUINELY UNMOCKED CALL TO STORAGE IN THIS FILE. *** No
     * S3/Cloudinary credentials are configured in this environment (see this
     * file's header) — a fully valid upload reaches `StorageFacade.store()`
     * for real and gets a real, honest 503. This is environment reality, not
     * a product bug: proved once here, then `StorageFacade.store` is mocked
     * for every subsequent test in this file so the review workflow below
     * has real rows to work with.
     */
    it('*** UNMOCKED *** a fully valid upload reaches real storage and is refused 503 DOCTOR_DOCUMENT_UPLOAD_FAILED — no provider is configured in this environment', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo', file: { buffer: pngBuffer(), filename: 'x.png', contentType: 'image/png' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(503);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_DOCUMENT_UPLOAD_FAILED');
    });
  });

  describe('POST /doctors/me/documents and the review workflow — StorageFacade.store mocked', () => {
    let profilePhotoDocId: string;
    let degreeCertDocId: string;

    beforeAll(() => {
      jest.spyOn(app.get(StorageFacade), 'store').mockImplementation(async (input) => ({
        storageKey: `fake:${randomUUID()}`,
        sizeBytes: input.buffer.byteLength,
      }));
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    it('uploads a profile_photo (PNG) successfully', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'profile_photo', file: { buffer: pngBuffer(), filename: 'photo.png', contentType: 'image/png' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(201);
      const doc = payload<{ id: string; documentType: string; reviewStatus: string; storageKey?: unknown }>(response);
      expect(doc.documentType).toBe('profile_photo');
      expect(doc.reviewStatus).toBe('pending');
      expect(doc).not.toHaveProperty('storageKey');
      profilePhotoDocId = doc.id;
    });

    it('uploads a degree_certificate (PDF) successfully — a materially different valid shape', async () => {
      const { headers, payload: body } = multipartUpload({ documentType: 'degree_certificate', file: { buffer: pdfBuffer(), filename: 'degree.pdf', contentType: 'application/pdf' } });
      const response = await app.inject({ method: 'POST', url: '/api/doctors/me/documents', headers: { ...headers, ...auth(tokens.doctorSelf) }, payload: body });
      expect(response.statusCode).toBe(201);
      const doc = payload<{ id: string; documentType: string }>(response);
      expect(doc.documentType).toBe('degree_certificate');
      degreeCertDocId = doc.id;
    });

    it('GET /doctors/me/documents lists both uploads', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/me/documents', headers: auth(tokens.doctorSelf) });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((d) => d.id);
      expect(ids).toEqual(expect.arrayContaining([profilePhotoDocId, degreeCertDocId]));
    });

    describe('admin/doctors/:id/documents — auth boundary', () => {
      it('a doctor token is refused as the wrong account type', async () => {
        const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents`, headers: auth(tokens.doctorSelf) });
        expect(response.statusCode).toBe(403);
        expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
      });

      it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
        const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents`, headers: auth(tokens.adminNone) });
        expect(response.statusCode).toBe(403);
      });
    });

    it('GET /admin/doctors/:id/documents lists them for an admin', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(response).map((d) => d.id)).toEqual(expect.arrayContaining([profilePhotoDocId, degreeCertDocId]));
    });

    it('a nonexistent doctor id is 404 DOCTOR_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${randomUUID()}/documents`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_NOT_FOUND');
    });

    describe('PATCH /admin/doctors/:id/documents/:documentId/review (DOCTORS_VERIFY)', () => {
      it('*** BUSINESS RULE *** rejecting without a rejectionReason is refused — 400 REJECTION_REASON_REQUIRED', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents/${degreeCertDocId}/review`,
          headers: auth(tokens.adminAll),
          payload: { reviewStatus: 'rejected' },
        });
        expect(response.statusCode).toBe(400);
        expect(payload<{ code: string }>(response).code).toBe('REJECTION_REASON_REQUIRED');
      });

      it('approves the profile_photo document', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents/${profilePhotoDocId}/review`,
          headers: auth(tokens.adminAll),
          payload: { reviewStatus: 'approved' },
        });
        expect(response.statusCode).toBe(200);
        const body = payload<{ reviewStatus: string; verifiedByAdminId: string; rejectionReason: string | null }>(response);
        expect(body.reviewStatus).toBe('approved');
        expect(body.verifiedByAdminId).toBe(fixtures.adminAllId);
        expect(body.rejectionReason).toBeNull();
      });

      it('rejects the degree_certificate document with a reason', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents/${degreeCertDocId}/review`,
          headers: auth(tokens.adminAll),
          payload: { reviewStatus: 'rejected', rejectionReason: 'Illegible scan.' },
        });
        expect(response.statusCode).toBe(200);
        const body = payload<{ reviewStatus: string; rejectionReason: string | null }>(response);
        expect(body.reviewStatus).toBe('rejected');
        expect(body.rejectionReason).toBe('Illegible scan.');
      });

      it('a nonexistent documentId is 404 DOCUMENT_NOT_FOUND', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents/${randomUUID()}/review`,
          headers: auth(tokens.adminAll),
          payload: { reviewStatus: 'approved' },
        });
        expect(response.statusCode).toBe(404);
        expect(payload<{ code: string }>(response).code).toBe('DOCUMENT_NOT_FOUND');
      });

      it('a document id that belongs to a DIFFERENT doctor is also 404 DOCUMENT_NOT_FOUND — scoped by doctorId, not a global document lookup', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/documents/${profilePhotoDocId}/review`,
          headers: auth(tokens.adminAll),
          payload: { reviewStatus: 'approved' },
        });
        expect(response.statusCode).toBe(404);
        expect(payload<{ code: string }>(response).code).toBe('DOCUMENT_NOT_FOUND');
      });

      it('a doctor token is refused as the wrong account type', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/admin/doctors/${fixtures.doctorSelfId}/documents/${profilePhotoDocId}/review`,
          headers: auth(tokens.doctorSelf),
          payload: { reviewStatus: 'approved' },
        });
        expect(response.statusCode).toBe(403);
      });
    });
  });

  /* ====================================================================== */
  /* GET /doctors/:id — public/leak-checked profile                          */
  /* ====================================================================== */

  describe('GET /doctors/:id', () => {
    it('*** EXISTENCE LEAK CHECK *** an unverified/unlisted doctor is 404 to a patient — indistinguishable from a nonexistent id', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_NOT_FOUND');
    });

    it('the SAME unverified doctor IS visible to an admin', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
    });

    it('a genuinely nonexistent id answers the identical 404 shape', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${randomUUID()}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DOCTOR_NOT_FOUND');
    });

    it('a malformed id is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/doctors/not-a-uuid', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('refuses an unauthenticated call — 401 (any authenticated type is allowed, but SOME token is required)', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.doctorWorkflowId}` });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* admin/doctors — auth boundary                                          */
  /* ====================================================================== */

  describe('admin/doctors — auth boundary', () => {
    it('a patient token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/doctors', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/doctors' });
      expect(response.statusCode).toBe(401);
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/doctors', headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/doctors and /admin/doctors/:id (DOCTORS_READ)', () => {
    it('lists doctors, including this run\'s fixtures', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/doctors', headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((d) => d.id);
      expect(ids).toEqual(expect.arrayContaining([fixtures.doctorSelfId, fixtures.doctorWorkflowId]));
    });

    it('returns the full detail with specialties and documents', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorSelfId}`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; specialties: unknown[]; documents: unknown[] }>(response);
      expect(body.id).toBe(fixtures.doctorSelfId);
      expect(Array.isArray(body.documents)).toBe(true);
    });

    it('a nonexistent id is 404 DOCTOR_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${randomUUID()}`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /admin/doctors (DOCTORS_CREATE)', () => {
    it('creates a doctor', async () => {
      const mobileNumber = `+9175${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}99`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/doctors',
        headers: auth(tokens.adminAll),
        payload: { mobileNumber, fullName: 'A New Doctor' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; verificationStatus: string; isListed: boolean }>(response);
      expect(body.verificationStatus).toBe('pending');
      expect(body.isListed).toBe(false);
      createdDoctorIds.push(body.id);
    });

    it('a duplicate mobile number is refused — 409 MOBILE_NUMBER_TAKEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/doctors',
        headers: auth(tokens.adminAll),
        payload: { mobileNumber: fixtures.doctorSelfMobile, fullName: 'Duplicate' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('MOBILE_NUMBER_TAKEN');
    });

    it('an invalid phone number is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/doctors',
        headers: auth(tokens.adminAll),
        payload: { mobileNumber: 'not-a-phone', fullName: 'Bad Phone' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('*** SPLIT PERMISSION PROVEN *** DOCTORS_READ alone cannot create — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/doctors',
        headers: auth(tokens.adminNoGovernance),
        payload: { mobileNumber: '+919876500001', fullName: 'Should Not Exist' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('PATCH /admin/doctors/:id (DOCTORS_UPDATE)', () => {
    it('updates profile fields', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorSelfId}`,
        headers: auth(tokens.adminAll),
        payload: { qualification: 'MBBS, MD', yearsOfExperience: 12 },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ qualification: string; yearsOfExperience: number }>(response);
      expect(body.qualification).toBe('MBBS, MD');
      expect(body.yearsOfExperience).toBe(12);
    });

    it('*** BUSINESS RULE *** a duplicate registrationNumber is refused — 409 REGISTRATION_NUMBER_TAKEN', async () => {
      const regNumber = `REG-${fixtures.runId}`;
      const first = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorSelfId}`,
        headers: auth(tokens.adminAll),
        payload: { registrationNumber: regNumber },
      });
      expect(first.statusCode).toBe(200);

      const clash = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}`,
        headers: auth(tokens.adminAll),
        payload: { registrationNumber: regNumber },
      });
      expect(clash.statusCode).toBe(409);
      expect(payload<{ code: string }>(clash).code).toBe('REGISTRATION_NUMBER_TAKEN');
    });

    it('yearsOfExperience out of smallint range is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorSelfId}`,
        headers: auth(tokens.adminAll),
        payload: { yearsOfExperience: 999999 },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('a nonexistent id is 404 DOCTOR_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${randomUUID()}`,
        headers: auth(tokens.adminAll),
        payload: { qualification: 'x' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* The verification/listing state machine — sequential, on doctorWorkflow  */
  /* ====================================================================== */

  describe('the verification -> listing -> demotion state machine (doctorWorkflow)', () => {
    it('*** SPLIT PERMISSION PROVEN *** DOCTORS_READ alone cannot verify — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/verification`,
        headers: auth(tokens.adminNoGovernance),
        payload: { status: 'verified' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('*** BUSINESS RULE *** cannot list an unverified doctor — 409 CANNOT_LIST_UNVERIFIED_DOCTOR', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/listing`,
        headers: auth(tokens.adminAll),
        payload: { isListed: true },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('CANNOT_LIST_UNVERIFIED_DOCTOR');
    });

    it('verifies the doctor — verifiedByAdminId/verifiedAt are set', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/verification`,
        headers: auth(tokens.adminAll),
        payload: { status: 'verified' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ verificationStatus: string; verifiedByAdminId: string; verifiedAt: string | null }>(response);
      expect(body.verificationStatus).toBe('verified');
      expect(body.verifiedByAdminId).toBe(fixtures.adminAllId);
      expect(body.verifiedAt).not.toBeNull();
    });

    it('a no-op re-verification (same status) is accepted and changes nothing', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/verification`,
        headers: auth(tokens.adminAll),
        payload: { status: 'verified' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ verificationStatus: string }>(response).verificationStatus).toBe('verified');
    });

    it('now lists the doctor successfully', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/listing`,
        headers: auth(tokens.adminAll),
        payload: { isListed: true, allowInstantConsult: true },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ isListed: boolean; allowInstantConsult: boolean }>(response);
      expect(body.isListed).toBe(true);
      expect(body.allowInstantConsult).toBe(true);
    });

    it('the doctor is now publicly visible', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
    });

    it('sets the fee', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/fee`,
        headers: auth(tokens.adminAll),
        payload: { consultationFeeInr: 750.5 },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ consultationFeeInr: string }>(response).consultationFeeInr).toBe('750.50');
    });

    it('a negative fee is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/fee`,
        headers: auth(tokens.adminAll),
        payload: { consultationFeeInr: -10 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('a fee over the ceiling (1,000,000) is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/fee`,
        headers: auth(tokens.adminAll),
        payload: { consultationFeeInr: 2_000_000 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('grants the expert role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/expert-role`,
        headers: auth(tokens.adminAll),
        payload: { seniorityLevel: 'expert' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ seniorityLevel: string }>(response).seniorityLevel).toBe('expert');
    });

    it('an invalid seniorityLevel is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/expert-role`,
        headers: auth(tokens.adminAll),
        payload: { seniorityLevel: 'super-expert' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('assigns a primary specialty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties`,
        headers: auth(tokens.adminAll),
        payload: { specialtyId: fixtures.specialtyAId, isPrimary: true },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ specialtyId: string; isPrimary: boolean }>(response);
      expect(body.specialtyId).toBe(fixtures.specialtyAId);
      expect(body.isPrimary).toBe(true);
    });

    it('*** BUSINESS RULE *** assigning a nonexistent specialty is 404 SPECIALTY_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties`,
        headers: auth(tokens.adminAll),
        payload: { specialtyId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('SPECIALTY_NOT_FOUND');
    });

    it('assigning a SECOND specialty as primary swaps the primary flag — at most one primary at a time', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties`,
        headers: auth(tokens.adminAll),
        payload: { specialtyId: fixtures.specialtyBId, isPrimary: true },
      });
      expect(response.statusCode).toBe(201);
      expect(payload<{ isPrimary: boolean }>(response).isPrimary).toBe(true);

      const detail = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.adminAll) });
      const specialties = payload<{ specialties: Array<{ id: string; isPrimary: boolean }> }>(detail).specialties;
      const primaries = specialties.filter((s) => s.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].id).toBe(fixtures.specialtyBId);
    });

    it('removing a specialty the doctor holds succeeds — 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties/${fixtures.specialtyAId}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(204);
    });

    it('removing it again is an idempotent no-op — still 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties/${fixtures.specialtyAId}`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(204);
    });

    it('a malformed specialtyId on the DELETE route is a clean 400', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/specialties/not-a-uuid`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(400);
    });

    it('reads reliability metrics — all null for a doctor with no consultations yet', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/reliability`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ acceptanceRate: number | null; noShowRate: number | null; caseSummaryCompletionRate: number | null }>(response);
      expect(body.acceptanceRate).toBeNull();
      expect(body.noShowRate).toBeNull();
      expect(body.caseSummaryCompletionRate).toBeNull();
    });

    it('*** SPLIT PERMISSION PROVEN *** DOCTORS_READ does not imply GOVERNANCE_READ_QUALITY — reliability is 403 for the DOCTORS_READ-only admin', async () => {
      const readOnlyCanReadDoctor = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.adminNoGovernance) });
      expect(readOnlyCanReadDoctor.statusCode).toBe(200);

      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/reliability`, headers: auth(tokens.adminNoGovernance) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('a nonexistent doctor on the reliability route is 404 DOCTOR_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/doctors/${randomUUID()}/reliability`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
    });

    it('*** SESSION REVOCATION *** rejecting the doctor demotes isListed to false AND revokes their live session', async () => {
      const meBefore = await app.inject({ method: 'GET', url: '/api/doctors/me', headers: auth(tokens.doctorWorkflow) });
      expect(meBefore.statusCode).toBe(200);

      const reject = await app.inject({
        method: 'PATCH',
        url: `/api/admin/doctors/${fixtures.doctorWorkflowId}/verification`,
        headers: auth(tokens.adminAll),
        payload: { status: 'rejected' },
      });
      expect(reject.statusCode).toBe(200);
      const body = payload<{ verificationStatus: string; isListed: boolean }>(reject);
      expect(body.verificationStatus).toBe('rejected');
      expect(body.isListed).toBe(false);

      const meAfter = await app.inject({ method: 'GET', url: '/api/doctors/me', headers: auth(tokens.doctorWorkflow) });
      expect(meAfter.statusCode).toBe(401);
    });

    it('*** EXISTENCE LEAK, AGAIN *** the now-rejected doctor is 404 to a patient once more', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/doctors/${fixtures.doctorWorkflowId}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(404);
    });
  });
});
