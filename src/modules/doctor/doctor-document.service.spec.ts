import { BadRequestException, NotFoundException, ServiceUnavailableException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { StorageFacade } from '../storage/storage.facade';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorDocumentService, type UploadDoctorDocumentInput } from './doctor-document.service';
import { DoctorRepository } from './doctor.repository';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * REAL magic bytes, not placeholder text. The upload path now sniffs the
 * buffer (`verifyDeclaredContentType`), so a fixture whose bytes don't match
 * its declared `contentType` is rejected — which is exactly the behaviour
 * being tested further down, and would otherwise make every happy-path test
 * fail for the wrong reason.
 */
function fileStartingWith(signature: number[], totalLength = 64): Buffer {
  const buffer = Buffer.alloc(totalLength, 0x00);
  Buffer.from(signature).copy(buffer, 0);
  return buffer;
}

const PDF_BYTES = fileStartingWith([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG_BYTES = fileStartingWith([0xff, 0xd8, 0xff, 0xe0]);
const PNG_BYTES = fileStartingWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function baseDocument(overrides: Partial<DoctorDocumentRow> = {}): DoctorDocumentRow {
  return {
    id: 'doc-1',
    doctorId: 'doctor-1',
    documentType: 'registration_certificate',
    storageKey: 's3:doctor-documents/3f2c-e1.pdf',
    fileName: 'registration.pdf',
    reviewStatus: 'pending',
    verifiedByAdminId: null,
    verifiedAt: null,
    rejectionReason: null,
    createdAt: NOW,
    ...overrides,
  } as DoctorDocumentRow;
}

function uploadInput(overrides: Partial<UploadDoctorDocumentInput> = {}): UploadDoctorDocumentInput {
  return {
    documentType: 'registration_certificate',
    buffer: PDF_BYTES,
    fileName: 'registration.pdf',
    contentType: 'application/pdf',
    sizeBytes: PDF_BYTES.length,
    ...overrides,
  };
}

function createDeps() {
  const doctorRepo = { findById: jest.fn().mockResolvedValue({ id: 'doctor-1' } as DoctorRow) } as unknown as jest.Mocked<DoctorRepository>;
  const repo = {
    listByDoctor: jest.fn(),
    create: jest.fn(),
    findByIdForDoctor: jest.fn(),
    review: jest.fn(),
  } as unknown as jest.Mocked<DoctorDocumentRepository>;
  const storage = {
    store: jest.fn().mockResolvedValue({ storageKey: 's3:doctor-documents/3f2c-e1.pdf', sizeBytes: 64 }),
    getSignedUrl: jest.fn(),
    delete: jest.fn(),
    isAvailable: jest.fn(),
  } as unknown as jest.Mocked<StorageFacade>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new DoctorDocumentService(doctorRepo, repo, storage, audit);
  return { service, doctorRepo, repo, storage, audit };
}

describe('DoctorDocumentService', () => {
  describe('createForDoctor — the real upload path (M-05 trust-hole retrofit)', () => {
    it('stores the file through StorageFacade and writes the row with the STORAGE-returned key', async () => {
      const { service, repo, storage } = createDeps();
      storage.store.mockResolvedValue({ storageKey: 's3:doctor-documents/real-key.pdf', sizeBytes: 64 });
      repo.create.mockResolvedValue(baseDocument({ storageKey: 's3:doctor-documents/real-key.pdf' }));

      await service.createForDoctor('doctor-1', uploadInput());

      expect(storage.store).toHaveBeenCalledWith({
        buffer: PDF_BYTES,
        fileName: 'registration.pdf',
        contentType: 'application/pdf',
        category: 'doctor-documents',
      });
      // The key is the server's, from storage — never anything a caller supplied.
      expect(repo.create).toHaveBeenCalledWith({
        doctorId: 'doctor-1',
        documentType: 'registration_certificate',
        storageKey: 's3:doctor-documents/real-key.pdf',
        fileName: 'registration.pdf',
      });
    });

    it('strips storageKey from its response', async () => {
      const { service, repo } = createDeps();
      repo.create.mockResolvedValue(baseDocument());

      const result = await service.createForDoctor('doctor-1', uploadInput());

      expect(result).not.toHaveProperty('storageKey');
    });

    it('creates every document as reviewStatus: pending', async () => {
      const { service, repo } = createDeps();
      repo.create.mockResolvedValue(baseDocument());

      const result = await service.createForDoctor('doctor-1', uploadInput());

      expect(result.reviewStatus).toBe('pending');
      // The service never sets it explicitly — it relies on the column default,
      // so it can never be spoofed by a caller-supplied field.
      expect(repo.create).toHaveBeenCalledWith(expect.not.objectContaining({ reviewStatus: expect.anything() }));
    });

    it('writes an audit row naming the doctor as actor', async () => {
      const { service, repo, audit } = createDeps();
      repo.create.mockResolvedValue(baseDocument({ id: 'doc-42' }));

      await service.createForDoctor('doctor-1', uploadInput());

      expect(audit.write).toHaveBeenCalledWith({
        actorType: 'doctor',
        actorId: 'doctor-1',
        action: 'create',
        entityType: 'doctor_document',
        entityId: 'doc-42',
        metadata: { documentType: 'registration_certificate' },
      });
    });

    it('404s when the doctor does not exist — before any storage call is made', async () => {
      const { service, doctorRepo, repo, storage } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(service.createForDoctor('missing', uploadInput())).rejects.toBeInstanceOf(NotFoundException);

      expect(storage.store).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    describe('ordering: storage write strictly before DB write', () => {
      it('calls storage.store() BEFORE repo.create(), and builds the insert from the confirmed result', async () => {
        const { service, repo, storage } = createDeps();
        const callOrder: string[] = [];
        storage.store.mockImplementation(async () => {
          callOrder.push('store');
          return { storageKey: 'cloudinary:doctor-documents/confirmed', sizeBytes: 64 };
        });
        repo.create.mockImplementation(async (data) => {
          callOrder.push('create');
          return baseDocument({ storageKey: (data as { storageKey: string }).storageKey });
        });

        await service.createForDoctor('doctor-1', uploadInput());

        expect(callOrder).toEqual(['store', 'create']);
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ storageKey: 'cloudinary:doctor-documents/confirmed' }));
      });

      it('leaves NO orphan doctor_documents row when storage fails', async () => {
        const { service, repo, storage } = createDeps();
        storage.store.mockRejectedValue(new Error('every provider failed'));

        await expect(service.createForDoctor('doctor-1', uploadInput())).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(repo.create).not.toHaveBeenCalled();
      });
    });

    describe('storage failures are wrapped in this module\'s own code', () => {
      it('wraps a raw STORAGE_UNAVAILABLE into DOCTOR_DOCUMENT_UPLOAD_FAILED (503) — the storage code never leaks', async () => {
        const { service, storage } = createDeps();
        storage.store.mockRejectedValue(
          new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE', message: 'File storage is temporarily unavailable.' }),
        );

        const error = await service.createForDoctor('doctor-1', uploadInput()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as ServiceUnavailableException).getResponse()).toEqual({
          code: 'DOCTOR_DOCUMENT_UPLOAD_FAILED',
          message: expect.any(String),
        });
      });

      it('wraps ANY throw shape, not just an HttpException', async () => {
        const { service, storage } = createDeps();
        storage.store.mockRejectedValue(new Error('socket hang up'));

        await expect(service.createForDoctor('doctor-1', uploadInput())).rejects.toMatchObject({
          status: 503,
          response: { code: 'DOCTOR_DOCUMENT_UPLOAD_FAILED' },
        });
      });
    });

    describe('documentType validation', () => {
      it.each(['', 'not_a_real_type', 'prescription_pdf'])('rejects %p with 400, before any storage call', async (documentType) => {
        const { service, storage, repo } = createDeps();

        const error = await service.createForDoctor('doctor-1', uploadInput({ documentType })).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'DOCTOR_INVALID_DOCUMENT_TYPE' });
        expect(storage.store).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
      });
    });

    describe('MIME allowlist — per document type', () => {
      it.each([
        ['degree_certificate', 'application/pdf', PDF_BYTES],
        ['registration_certificate', 'application/pdf', PDF_BYTES],
        ['identity_proof', 'image/jpeg', JPEG_BYTES],
        ['address_proof', 'image/png', PNG_BYTES],
        ['experience_letter', 'application/pdf', PDF_BYTES],
        ['profile_photo', 'image/jpeg', JPEG_BYTES],
        ['signature', 'image/png', PNG_BYTES],
        ['other', 'application/pdf', PDF_BYTES],
      ])('accepts %s with %s', async (documentType, contentType, buffer) => {
        const { service, repo, storage } = createDeps();
        repo.create.mockResolvedValue(baseDocument());

        await service.createForDoctor(
          'doctor-1',
          uploadInput({ documentType, contentType, buffer: buffer as Buffer, sizeBytes: (buffer as Buffer).length }),
        );

        expect(storage.store).toHaveBeenCalled();
      });

      it.each(['profile_photo', 'signature'])('rejects a PDF for %s (image-only) with 415, before any storage call', async (documentType) => {
        const { service, storage, repo } = createDeps();

        const error = await service
          .createForDoctor('doctor-1', uploadInput({ documentType, contentType: 'application/pdf', buffer: PDF_BYTES }))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
        expect((error as UnsupportedMediaTypeException).getResponse()).toMatchObject({ code: 'DOCTOR_INVALID_FILE_TYPE' });
        expect(storage.store).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('rejects a type on no allowlist at all (e.g. a zip) with 415', async () => {
        const { service, storage } = createDeps();

        await expect(
          service.createForDoctor('doctor-1', uploadInput({ contentType: 'application/zip' })),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.store).not.toHaveBeenCalled();
      });
    });

    describe('content sniffing — a lying Content-Type cannot get bytes stored', () => {
      it('rejects a ZIP payload declared as application/pdf, with no storage call', async () => {
        const { service, storage, repo } = createDeps();
        const zipBytes = fileStartingWith([0x50, 0x4b, 0x03, 0x04]);

        const error = await service
          .createForDoctor('doctor-1', uploadInput({ buffer: zipBytes, contentType: 'application/pdf' }))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.store).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('rejects an ELF executable declared as image/jpeg for a profile_photo', async () => {
        const { service, storage } = createDeps();
        const elfBytes = fileStartingWith([0x7f, 0x45, 0x4c, 0x46]);

        await expect(
          service.createForDoctor('doctor-1', uploadInput({ documentType: 'profile_photo', buffer: elfBytes, contentType: 'image/jpeg' })),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.store).not.toHaveBeenCalled();
      });

      it('rejects PNG bytes declared as image/jpeg — the declared type must be truthful, not merely allowlisted', async () => {
        const { service, storage } = createDeps();

        await expect(
          service.createForDoctor('doctor-1', uploadInput({ documentType: 'profile_photo', buffer: PNG_BYTES, contentType: 'image/jpeg' })),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(storage.store).not.toHaveBeenCalled();
      });

      it('gives the SAME error code and message for a sniff mismatch as for a disallowed declared type — no probing oracle', async () => {
        const { service } = createDeps();

        const disallowed = await service
          .createForDoctor('doctor-1', uploadInput({ documentType: 'profile_photo', contentType: 'application/pdf', buffer: PDF_BYTES }))
          .catch((e: unknown) => (e as UnsupportedMediaTypeException).getResponse());
        const mismatch = await service
          .createForDoctor('doctor-1', uploadInput({ documentType: 'profile_photo', contentType: 'image/jpeg', buffer: PDF_BYTES }))
          .catch((e: unknown) => (e as UnsupportedMediaTypeException).getResponse());

        // Same shape, same code. The messages differ only by the declared type
        // the CALLER already knows it sent — nothing about what was sniffed.
        expect(disallowed).toMatchObject({ code: 'DOCTOR_INVALID_FILE_TYPE' });
        expect(mismatch).toMatchObject({ code: 'DOCTOR_INVALID_FILE_TYPE' });
        expect(JSON.stringify(mismatch)).not.toContain('pdf');
      });

      it('passes the VERIFIED content type to storage, not the raw declared header', async () => {
        const { service, repo, storage } = createDeps();
        repo.create.mockResolvedValue(baseDocument());

        await service.createForDoctor(
          'doctor-1',
          uploadInput({ documentType: 'profile_photo', contentType: '  IMAGE/JPEG  ', buffer: JPEG_BYTES }),
        );

        expect(storage.store).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/jpeg' }));
      });
    });
  });

  describe('listForDoctor — never expose storageKey', () => {
    it('strips storageKey from every row', async () => {
      const { service, repo } = createDeps();
      repo.listByDoctor.mockResolvedValue([baseDocument()]);

      const [result] = await service.listForDoctor('doctor-1');

      expect(result).not.toHaveProperty('storageKey');
    });
  });

  describe('listForAdmin', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(service.listForAdmin('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.listByDoctor).not.toHaveBeenCalled();
    });

    it('strips storageKey from every listed row', async () => {
      const { service, repo } = createDeps();
      repo.listByDoctor.mockResolvedValue([baseDocument()]);

      const [result] = await service.listForAdmin('doctor-1');

      expect(result).not.toHaveProperty('storageKey');
    });
  });

  describe('review', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(service.review('admin-1', 'missing', 'doc-1', { reviewStatus: 'approved' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.findByIdForDoctor).not.toHaveBeenCalled();
    });

    it('rejects a rejection with no rejectionReason', async () => {
      const { service, doctorRepo, repo } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(baseDocument());

      await expect(
        service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'rejected' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.review).not.toHaveBeenCalled();
      expect(doctorRepo.findById).toHaveBeenCalled();
    });

    it('404s when repo.review returns null (document removed between lookup and write)', async () => {
      const { service, repo } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(baseDocument());
      repo.review.mockResolvedValue(null);

      await expect(
        service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'approved' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audits the review with the actor, document type, and review status', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(baseDocument({ documentType: 'registration_certificate' }));
      repo.review.mockResolvedValue(baseDocument({ reviewStatus: 'approved' }));

      await service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'approved' });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'verify',
          entityType: 'doctor_document',
          entityId: 'doc-1',
          metadata: expect.objectContaining({ doctorId: 'doctor-1', documentType: 'registration_certificate', reviewStatus: 'approved' }),
        }),
      );
    });

    it('accepts a rejection with a rejectionReason and sets it on the row', async () => {
      const { service, repo } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(baseDocument());
      repo.review.mockResolvedValue(baseDocument({ reviewStatus: 'rejected', rejectionReason: 'Illegible scan' }));

      await service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'rejected', rejectionReason: 'Illegible scan' });

      expect(repo.review).toHaveBeenCalledWith(
        'doc-1',
        expect.objectContaining({ reviewStatus: 'rejected', rejectionReason: 'Illegible scan', verifiedByAdminId: 'admin-1' }),
      );
    });

    it('sets rejectionReason to null on approval', async () => {
      const { service, repo } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(baseDocument());
      repo.review.mockResolvedValue(baseDocument({ reviewStatus: 'approved' }));

      await service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'approved' });

      expect(repo.review).toHaveBeenCalledWith('doc-1', expect.objectContaining({ reviewStatus: 'approved', rejectionReason: null }));
    });

    it('404s when the document does not belong to this doctor', async () => {
      const { service, repo } = createDeps();
      repo.findByIdForDoctor.mockResolvedValue(null);

      await expect(
        service.review('admin-1', 'doctor-1', 'doc-1', { reviewStatus: 'approved' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
