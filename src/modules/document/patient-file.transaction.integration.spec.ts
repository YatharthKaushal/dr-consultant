/**
 * *** THE REPO'S FIRST REAL-DATABASE TEST. READ BEFORE COPYING. ***
 *
 * Every other `.spec.ts` in this codebase is a pure unit test with mocked
 * repositories. This one is deliberately different, because there is a class
 * of claim a mocked test CANNOT make.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `patient-file.service.ts#upload` promises that, when a file is uploaded
 * against an open report request, the `patient_files` INSERT and the
 * `report_requests` status flip to `fulfilled` happen in ONE transaction —
 * a failure partway through must leave NEITHER write committed.
 *
 * `patient-file.service.spec.ts` has a test named "rolls back BOTH writes
 * when the fulfil half rejects mid-transaction". It does not prove that. It
 * fakes the transaction entirely:
 *
 *     const db = { transaction: jest.fn(async (cb) => cb(db)) }
 *
 * and then asserts `expect(repo.create).toHaveBeenCalledTimes(1)`. A mock
 * that invokes its callback has no rollback semantics at all — those
 * assertions would pass identically against code with NO transaction in it.
 * It proves both methods were called; it says nothing about what Postgres
 * did with them.
 *
 * This file closes that gap with the real thing: a real connection, real
 * repositories, a real `db.transaction`, real rows — then it forces a failure
 * after the first write has genuinely executed inside the transaction, and
 * goes back to the database with a fresh query to confirm the row is not
 * there.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do. It fails loudly rather than skipping if the database is unreachable:
 * a silently-skipped integrity test is precisely the "test that only looks
 * like one" this file was written to replace.
 *
 * ── Pattern notes for the next module (M-11 booking, M-12 payments) ────────
 *
 * Both of those own money-and-state transactions that need exactly this kind
 * of proof, so the shape here is meant to be copied:
 *   1. `beforeAll` connects and builds fixtures through ONE helper that
 *      returns every id it created.
 *   2. `afterAll` deletes them in strict reverse FK order — see `teardown`.
 *   3. Every fixture is namespaced by a per-run UUID suffix, so a crashed run
 *      never collides with the next one and never touches real data.
 *   4. There is a POSITIVE CONTROL alongside the rollback test. Without one,
 *      "the row is absent" could pass vacuously because the insert never ran.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientFilesTable } from '../../schema/patient-files.schema';
import { patientsTable } from '../../schema/patients.schema';
import { paymentsTable } from '../../schema/payments.schema';
import { reportRequestsTable } from '../../schema/report-requests.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { ConsultationLookupPort } from './consultation-lookup.provider';
import type { DocumentStoragePort } from './document-storage.contract';
import { PatientFileRepository } from './patient-file.repository';
import { PatientFileService } from './patient-file.service';
import { ReportRequestRepository } from './report-request.repository';

jest.setTimeout(30_000);

/** A real PDF's magic bytes — the upload path sniffs content, so the fixture must be genuine. */
const PDF_BYTES = (() => {
  const buffer = Buffer.alloc(64, 0x00);
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]).copy(buffer, 0);
  return buffer;
})();

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  doctorId: string;
  consultationId: string;
  reportRequestId: string;
}

/**
 * Builds the minimum real row graph an upload-against-a-report-request needs.
 *
 * *** THE CONSULTATION INSERT ORDER IS NOT ARBITRARY. ***
 * A `consultations` row inserts on its own. It did not always: until
 * migration 0006 two REVERSE, non-deferrable foreign keys ran from
 * `consultations.id` to `payments.consultation_id` and
 * `clinical_records.consultation_id`, so a booking could not exist until stub
 * payment and clinical-record rows already carried its id — impossible in
 * practice, since a clinical record needs `chief_complaint`/`risk_category`
 * that only exist after the consult. This fixture used to carry that
 * workaround; 0006 corrected the FK direction and it is gone.
 */
