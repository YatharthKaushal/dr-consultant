import { ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { PatientFileRow } from '../../schema/patient-files.schema';
import type { ReportRequestRow } from '../../schema/report-requests.schema';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import type { ConsultationLookupPort, ConsultationSummary } from './consultation-lookup.provider';
import type { DocumentStoragePort } from './document-storage.contract';
import { DOCUMENT_ERROR_CODES } from './document.constants';
import { PatientFileService, type UploadFileInput } from './patient-file.service';
import type { PatientFileRepository } from './patient-file.repository';
import type { ReportRequestRepository } from './report-request.repository';

// `resolveConsultationId`/`resolveReportRequest` run `isUUID()` on any
// caller-supplied `consultationId`/`reportRequestId` (real multipart form
// fields, unvalidated by a Nest pipe) — so these fixtures use real
// UUID-shaped strings, matching what a real Postgres `uuid` primary key
// actually looks like, rather than human-readable slugs.
const PATIENT_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PATIENT_ID = 'a0000000-0000-4000-8000-000000000002';
const DOCTOR_ID = 'b0000000-0000-4000-8000-000000000001';
const OTHER_DOCTOR_ID = 'b0000000-0000-4000-8000-000000000002';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const REPORT_REQUEST_ID = 'd0000000-0000-4000-8000-000000000001';

function fileRow(overrides: Partial<PatientFileRow> = {}): PatientFileRow {
  return {
    id: 'file-1',
    fileCategory: 'medical_history',
    patientId: PATIENT_ID,
    uploadedByDoctorId: null,
    consultationId: null,
    reportRequestId: null,
    clarificationCaseId: null,
    storageKey: 'storage-key-1',
    fileName: 'report.pdf',
    deletedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function consultation(overrides: Partial<ConsultationSummary> = {}): ConsultationSummary {
  return {
    id: CONSULTATION_ID,
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    status: 'in_progress',
    ...overrides,
  };
}

function reportRequestRow(overrides: Partial<ReportRequestRow> = {}): ReportRequestRow {
  return {
    id: REPORT_REQUEST_ID,
    consultationId: CONSULTATION_ID,
    title: 'Blood test',
    reason: null,
    status: 'open',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * REAL magic bytes. The upload path sniffs the buffer
 * (`verifyDeclaredContentType`) and rejects a file whose bytes contradict its
 * declared `contentType`, so a fixture carrying `Buffer.from('hello')` under
 * `application/pdf` — which is what these tests used before content sniffing
 * existed — is now correctly rejected, and would make every happy-path test
 * here fail for the wrong reason.
 */
function fileStartingWith(signature: number[], totalLength = 64): Buffer {
  const buffer = Buffer.alloc(totalLength, 0x00);
  Buffer.from(signature).copy(buffer, 0);
  return buffer;
}

const PDF_BYTES = fileStartingWith([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG_BYTES = fileStartingWith([0xff, 0xd8, 0xff, 0xe0]);
const PNG_BYTES = fileStartingWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function uploadInput(overrides: Partial<UploadFileInput> = {}): UploadFileInput {
  return {
    category: 'medical_history',
    buffer: PDF_BYTES,
    fileName: 'history.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

function auth(accountType: AuthContext['accountType'], accountId: string): AuthContext {
  return { accountType, accountId };
}

function createService() {
  const repo = {
    create: jest.fn(),
    findById: jest.fn(),
    listByPatient: jest.fn().mockResolvedValue([]),
    listForDoctorHistory: jest.fn().mockResolvedValue([]),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<PatientFileRepository>;

  const reportRequestRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    listByConsultation: jest.fn(),
    listByConsultations: jest.fn(),
    updateStatusIfOpen: jest.fn(),
  } as unknown as jest.Mocked<ReportRequestRepository>;

  const consultationLookup = {
    findById: jest.fn(),
    listConsultationIdsBetween: jest.fn().mockResolvedValue([]),
    listConsultationIdsForPatient: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ConsultationLookupPort>;

  const storage = {
    store: jest.fn(),
    getSignedUrl: jest.fn(),
    delete: jest.fn(),
    isAvailable: jest.fn(),
  } as unknown as jest.Mocked<DocumentStoragePort>;

  const appConfig = {
    getNumber: jest.fn().mockResolvedValue(15),
  } as unknown as jest.Mocked<AppConfigService>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  // Same fake-transaction pattern as `availability-rule.service.spec.ts`: `.transaction()` just
  // invokes the callback with itself as `tx` — the mocked repos ignore the executor argument anyway.
  const db = {
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  } as unknown as jest.Mocked<Database>;

  const service = new PatientFileService(db, repo, reportRequestRepo, consultationLookup, storage, appConfig, audit);

  return { service, db, repo, reportRequestRepo, consultationLookup, storage, appConfig, audit };
}

describe('PatientFileService.upload', () => {
  it('accepts a medical_history upload with no consultationId', async () => {
    const { service, repo, storage, audit } = createService();
    storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
    repo.create.mockResolvedValue(fileRow({ storageKey: 'key-1' }));

    const result = await service.upload(PATIENT_ID, uploadInput());

    expect(storage.store).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: 'history.pdf',
      contentType: 'application/pdf',
      category: 'medical_history',
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: PATIENT_ID, fileCategory: 'medical_history', consultationId: null, storageKey: 'key-1' }),
    );
    expect(result).not.toHaveProperty('storageKey');
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', actorId: PATIENT_ID }));
  });

  it('rejects prescription_pdf on the patient upload path, with no storage/DB call', async () => {
    const { service, storage, repo } = createService();

    await expect(service.upload(PATIENT_ID, uploadInput({ category: 'prescription_pdf' }))).rejects.toMatchObject({
      status: 400,
      response: { code: DOCUMENT_ERROR_CODES.CATEGORY_NOT_UPLOADABLE },
    });
    expect(storage.store).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects clarification_attachment on the patient upload path too', async () => {
    const { service, storage } = createService();
    await expect(service.upload(PATIENT_ID, uploadInput({ category: 'clarification_attachment' }))).rejects.toMatchObject({
      status: 400,
      response: { code: DOCUMENT_ERROR_CODES.CATEGORY_NOT_UPLOADABLE },
    });
    expect(storage.store).not.toHaveBeenCalled();
  });

  it('rejects an unknown category', async () => {
    const { service } = createService();
    await expect(service.upload(PATIENT_ID, uploadInput({ category: 'not-a-real-category' }))).rejects.toMatchObject({
      status: 400,
      response: { code: DOCUMENT_ERROR_CODES.CATEGORY_NOT_UPLOADABLE },
    });
  });

  it('rejects a MIME type not on the allowlist for the category, with no storage/DB call', async () => {
    const { service, storage, repo } = createService();
    await expect(service.upload(PATIENT_ID, uploadInput({ contentType: 'application/zip' }))).rejects.toMatchObject({
      status: 415,
      response: { code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE },
    });
    expect(storage.store).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a file over the resolved size cap, with no storage/DB call', async () => {
    const { service, appConfig, storage, repo } = createService();
    appConfig.getNumber.mockResolvedValue(1);

    await expect(service.upload(PATIENT_ID, uploadInput({ sizeBytes: 2 * 1024 * 1024 }))).rejects.toMatchObject({
      status: 413,
      response: { code: DOCUMENT_ERROR_CODES.FILE_TOO_LARGE },
    });
    expect(storage.store).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  describe('consultationId ownership', () => {
    it('accepts a consultationId that belongs to the caller', async () => {
      const { service, consultationLookup, storage, repo } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
      repo.create.mockResolvedValue(fileRow({ consultationId: CONSULTATION_ID }));

      await service.upload(PATIENT_ID, uploadInput({ consultationId: CONSULTATION_ID }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ consultationId: CONSULTATION_ID }));
    });

    it('rejects a consultationId belonging to a DIFFERENT patient, with no writes', async () => {
      const { service, consultationLookup, storage, repo } = createService();
      consultationLookup.findById.mockResolvedValue(consultation({ patientId: OTHER_PATIENT_ID }));

      await expect(service.upload(PATIENT_ID, uploadInput({ consultationId: CONSULTATION_ID }))).rejects.toMatchObject({
        status: 404,
        response: { code: DOCUMENT_ERROR_CODES.CONSULTATION_NOT_FOUND },
      });
      expect(storage.store).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a consultationId that does not exist at all', async () => {
      const { service, consultationLookup } = createService();
      consultationLookup.findById.mockResolvedValue(null);
      await expect(service.upload(PATIENT_ID, uploadInput({ consultationId: CONSULTATION_ID }))).rejects.toMatchObject({
        status: 404,
        response: { code: DOCUMENT_ERROR_CODES.CONSULTATION_NOT_FOUND },
      });
    });

    it('rejects a malformed consultationId', async () => {
      const { service } = createService();
      await expect(service.upload(PATIENT_ID, uploadInput({ consultationId: 'not-a-uuid' }))).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_FAILED' },
      });
    });
  });

  describe('reportRequestId — implicit fulfilment', () => {
    it('inserts the file AND flips the request to fulfilled, both inside ONE transaction', async () => {
      const { service, repo, reportRequestRepo, consultationLookup, storage, db, audit } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ status: 'open' }));
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
      repo.create.mockResolvedValue(fileRow({ reportRequestId: REPORT_REQUEST_ID, consultationId: CONSULTATION_ID }));
      reportRequestRepo.updateStatusIfOpen.mockResolvedValue(reportRequestRow({ status: 'fulfilled' }));

      const result = await service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }));

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ reportRequestId: REPORT_REQUEST_ID, consultationId: CONSULTATION_ID }),
        db,
      );
      expect(reportRequestRepo.updateStatusIfOpen).toHaveBeenCalledWith(REPORT_REQUEST_ID, 'fulfilled', db);
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }), db);
      expect(result.reportRequestId).toBe(REPORT_REQUEST_ID);
    });

    it('derives consultationId from the report request when only reportRequestId is given', async () => {
      const { service, repo, reportRequestRepo, consultationLookup, storage } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ status: 'open', consultationId: CONSULTATION_ID }));
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
      repo.create.mockResolvedValue(fileRow());
      reportRequestRepo.updateStatusIfOpen.mockResolvedValue(reportRequestRow({ status: 'fulfilled' }));

      await service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ consultationId: CONSULTATION_ID }), expect.anything());
    });

    it.each(['fulfilled', 'cancelled'] as const)('rejects an upload against a request that is already %s, with no writes', async (status) => {
      const { service, reportRequestRepo, consultationLookup, storage, repo } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ status }));

      await expect(service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }))).rejects.toMatchObject({
        status: 409,
        response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_OPEN },
      });
      expect(storage.store).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a reportRequestId that does not exist', async () => {
      const { service, reportRequestRepo } = createService();
      reportRequestRepo.findById.mockResolvedValue(null);
      await expect(service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }))).rejects.toMatchObject({
        status: 404,
        response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_FOUND },
      });
    });

    it('rejects a reportRequestId whose consultation belongs to a DIFFERENT patient, with no writes', async () => {
      const { service, reportRequestRepo, consultationLookup, storage, repo } = createService();
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow());
      consultationLookup.findById.mockResolvedValue(consultation({ patientId: OTHER_PATIENT_ID }));

      await expect(service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }))).rejects.toMatchObject({
        status: 404,
        response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_FOUND },
      });
      expect(storage.store).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects when an explicit consultationId disagrees with the reportRequestId\'s own consultation', async () => {
      const { service, reportRequestRepo, consultationLookup } = createService();
      consultationLookup.findById.mockImplementation(async (id: string) =>
        id === CONSULTATION_ID ? consultation({ id: CONSULTATION_ID }) : consultation({ id, patientId: PATIENT_ID }),
      );
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ consultationId: 'consultation-other' }));

      await expect(
        service.upload(PATIENT_ID, uploadInput({ consultationId: CONSULTATION_ID, reportRequestId: REPORT_REQUEST_ID })),
      ).rejects.toMatchObject({ status: 400, response: { code: 'VALIDATION_FAILED' } });
    });

    it('rolls back BOTH writes when the fulfil half rejects mid-transaction — proves the insert and the CAS update share one transaction', async () => {
      const { service, repo, reportRequestRepo, consultationLookup, storage, db } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ status: 'open' }));
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
      repo.create.mockResolvedValue(fileRow({ reportRequestId: REPORT_REQUEST_ID }));
      reportRequestRepo.updateStatusIfOpen.mockRejectedValue(new Error('connection reset mid-transaction'));

      await expect(service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }))).rejects.toThrow(
        'connection reset mid-transaction',
      );

      // Both writes were attempted INSIDE the single `db.transaction(...)` call — a real
      // Postgres transaction rolls back everything the callback did once it throws.
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(reportRequestRepo.updateStatusIfOpen).toHaveBeenCalledTimes(1);
    });

    it('also rolls back when the fulfil update finds the request already left open (race, not a thrown error)', async () => {
      const { service, repo, reportRequestRepo, consultationLookup, storage, db } = createService();
      consultationLookup.findById.mockResolvedValue(consultation());
      reportRequestRepo.findById.mockResolvedValue(reportRequestRow({ status: 'open' }));
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 1024 });
      repo.create.mockResolvedValue(fileRow({ reportRequestId: REPORT_REQUEST_ID }));
      reportRequestRepo.updateStatusIfOpen.mockResolvedValue(null);

      await expect(service.upload(PATIENT_ID, uploadInput({ reportRequestId: REPORT_REQUEST_ID }))).rejects.toMatchObject({
        status: 409,
        response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_OPEN },
      });
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('content sniffing — a lying Content-Type cannot get bytes stored', () => {
    it('rejects a ZIP payload declared as application/pdf, with no storage/DB call', async () => {
      const { service, storage, repo } = createService();
      const zipBytes = fileStartingWith([0x50, 0x4b, 0x03, 0x04]);

      await expect(
        service.upload(PATIENT_ID, uploadInput({ buffer: zipBytes, contentType: 'application/pdf' })),
      ).rejects.toMatchObject({ status: 415, response: { code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE } });

      expect(storage.store).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects an ELF executable declared as image/jpeg — the malware-through-the-doctor-viewer shape', async () => {
      const { service, storage } = createService();
      const elfBytes = fileStartingWith([0x7f, 0x45, 0x4c, 0x46]);

      await expect(
        service.upload(PATIENT_ID, uploadInput({ category: 'photo', buffer: elfBytes, contentType: 'image/jpeg' })),
      ).rejects.toMatchObject({ status: 415, response: { code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE } });
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('rejects HTML declared as image/png', async () => {
      const { service, storage } = createService();

      await expect(
        service.upload(PATIENT_ID, uploadInput({ category: 'report', buffer: Buffer.from('<html></html>'), contentType: 'image/png' })),
      ).rejects.toMatchObject({ status: 415 });
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('rejects PNG bytes declared as image/jpeg — the declared type must be truthful, not merely allowlisted', async () => {
      const { service, storage } = createService();

      await expect(
        service.upload(PATIENT_ID, uploadInput({ category: 'photo', buffer: PNG_BYTES, contentType: 'image/jpeg' })),
      ).rejects.toMatchObject({ status: 415 });
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('gives the SAME code for a sniff mismatch as for a disallowed declared type — no probing oracle', async () => {
      const { service } = createService();

      const disallowed = await service
        .upload(PATIENT_ID, uploadInput({ contentType: 'application/zip' }))
        .catch((e: unknown) => (e as { getResponse(): unknown }).getResponse());
      const mismatch = await service
        .upload(PATIENT_ID, uploadInput({ buffer: PNG_BYTES, contentType: 'application/pdf' }))
        .catch((e: unknown) => (e as { getResponse(): unknown }).getResponse());

      expect(disallowed).toMatchObject({ code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE });
      expect(mismatch).toMatchObject({ code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE });
      // Nothing about what the bytes actually were leaks to the caller.
      expect(JSON.stringify(mismatch)).not.toContain('png');
    });

    it('accepts a genuine JPEG for a photo and stores the VERIFIED content type', async () => {
      const { service, repo, storage } = createService();
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 64 });
      repo.create.mockResolvedValue(fileRow({ fileCategory: 'photo' }));

      await service.upload(PATIENT_ID, uploadInput({ category: 'photo', buffer: JPEG_BYTES, contentType: '  IMAGE/JPEG  ' }));

      expect(storage.store).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/jpeg' }));
    });

    it('accepts a real HEIC photo declared as image/heif — the two spellings are one container, and exact-match would falsely reject an iPhone upload', async () => {
      const { service, repo, storage } = createService();
      const heic = Buffer.alloc(64, 0x00);
      heic.writeUInt32BE(0x18, 0);
      heic.write('ftyp', 4, 'latin1');
      heic.write('heic', 8, 'latin1');
      storage.store.mockResolvedValue({ storageKey: 'key-1', sizeBytes: 64 });
      repo.create.mockResolvedValue(fileRow({ fileCategory: 'photo' }));

      await service.upload(PATIENT_ID, uploadInput({ category: 'photo', buffer: heic, contentType: 'image/heif' }));

      expect(storage.store).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/heif' }));
    });
  });

  describe('storage-port failure', () => {
    it('wraps ANY throw from the storage port into DOCUMENT_STORAGE_UNAVAILABLE — never the raw code/message', async () => {
      const { service, storage, repo } = createService();
      storage.store.mockRejectedValue(
        new ServiceUnavailableException({ code: 'STORAGE_PORT_UNAVAILABLE', message: 'No storage provider is configured.' }),
      );

      await expect(service.upload(PATIENT_ID, uploadInput())).rejects.toMatchObject({
        status: 503,
        response: { code: DOCUMENT_ERROR_CODES.STORAGE_UNAVAILABLE },
      });
      // No orphan patient_files row: the DB write is never attempted once store() has failed.
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('never inserts a DB row before the storage call succeeds — store() runs first, and only its result feeds the insert', async () => {
      const { service, storage, repo } = createService();
      const callOrder: string[] = [];
      storage.store.mockImplementation(async () => {
        callOrder.push('store');
        return { storageKey: 'confirmed-key', sizeBytes: 1024 };
      });
      repo.create.mockImplementation(async (data) => {
        callOrder.push('create');
        return fileRow({ storageKey: (data as { storageKey: string }).storageKey });
      });

      await service.upload(PATIENT_ID, uploadInput());

      expect(callOrder).toEqual(['store', 'create']);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ storageKey: 'confirmed-key' }));
    });
  });
});

describe('PatientFileService.listOwn', () => {
  it('lists own non-deleted files and strips storageKey', async () => {
    const { service, repo } = createService();
    repo.listByPatient.mockResolvedValue([fileRow()]);

    const result = await service.listOwn(PATIENT_ID);

    expect(repo.listByPatient).toHaveBeenCalledWith(PATIENT_ID, undefined);
    expect(result[0]).not.toHaveProperty('storageKey');
  });

  it('passes an explicit category filter through', async () => {
    const { service, repo } = createService();
    await service.listOwn(PATIENT_ID, 'report');
    expect(repo.listByPatient).toHaveBeenCalledWith(PATIENT_ID, 'report');
  });
});

describe('PatientFileService.getDownloadUrl', () => {
  it('allows the owning patient', async () => {
    const { service, repo, storage } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    storage.getSignedUrl.mockResolvedValue('https://signed.example/file');

    const result = await service.getDownloadUrl(auth('patient', PATIENT_ID), 'file-1');

    expect(result.url).toBe('https://signed.example/file');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects a different patient (404, never 403 — does not confirm the file exists)', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    await expect(service.getDownloadUrl(auth('patient', OTHER_PATIENT_ID), 'file-1')).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.FILE_NOT_FOUND },
    });
  });

  it('allows the treating doctor — any consultation with this patient, not just one specific consultation', async () => {
    const { service, repo, consultationLookup, storage } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    consultationLookup.listConsultationIdsBetween.mockResolvedValue([CONSULTATION_ID]);
    storage.getSignedUrl.mockResolvedValue('https://signed.example/file');

    const result = await service.getDownloadUrl(auth('doctor', DOCTOR_ID), 'file-1');

    expect(result.url).toBe('https://signed.example/file');
    expect(consultationLookup.listConsultationIdsBetween).toHaveBeenCalledWith(DOCTOR_ID, PATIENT_ID);
  });

  it('rejects a doctor with NO relationship to the patient (404, never 403)', async () => {
    const { service, repo, consultationLookup } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    consultationLookup.listConsultationIdsBetween.mockResolvedValue([]);

    await expect(service.getDownloadUrl(auth('doctor', OTHER_DOCTOR_ID), 'file-1')).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.FILE_NOT_FOUND },
    });
  });

  it('allows an admin unconditionally', async () => {
    const { service, repo, storage, consultationLookup } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    storage.getSignedUrl.mockResolvedValue('https://signed.example/file');

    await service.getDownloadUrl(auth('admin', 'admin-1'), 'file-1');

    expect(consultationLookup.listConsultationIdsBetween).not.toHaveBeenCalled();
  });

  it('404s a file id that does not exist', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(null);
    await expect(service.getDownloadUrl(auth('patient', PATIENT_ID), 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('404s a soft-deleted file', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, deletedAt: new Date() }));
    await expect(service.getDownloadUrl(auth('patient', PATIENT_ID), 'file-1')).rejects.toMatchObject({ status: 404 });
  });

  it('wraps a storage-port failure during download the same way as upload', async () => {
    const { service, repo, storage } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID }));
    storage.getSignedUrl.mockRejectedValue(new Error('boom'));

    await expect(service.getDownloadUrl(auth('patient', PATIENT_ID), 'file-1')).rejects.toMatchObject({
      status: 503,
      response: { code: DOCUMENT_ERROR_CODES.STORAGE_UNAVAILABLE },
    });
  });
});

