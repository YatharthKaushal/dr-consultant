/**
 * *** REAL-HTTP ENDPOINT TESTS FOR THE CLINICAL MODULE. ***
 *
 * Every other test in `src/modules/clinical/` constructs `ClinicalService` (or
 * a repository) directly and calls a method — `clinical.completion-gate
 * .integration.spec.ts` is the most thorough of those, against a real
 * database, and it is the fixture pattern this file follows. But NONE of them
 * send an HTTP request. This file drives every route in
 * `clinical.controller.ts`, `clinical-admin.controller.ts` and
 * `clinical-template.controller.ts` through `createConfiguredApp()` +
 * `app.inject()` — the same application `main.ts` boots, with the real
 * `JwtAuthGuard`, `AccountTypeGuard`, `PermissionGuard` and `ValidationPipe`
 * in the loop — plus the one cross-module route
 * (`GET /documents/:id/download`) whose permission narrowing this module's own
 * `clinical.read_records` gate exists to protect.
 *
 * *** TOKENS ARE MINTED DIRECTLY, NOT VIA OTP. *** OTP sign-in is already
 * proved end to end by `app.e2e.integration.spec.ts`; it is not this module's
 * concern. `IdentityTokenService.mintTokenPair` is the app's own, real signer
 * — the same one `identity.service.ts` calls after a real OTP verifies — so a
 * token minted this way is byte-for-byte what a real sign-in would have
 * produced, and `JwtAuthGuard` verifies it exactly the same way.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorClinicalTemplatesTable } from '../../schema/doctor-clinical-templates.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientFilesTable } from '../../schema/patient-files.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { StorageFacade } from '../storage/storage.facade';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { CLINICAL_ERROR_CODES } from './clinical.constants';
import { ClinicalPdfService } from './clinical-pdf.service';

jest.setTimeout(60_000);

/** Every response in this application is enveloped — see `app.e2e.integration.spec.ts`'s identical helper. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

describe('CLINICAL module — real HTTP, real guards, real database', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9197${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  /* Fixtures shared across the whole file. */
  let prescribingSpecialtyId: string;
  let nonPrescribingSpecialtyId: string;
  let patientId: string;

  /** The main doctor: primary specialty is PRESCRIBING, also practises the non-prescribing one. */
  let doctorId: string;
  let doctorToken: string;
  /** A second, unrelated doctor — used for the ownership/404 checks. */
  let strangerDoctorId: string;
  let strangerDoctorToken: string;

  /** Admin with no grants at all. */
  let plainAdminId: string;
  let plainAdminToken: string;
  /** Admin holding `clinical.read_records`. */
  let readRecordsAdminId: string;
  let readRecordsAdminToken: string;
  /** Admin holding an unrelated permission, to prove the gate does not leak. */
  let unrelatedAdminId: string;
  let unrelatedAdminToken: string;

  /** Consultations, created per-test-group below; tracked here for teardown. */
  const consultationIds: string[] = [];
  const doctorIds: string[] = [];
  const patientIds: string[] = [];
  const specialtyIds: string[] = [];
  const adminIds: string[] = [];
  const templateIds: string[] = [];
  const patientFileIds: string[] = [];
  let referenceSeq = 100;

  async function makeConsultation(opts: {
    specialtyId: string;
    doctorId: string;
    status?: 'in_progress' | 'awaiting_documentation' | 'completed' | 'scheduled';
    patientId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        // varchar(24) — `CH-` + 8-char runId + `-` + a growing counter stays
        // well under the limit, unlike a second UUID fragment.
        referenceCode: `CH-${runId}-${referenceSeq++}`,
        patientId: opts.patientId ?? patientId,
        doctorId: opts.doctorId,
        specialtyId: opts.specialtyId,
        mode: 'instant',
        status: opts.status ?? 'in_progress',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    consultationIds.push(row.id);
    return row.id;
  }

  async function mintToken(accountType: 'patient' | 'doctor' | 'admin', accountId: string): Promise<string> {
    const { accessToken } = await app.get(IdentityTokenService).mintTokenPair(accountType, accountId, 0);
    return accessToken;
  }

  async function grantPermission(adminId: string, key: string): Promise<void> {
    const [permission] = await db
      .select({ id: permissionsTable.id })
      .from(permissionsTable)
      .where(eq(permissionsTable.key, key))
      .limit(1);
    if (!permission) {
      throw new Error(`Fixture precondition failed: permission "${key}" is not seeded — run identity.seed.ts first.`);
    }
    await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permission.id });
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    jest.spyOn(app.get(ClinicalPdfService), 'generateForConsultation').mockResolvedValue(null);
    // No S3/Cloudinary credentials in this environment (see
    // `app.e2e.integration.spec.ts`'s header on `ClinicalPdfService` for the
    // identical reasoning) — the download-permission tests below only care
    // whether `canAccessForDownload` allows or refuses the CALL, not whether a
    // real object store can mint a URL for a fixture key that was never
    // actually uploaded anywhere.
    jest.spyOn(app.get(StorageFacade), 'getSignedUrl').mockResolvedValue('https://example.test/signed-url');

    const [prescribing] = await db
      .insert(specialtiesTable)
      .values({ code: `clin_http_rx_${runId}`, name: `HTTP Psychiatry ${runId}`, canPrescribe: true, isActive: true })
      .returning({ id: specialtiesTable.id });
    const [nonPrescribing] = await db
      .insert(specialtiesTable)
      .values({ code: `clin_http_norx_${runId}`, name: `HTTP Counselling ${runId}`, canPrescribe: false, isActive: true })
      .returning({ id: specialtiesTable.id });
    prescribingSpecialtyId = prescribing.id;
    nonPrescribingSpecialtyId = nonPrescribing.id;
    specialtyIds.push(prescribingSpecialtyId, nonPrescribingSpecialtyId);

    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: nextPhone(), fullName: `HTTP Patient ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientId = patient.id;
    patientIds.push(patientId);

    const [doctor] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `HTTP Doctor ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
      })
      .returning({ id: doctorsTable.id });
    doctorId = doctor.id;
    doctorIds.push(doctorId);
    await db.insert(doctorSpecialtiesTable).values({ doctorId, specialtyId: prescribingSpecialtyId, isPrimary: true });
    await db.insert(doctorSpecialtiesTable).values({ doctorId, specialtyId: nonPrescribingSpecialtyId });
    doctorToken = await mintToken('doctor', doctorId);

    const [stranger] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `HTTP Stranger Doctor ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
      })
      .returning({ id: doctorsTable.id });
    strangerDoctorId = stranger.id;
    doctorIds.push(strangerDoctorId);
    await db.insert(doctorSpecialtiesTable).values({ doctorId: strangerDoctorId, specialtyId: prescribingSpecialtyId, isPrimary: true });
    strangerDoctorToken = await mintToken('doctor', strangerDoctorId);

    const [plainAdmin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `HTTP Plain Admin ${runId}` })
      .returning({ id: adminsTable.id });
    plainAdminId = plainAdmin.id;
    adminIds.push(plainAdminId);
    plainAdminToken = await mintToken('admin', plainAdminId);

    const [readRecordsAdmin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `HTTP ReadRecords Admin ${runId}` })
      .returning({ id: adminsTable.id });
    readRecordsAdminId = readRecordsAdmin.id;
    adminIds.push(readRecordsAdminId);
    await grantPermission(readRecordsAdminId, PERMISSIONS.CLINICAL_READ_RECORDS);
    readRecordsAdminToken = await mintToken('admin', readRecordsAdminId);

    const [unrelatedAdmin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `HTTP Unrelated Admin ${runId}` })
      .returning({ id: adminsTable.id });
    unrelatedAdminId = unrelatedAdmin.id;
    adminIds.push(unrelatedAdminId);
    // Any permission that is NOT `clinical.read_records` — proves the gate
    // does not just check "is an admin with some grant".
    await grantPermission(unrelatedAdminId, PERMISSIONS.APPOINTMENTS_READ);
    unrelatedAdminToken = await mintToken('admin', unrelatedAdminId);
  });

  afterAll(async () => {
    // Strict reverse-FK order.
    await db.delete(patientFilesTable).where(inArray(patientFilesTable.id, patientFileIds));
    await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
    await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, [...doctorIds, ...adminIds, ...patientIds]));
    await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.consultationId, consultationIds));
    await db.delete(doctorClinicalTemplatesTable).where(inArray(doctorClinicalTemplatesTable.id, templateIds));
    await db.execute(sql`update doctors set blocked_by_consultation_id = null where id = any(${sql.raw(`array['${doctorIds.join("','")}']::uuid[]`)})`);
    // *** M-16's follow-up chain. *** `finalise` moves a consultation to
    // `completed`, and `FollowupClinicalListener` reacts by assigning a
    // pathway — visible in this suite's own log output. Same ordering
    // `app.e2e.integration.spec.ts`'s teardown fixed this round: alerts before
    // responses (a nullable FK from the former to the latter), both before
    // assignments, all three before consultations.
    const consultationList = sql.raw(`array['${consultationIds.join("','")}']::uuid[]`);
    await db.execute(sql`delete from safety_alerts where consultation_id = any(${consultationList})`);
    await db.execute(sql`delete from checkin_responses where consultation_id = any(${consultationList})`);
    await db.execute(sql`delete from followup_assignments where consultation_id = any(${consultationList})`);
    await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
    await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
    await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
    await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
    await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
    await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
    await db.delete(specialtiesTable).where(inArray(specialtiesTable.id, specialtyIds));
    await app.close();
  });

  async function readRecordRow(consultationId: string) {
    const rows = await db.execute(
      sql`select case_summary, medicines, advice_covered, advice_home_practice, chief_complaint, finalised_at from clinical_records where consultation_id = ${consultationId}`,
    );
    return (rows.rows as Array<Record<string, unknown>>)[0] ?? null;
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* Auth boundary — proved once, reused as the pattern for every route    */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('auth boundary', () => {
    it('GET clinical-record with no token is 401', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      const response = await app.inject({ method: 'GET', url: `/api/consultations/${consultationId}/clinical-record` });
      expect(response.statusCode).toBe(401);
    });

    it('GET clinical-record as a PATIENT (wrong account type) is 403', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      const patientToken = await mintToken('patient', patientId);
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('admin route without @RequirePermission grant is 403, WITH it is allowed', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low', caseSummary: 'x' },
      });

      const noPerm = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}`,
        headers: { authorization: `Bearer ${plainAdminToken}` },
      });
      expect(noPerm.statusCode).toBe(403);

      const wrongPerm = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}`,
        headers: { authorization: `Bearer ${unrelatedAdminToken}` },
      });
      expect(wrongPerm.statusCode).toBe(403);

      const withPerm = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}`,
        headers: { authorization: `Bearer ${readRecordsAdminToken}` },
      });
      expect(withPerm.statusCode).toBe(200);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Ownership / existence — the uniform 404                               */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('ownership never leaks via a different status code', () => {
    it('an unknown consultation id and a real-but-not-yours consultation both 404 with the SAME code', async () => {
      const notMine = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId: strangerDoctorId });

      const unknown = await app.inject({
        method: 'GET',
        url: `/api/consultations/${randomUUID()}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      const notOwned = await app.inject({
        method: 'GET',
        url: `/api/consultations/${notMine}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });

      expect(unknown.statusCode).toBe(404);
      expect(notOwned.statusCode).toBe(404);
      expect(payload<{ code: string }>(unknown).code).toBe(CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(payload<{ code: string }>(notOwned).code).toBe(CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Validation — one 400 per DTO                                         */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('ValidationPipe is really in the loop', () => {
    it('PUT clinical-record with an invalid riskCategory is 400', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      const response = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'catastrophic' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('apply-template with a non-UUID templateId is 400', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/apply-template`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { templateId: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* PUT semantics — a field left out is CLEARED                          */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('PUT /clinical-record clears an omitted field — real PUT, not PATCH', () => {
    it('a field set on the first save is NULL after a second PUT that omits it', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });

      const first = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'Low mood.',
          riskCategory: 'low',
          diagnosis: 'Mild depressive episode',
          caseSummary: 'Initial summary.',
        },
      });
      expect(first.statusCode).toBe(200);
      expect(payload<{ diagnosis: string | null }>(first).diagnosis).toBe('Mild depressive episode');

      const before = await readRecordRow(consultationId);
      expect(before?.chief_complaint).toBe('Low mood.');

      // Second PUT: same required fields, `diagnosis` and `caseSummary` OMITTED.
      const second = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'Low mood, updated.', riskCategory: 'low' },
      });
      expect(second.statusCode).toBe(200);
      const body = payload<{ diagnosis: string | null; caseSummary: string | null }>(second);
      expect(body.diagnosis).toBeNull();
      expect(body.caseSummary).toBeNull();

      const after = await readRecordRow(consultationId);
      expect(after?.case_summary).toBeNull();
      // Confirmed against `clinical.service.ts#saveDraft`'s own header ("PUT
      // semantics: the body is the complete state of the record, so a field
      // left out is CLEARED") and `toRowPatch`'s unconditional overwrite —
      // this is the DESIGNED behaviour, proved here over real HTTP for the
      // first time, not a bug.
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Template application                                                  */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('template create/list/get/update/delete + apply-template', () => {
    it('creates, lists, applies, updates and deletes a template', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/clinical-templates',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          name: `Standard SSRI ${runId}`,
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });
      expect(created.statusCode).toBe(201);
      const templateId = payload<{ id: string }>(created).id;
      templateIds.push(templateId);

      const listed = await app.inject({
        method: 'GET',
        url: '/api/doctors/me/clinical-templates',
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(listed).some((t) => t.id === templateId)).toBe(true);

      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low' },
      });

      const applied = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/apply-template`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { templateId },
      });
      expect(applied.statusCode).toBe(200);
      expect(payload<{ medicines: Array<{ name: string }> }>(applied).medicines).toEqual([
        expect.objectContaining({ name: 'Sertraline' }),
      ]);

      const updated = await app.inject({
        method: 'PUT',
        url: `/api/doctors/me/clinical-templates/${templateId}`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { name: `Renamed ${runId}` },
      });
      expect(updated.statusCode).toBe(200);
      // PUT semantics here too: `medicines` omitted -> cleared.
      expect(payload<{ medicines: unknown[] }>(updated).medicines).toEqual([]);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/doctors/me/clinical-templates/${templateId}`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(deleted.statusCode).toBe(204);
      templateIds.pop();

      const getAfterDelete = await app.inject({
        method: 'GET',
        url: `/api/doctors/me/clinical-templates/${templateId}`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(getAfterDelete.statusCode).toBe(404);
    });

    it('a stranger doctor cannot apply another doctor\'s template — same 404 as unknown', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/doctors/me/clinical-templates',
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { name: `Owner-only ${runId}` },
      });
      const templateId = payload<{ id: string }>(created).id;
      templateIds.push(templateId);

      const response = await app.inject({
        method: 'GET',
        url: `/api/doctors/me/clinical-templates/${templateId}`,
        headers: { authorization: `Bearer ${strangerDoctorToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.TEMPLATE_NOT_FOUND);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* The completion gate                                                   */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('the completion gate (FR-11.5), over real HTTP', () => {
    it('refuses with no case summary', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED);
    });

    it('refuses with a case summary but neither medicine nor advice', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low', caseSummary: 'A summary with nothing else.' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED);
    });

    it('succeeds with case summary + full advice for a NON-prescribing specialty', async () => {
      const consultationId = await makeConsultation({ specialtyId: nonPrescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'Exam anxiety.',
          riskCategory: 'low',
          caseSummary: 'Reviewed coping strategies.',
          adviceCovered: 'Breathing techniques.',
          adviceHomePractice: 'Daily 10-minute practice.',
          adviceNextFocus: 'Exposure to exam conditions.',
          adviceWarningSigns: 'Panic attacks worsening.',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ consultationStatus: string }>(response).consultationStatus).toBe('completed');
    });

    it('succeeds with case summary + one medicine and NO advice for a PRESCRIBING specialty', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'Low mood.',
          riskCategory: 'low',
          caseSummary: 'Started sertraline, review in two weeks.',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ consultationStatus: string }>(response).consultationStatus).toBe('completed');
    });

    it('a non-prescribing consultation refuses a medicine line at SAVE time, not just at finalise', async () => {
      const consultationId = await makeConsultation({ specialtyId: nonPrescribingSpecialtyId, doctorId });
      const response = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'x',
          riskCategory: 'low',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED);
    });

    it('finalising twice: second call is REFUSED, not a second success', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low', caseSummary: 'x', medicines: [{ name: 'A', dose: 'b', frequency: 'c', duration: 'd' }] },
      });
      const first = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe(CLINICAL_ERROR_CODES.CONSULTATION_NOT_WRITABLE);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* POST .../clinical-record/prescription-pdf — the doctor-facing retry   */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('POST /clinical-record/prescription-pdf — the finalised-only retry route', () => {
    it('refuses a record that is not yet finalised — reusing PRESCRIPTION_OR_ADVICE_REQUIRED (see report: this code is also used for the completion gate\'s "no medicine/advice" refusal, a different condition)', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'x',
          riskCategory: 'low',
          caseSummary: 'A complete-enough draft, just never finalised.',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/prescription-pdf`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED);
    });

    it('404s for no record at all yet (RECORD_NOT_FOUND) and for an unknown/not-yours consultation (CONSULTATION_NOT_FOUND)', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });

      const noRecord = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/prescription-pdf`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(noRecord.statusCode).toBe(404);
      expect(payload<{ code: string }>(noRecord).code).toBe(CLINICAL_ERROR_CODES.RECORD_NOT_FOUND);

      const notMine = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId: strangerDoctorId });
      const wrongOwner = await app.inject({
        method: 'POST',
        url: `/api/consultations/${notMine}/clinical-record/prescription-pdf`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(wrongOwner.statusCode).toBe(404);
      expect(payload<{ code: string }>(wrongOwner).code).toBe(CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND);
    });

    it('succeeds for a finalised record — `fileId` is `null` because `generateForConsultation` is stubbed (no S3/Cloudinary here)', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'x',
          riskCategory: 'low',
          caseSummary: 'x',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });
      const finalised = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(finalised.statusCode).toBe(200);

      const retry = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/prescription-pdf`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(retry.statusCode).toBe(200);
      expect(payload<{ fileId: string | null }>(retry).fileId).toBeNull();
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* *** THE PRESCRIBING GATE: BOOKING-TIME SNAPSHOT, NOT DOCTOR PRIMARY.  */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('the prescribing gate reads the CONSULTATION\'s booking-time specialty, never the doctor\'s primary specialty', () => {
    it('a doctor whose PRIMARY specialty is non-prescribing can still prescribe on a consultation booked under a prescribing specialty they also practise', async () => {
      // `doctorId`'s primary is `prescribingSpecialtyId` (set in beforeAll).
      // Build a SEPARATE doctor whose primary is the NON-prescribing specialty,
      // who ALSO practises the prescribing one as a secondary — proving the
      // gate is not "is the doctor's primary specialty prescribing?".
      const [mixedDoctor] = await db
        .insert(doctorsTable)
        .values({ mobileNumber: nextPhone(), fullName: `HTTP Mixed Doctor ${runId}`, verificationStatus: 'verified', isListed: true })
        .returning({ id: doctorsTable.id });
      doctorIds.push(mixedDoctor.id);
      await db.insert(doctorSpecialtiesTable).values({ doctorId: mixedDoctor.id, specialtyId: nonPrescribingSpecialtyId, isPrimary: true });
      await db.insert(doctorSpecialtiesTable).values({ doctorId: mixedDoctor.id, specialtyId: prescribingSpecialtyId, isPrimary: false });
      const mixedToken = await mintToken('doctor', mixedDoctor.id);

      // Booked under the PRESCRIBING specialty, even though this doctor's
      // primary is the non-prescribing one.
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId: mixedDoctor.id });

      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${mixedToken}` },
        payload: {
          chiefComplaint: 'Low mood.',
          riskCategory: 'low',
          caseSummary: 'Prescribed under the booked specialty.',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${mixedToken}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('a doctor whose PRIMARY specialty is prescribing is still REFUSED a medicine line on a consultation booked under a non-prescribing specialty they also practise', async () => {
      // `doctorId`'s primary is prescribing (beforeAll), and it also practises
      // the non-prescribing specialty as a secondary. Book UNDER the
      // non-prescribing one and prove the primary does not rescue it.
      const consultationId = await makeConsultation({ specialtyId: nonPrescribingSpecialtyId, doctorId });

      const response = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: {
          chiefComplaint: 'x',
          riskCategory: 'low',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED);
    });

    it('*** THE ADVERSARIAL CASE: the doctor\'s PRIMARY specialty changes AFTER booking, and the OLD consultation is unaffected ***', async () => {
      // A dedicated doctor + specialty pair so flipping `is_primary` here
      // cannot disturb any other test.
      const [flipSpecialty] = await db
        .insert(specialtiesTable)
        .values({ code: `clin_http_flip_${runId}`, name: `HTTP Flip ${runId}`, canPrescribe: true, isActive: true })
        .returning({ id: specialtiesTable.id });
      specialtyIds.push(flipSpecialty.id);

      const [flipDoctor] = await db
        .insert(doctorsTable)
        .values({ mobileNumber: nextPhone(), fullName: `HTTP Flip Doctor ${runId}`, verificationStatus: 'verified', isListed: true })
        .returning({ id: doctorsTable.id });
      doctorIds.push(flipDoctor.id);
      // At booking time, primary = prescribing. Also practises the
      // non-prescribing specialty (needed below) and `flipSpecialty`.
      await db.insert(doctorSpecialtiesTable).values({ doctorId: flipDoctor.id, specialtyId: prescribingSpecialtyId, isPrimary: true });
      await db.insert(doctorSpecialtiesTable).values({ doctorId: flipDoctor.id, specialtyId: flipSpecialty.id, isPrimary: false });
      await db.insert(doctorSpecialtiesTable).values({ doctorId: flipDoctor.id, specialtyId: nonPrescribingSpecialtyId, isPrimary: false });
      const flipToken = await mintToken('doctor', flipDoctor.id);

      // Booked under `prescribingSpecialtyId` — the doctor's primary AT THE TIME.
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId: flipDoctor.id });

      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${flipToken}` },
        payload: {
          chiefComplaint: 'Low mood.',
          riskCategory: 'low',
          caseSummary: 'Booking-time snapshot proof.',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });

      // NOW the doctor's primary specialty changes: `flipSpecialty` (also
      // prescribing, so this alone does not change eligibility) becomes
      // primary, AND — the adversarial half — the doctor's practised set no
      // longer privileges `prescribingSpecialtyId` at all as primary.
      await db.update(doctorSpecialtiesTable).set({ isPrimary: false }).where(eq(doctorSpecialtiesTable.doctorId, flipDoctor.id));
      await db
        .update(doctorSpecialtiesTable)
        .set({ isPrimary: true })
        .where(sql`doctor_id = ${flipDoctor.id} and specialty_id = ${flipSpecialty.id}`);

      // The OLD consultation must still finalise successfully: the gate reads
      // `consultations.specialty_id -> specialties.can_prescribe`
      // (`prescribingSpecialtyId`, still `true`), never the doctor's
      // now-different primary specialty.
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/clinical-record/finalise`,
        headers: { authorization: `Bearer ${flipToken}` },
      });
      expect(response.statusCode).toBe(200);

      // And the converse direction, same doctor: a NEW consultation booked
      // under the NON-prescribing specialty is refused a medicine line even
      // though this doctor's CURRENT primary (`flipSpecialty`) can prescribe.
      const newConsultationId = await makeConsultation({ specialtyId: nonPrescribingSpecialtyId, doctorId: flipDoctor.id });
      const refused = await app.inject({
        method: 'PUT',
        url: `/api/consultations/${newConsultationId}/clinical-record`,
        headers: { authorization: `Bearer ${flipToken}` },
        payload: {
          chiefComplaint: 'x',
          riskCategory: 'low',
          medicines: [{ name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days' }],
        },
      });
      expect(refused.statusCode).toBe(409);
      expect(payload<{ code: string }>(refused).code).toBe(CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* GET own record writes a `read` audit_log entry (M-21)                */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('M-21: GET own clinical record writes a `read` audit_log entry', () => {
    it('reading an existing record audits it; reading a consultation with no draft yet does not', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });

      // No draft yet: GET succeeds with `null`, and nothing is audited (the
      // service's own comment: "only written when there is an actual record
      // to have read").
      const empty = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(empty.statusCode).toBe(200);
      expect(payload<unknown>(empty)).toBeNull();

      const auditsBeforeDraft = await db.execute(
        sql`select count(*)::int as n from audit_log where consultation_id = ${consultationId} and action = 'read'`,
      );
      expect((auditsBeforeDraft.rows as Array<{ n: number }>)[0].n).toBe(0);

      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low' },
      });

      const read = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(read.statusCode).toBe(200);

      const audits = await db.execute(
        sql`select entity_type, action, actor_type from audit_log where consultation_id = ${consultationId} and action = 'read'`,
      );
      expect(audits.rows.length).toBeGreaterThanOrEqual(1);
      const row = (audits.rows as Array<{ entity_type: string; action: string; actor_type: string }>)[0];
      expect(row.entity_type).toBe('clinical_record');
      expect(row.actor_type).toBe('doctor');
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Admin reads (clinical.read_records) + audit trail                    */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('admin reads under clinical.read_records', () => {
    it('GET /admin/clinical-records/:id and .../audit-trail both require the permission and are themselves audited', async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      await app.inject({
        method: 'PUT',
        url: `/api/consultations/${consultationId}/clinical-record`,
        headers: { authorization: `Bearer ${doctorToken}` },
        payload: { chiefComplaint: 'x', riskCategory: 'low', caseSummary: 'x' },
      });

      const record = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}`,
        headers: { authorization: `Bearer ${readRecordsAdminToken}` },
      });
      expect(record.statusCode).toBe(200);

      const trail = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}/audit-trail`,
        headers: { authorization: `Bearer ${readRecordsAdminToken}` },
      });
      expect(trail.statusCode).toBe(200);
      expect(Array.isArray(payload<unknown[]>(trail))).toBe(true);

      const audits = await db.execute(
        sql`select count(*)::int as n from audit_log where consultation_id = ${consultationId} and actor_id = ${readRecordsAdminId} and action = 'read'`,
      );
      expect((audits.rows as Array<{ n: number }>)[0].n).toBeGreaterThanOrEqual(2);

      const trailWithoutPerm = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${consultationId}/audit-trail`,
        headers: { authorization: `Bearer ${plainAdminToken}` },
      });
      expect(trailWithoutPerm.statusCode).toBe(403);
    });

    it('an unknown consultation id 404s for the admin read too', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/clinical-records/${randomUUID()}`,
        headers: { authorization: `Bearer ${readRecordsAdminToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(CLINICAL_ERROR_CODES.RECORD_NOT_FOUND);
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* The prescription-PDF download route's permission gate                */
  /* (`GET /documents/:id/download`, narrowed to `prescription_pdf`)      */
  /* ════════════════════════════════════════════════════════════════════ */

  describe("the prescription-PDF download route's permission gate, narrowed to prescription_pdf (M-21/M-10)", () => {
    let prescriptionFileId: string;
    let ordinaryFileId: string;

    beforeAll(async () => {
      const consultationId = await makeConsultation({ specialtyId: prescribingSpecialtyId, doctorId });
      const [file] = await db
        .insert(patientFilesTable)
        .values({
          patientId,
          consultationId,
          fileCategory: 'prescription_pdf',
          fileName: `prescription-${runId}.pdf`,
          storageKey: `test/${runId}/prescription-${randomUUID()}.pdf`,
        })
        .returning({ id: patientFilesTable.id });
      prescriptionFileId = file.id;
      patientFileIds.push(prescriptionFileId);

      const [ordinary] = await db
        .insert(patientFilesTable)
        .values({
          patientId,
          consultationId,
          fileCategory: 'medical_history',
          fileName: `history-${runId}.pdf`,
          storageKey: `test/${runId}/history-${randomUUID()}.pdf`,
        })
        .returning({ id: patientFilesTable.id });
      ordinaryFileId = ordinary.id;
      patientFileIds.push(ordinaryFileId);
    });

    it('an admin WITHOUT clinical.read_records is refused a prescription_pdf — 404, not 403 (no existence leak)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/documents/${prescriptionFileId}/download`,
        headers: { authorization: `Bearer ${plainAdminToken}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('an admin holding an UNRELATED permission is refused the same way — the gate does not leak to any admin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/documents/${prescriptionFileId}/download`,
        headers: { authorization: `Bearer ${unrelatedAdminToken}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('an admin WITH clinical.read_records is allowed', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/documents/${prescriptionFileId}/download`,
        headers: { authorization: `Bearer ${readRecordsAdminToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ url: string }>(response).url).toBeTruthy();
    });

    it('the narrowing is to prescription_pdf ONLY — an admin with NO grants at all can still download an ordinary file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/documents/${ordinaryFileId}/download`,
        headers: { authorization: `Bearer ${plainAdminToken}` },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