async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const consultationId = randomUUID();

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `itest_${runId}`, name: `Integration Test Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: `+9199${runId.slice(0, 6)}01`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    // `doctors` has no `status` column — activity is derived from
    // `verification_status` (`identity.repository.ts`: anything but
    // `rejected`/`suspended` counts as active). `verified` is what a real
    // treating doctor holds.
    .values({ mobileNumber: `+9199${runId.slice(0, 6)}02`, fullName: `Integration Test Doctor ${runId}`, verificationStatus: 'verified' })
    .returning({ id: doctorsTable.id });

  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  await db.insert(consultationsTable).values({
    id: consultationId,
    referenceCode: `ITEST-${runId}`,
    patientId: patient.id,
    doctorId: doctor.id,
    specialtyId: specialty.id,
    mode: 'scheduled',
    status: 'in_progress',
    durationMinutes: 30,
  });

  const [reportRequest] = await db
    .insert(reportRequestsTable)
    .values({ consultationId, title: 'Blood test', status: 'open' })
    .returning({ id: reportRequestsTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    doctorId: doctor.id,
    consultationId,
    reportRequestId: reportRequest.id,
  };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  await db.delete(patientFilesTable).where(eq(patientFilesTable.patientId, fixtures.patientId));
  await db.delete(reportRequestsTable).where(eq(reportRequestsTable.consultationId, fixtures.consultationId));
  await db.execute(sql`delete from audit_log where actor_id = ${fixtures.patientId}`);
  // `payments`/`clinical_records` are CHILDREN of `consultations` since
  // migration 0006 flipped the FK direction, so they go first. This fixture no
  // longer creates either, making both deletes no-ops — they stay as defensive
  // cleanup for any test that later does, and in the order that will actually
  // work when one does.
  await db.delete(clinicalRecordsTable).where(eq(clinicalRecordsTable.consultationId, fixtures.consultationId));
  await db.delete(paymentsTable).where(eq(paymentsTable.consultationId, fixtures.consultationId));
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.consultationId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

describe('PatientFileService.upload — REAL transaction atomicity (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let reportRequestRepo: ReportRequestRepository;
  let service: PatientFileService;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    // REAL repositories and a REAL db handle — the whole point. Only the two
    // genuinely external things are stubbed: object storage (irrelevant here,
    // and it is called BEFORE the transaction opens) and the app-config read.
    const fileRepo = new PatientFileRepository(db);
    reportRequestRepo = new ReportRequestRepository(db);

    const storage: DocumentStoragePort = {
      store: async () => ({ storageKey: `s3:medical_history/${randomUUID()}.pdf`, sizeBytes: PDF_BYTES.length }),
      getSignedUrl: async () => 'https://example.invalid/signed',
      delete: async () => undefined,
      isAvailable: async () => true,
    };

    const consultationLookup: ConsultationLookupPort = {
      findById: async (id) =>
        id === fixtures.consultationId
          ? { id: fixtures.consultationId, patientId: fixtures.patientId, doctorId: fixtures.doctorId, status: 'in_progress' }
          : null,
      listConsultationIdsBetween: async () => [fixtures.consultationId],
      listConsultationIdsForPatient: async () => [fixtures.consultationId],
    };

    const appConfig = { getNumber: async (_key: string, fallback: number) => fallback } as unknown as AppConfigService;

    service = new PatientFileService(
      db,
      fileRepo,
      reportRequestRepo,
      consultationLookup,
      storage,
      appConfig,
      new AuditService(db),
    );
  });

  afterAll(async () => {
    if (db && fixtures) await teardown(db, fixtures);
    await disconnectDatabase();
  });

  /** Reads straight from Postgres, bypassing every repository — the assertions must not trust the code under test. */
  async function countFilesForRequest(reportRequestId: string): Promise<number> {
    const rows = await db.select().from(patientFilesTable).where(eq(patientFilesTable.reportRequestId, reportRequestId));
    return rows.length;
  }

  async function readRequestStatus(reportRequestId: string): Promise<string | undefined> {
    const [row] = await db.select().from(reportRequestsTable).where(eq(reportRequestsTable.id, reportRequestId));
    return row?.status;
  }

  it('rolls the patient_files INSERT back when the fulfil half throws mid-transaction', async () => {
    expect(await countFilesForRequest(fixtures.reportRequestId)).toBe(0);
    expect(await readRequestStatus(fixtures.reportRequestId)).toBe('open');

    // Fail the SECOND write only, and only AFTER the first has really run
    // inside the open transaction. This is the moment the mocked test could
    // never actually reach.
    const spy = jest
      .spyOn(reportRequestRepo, 'updateStatusIfOpen')
      .mockRejectedValueOnce(new Error('simulated failure after the file insert'));

    await expect(
      service.upload(fixtures.patientId, {
        category: 'medical_history',
        reportRequestId: fixtures.reportRequestId,
        buffer: PDF_BYTES,
        fileName: 'rollback-probe.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
      }),
    ).rejects.toThrow('simulated failure after the file insert');

    spy.mockRestore();

    // THE ASSERTION THAT MATTERS: a fresh read from Postgres. The insert
    // genuinely executed inside the transaction, and Postgres genuinely
    // discarded it.
    expect(await countFilesForRequest(fixtures.reportRequestId)).toBe(0);
    expect(await readRequestStatus(fixtures.reportRequestId)).toBe('open');
  });

  it('POSITIVE CONTROL: the same call commits BOTH writes when nothing fails', async () => {
    // Without this, the test above could pass vacuously — "no row" proves
    // rollback only if the identical call demonstrably DOES write a row when
    // it is allowed to finish.
    const result = await service.upload(fixtures.patientId, {
      category: 'medical_history',
      reportRequestId: fixtures.reportRequestId,
      buffer: PDF_BYTES,
      fileName: 'committed.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
    });

    expect(result.reportRequestId).toBe(fixtures.reportRequestId);
    expect(await countFilesForRequest(fixtures.reportRequestId)).toBe(1);
    expect(await readRequestStatus(fixtures.reportRequestId)).toBe('fulfilled');
  });

  it('rejects a second upload against the now-fulfilled request, and writes no second row', async () => {
    await expect(
      service.upload(fixtures.patientId, {
        category: 'medical_history',
        reportRequestId: fixtures.reportRequestId,
        buffer: PDF_BYTES,
        fileName: 'second-attempt.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'DOCUMENT_REPORT_REQUEST_NOT_OPEN' } });

    expect(await countFilesForRequest(fixtures.reportRequestId)).toBe(1);
  });
});