describe('PatientFileService.deleteOwn', () => {
  it('allows deleting an own upload with no consultation', async () => {
    const { service, repo, audit } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, consultationId: null }));
    repo.softDelete.mockResolvedValue(fileRow({ patientId: PATIENT_ID, deletedAt: new Date() }));

    await service.deleteOwn(PATIENT_ID, 'file-1');

    expect(repo.softDelete).toHaveBeenCalledWith('file-1');
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', actorId: PATIENT_ID }));
  });

  it('blocks deleting a file attached to a COMPLETED consultation (409)', async () => {
    const { service, repo, consultationLookup } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, consultationId: CONSULTATION_ID }));
    consultationLookup.findById.mockResolvedValue(consultation({ status: 'completed' }));

    await expect(service.deleteOwn(PATIENT_ID, 'file-1')).rejects.toMatchObject({
      status: 409,
      response: { code: DOCUMENT_ERROR_CODES.DELETE_BLOCKED_COMPLETED },
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'in_progress', 'cancelled', 'no_show'] as const)(
    'allows deleting a file attached to a NON-completed consultation (%s)',
    async (status) => {
      const { service, repo, consultationLookup } = createService();
      repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, consultationId: CONSULTATION_ID }));
      consultationLookup.findById.mockResolvedValue(consultation({ status }));
      repo.softDelete.mockResolvedValue(fileRow({ deletedAt: new Date() }));

      await service.deleteOwn(PATIENT_ID, 'file-1');

      expect(repo.softDelete).toHaveBeenCalled();
    },
  );

  it('rejects deleting someone else\'s upload (404, not 403)', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: OTHER_PATIENT_ID }));

    await expect(service.deleteOwn(PATIENT_ID, 'file-1')).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.FILE_NOT_FOUND },
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('rejects deleting a DOCTOR-UPLOADED file even though patientId matches — not the patient\'s own upload', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, uploadedByDoctorId: DOCTOR_ID }));

    await expect(service.deleteOwn(PATIENT_ID, 'file-1')).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.FILE_NOT_FOUND },
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('rejects deleting an already-deleted file', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ patientId: PATIENT_ID, deletedAt: new Date() }));
    await expect(service.deleteOwn(PATIENT_ID, 'file-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('PatientFileService.listForDoctorHistory', () => {
  it('404s the whole request for a doctor with ZERO consultations with the patient — never an empty list', async () => {
    const { service, consultationLookup, repo } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));
    consultationLookup.listConsultationIdsBetween.mockResolvedValue([]);

    await expect(service.listForDoctorHistory(DOCTOR_ID, CONSULTATION_ID)).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.CONSULTATION_NOT_FOUND },
    });
    expect(repo.listForDoctorHistory).not.toHaveBeenCalled();
  });

  it('404s when the target consultation does not exist at all', async () => {
    const { service, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(null);
    await expect(service.listForDoctorHistory(DOCTOR_ID, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('resolves every related consultation id (this one plus any earlier one with the same doctor+patient) and asks the repo for the union', async () => {
    const { service, consultationLookup, repo } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ id: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID }));
    consultationLookup.listConsultationIdsBetween.mockResolvedValue([CONSULTATION_ID, 'earlier-consultation']);
    repo.listForDoctorHistory.mockResolvedValue([
      fileRow({ id: 'medical-history-file', fileCategory: 'medical_history', consultationId: null }),
      fileRow({ id: 'earlier-consult-file', consultationId: 'earlier-consultation' }),
    ]);

    const result = await service.listForDoctorHistory(DOCTOR_ID, CONSULTATION_ID);

    expect(consultationLookup.listConsultationIdsBetween).toHaveBeenCalledWith(DOCTOR_ID, PATIENT_ID);
    expect(repo.listForDoctorHistory).toHaveBeenCalledWith(PATIENT_ID, [CONSULTATION_ID, 'earlier-consultation']);
    expect(result).toHaveLength(2);
    expect(result.every((row) => !('storageKey' in row))).toBe(true);
  });
});

describe('PatientFileService.getPatientFileById', () => {
  it('returns a safe view for an existing, non-deleted file', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow());
    const result = await service.getPatientFileById('file-1');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('storageKey');
  });

  it('returns null for a soft-deleted file', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(fileRow({ deletedAt: new Date() }));
    expect(await service.getPatientFileById('file-1')).toBeNull();
  });

  it('returns null for a missing file', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(null);
    expect(await service.getPatientFileById('missing')).toBeNull();
  });
});
