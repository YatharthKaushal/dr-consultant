import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorDocumentService } from './doctor-document.service';
import { DoctorRepository } from './doctor.repository';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function baseDocument(overrides: Partial<DoctorDocumentRow> = {}): DoctorDocumentRow {
  return {
    id: 'doc-1',
    doctorId: 'doctor-1',
    documentType: 'registration_certificate',
    storageKey: 'secret/object-store/key.pdf',
    fileName: 'registration.pdf',
    reviewStatus: 'pending',
    verifiedByAdminId: null,
    verifiedAt: null,
    rejectionReason: null,
    createdAt: NOW,
    ...overrides,
  } as DoctorDocumentRow;
}

function createDeps() {
  const doctorRepo = { findById: jest.fn().mockResolvedValue({ id: 'doctor-1' } as DoctorRow) } as unknown as jest.Mocked<DoctorRepository>;
  const repo = {
    listByDoctor: jest.fn(),
    create: jest.fn(),
    findByIdForDoctor: jest.fn(),
    review: jest.fn(),
  } as unknown as jest.Mocked<DoctorDocumentRepository>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new DoctorDocumentService(doctorRepo, repo, audit);
  return { service, doctorRepo, repo, audit };
}

describe('DoctorDocumentService', () => {
  describe('createForDoctor / listForDoctor — never expose storageKey', () => {
    it('createForDoctor strips storageKey from its response', async () => {
      const { service, repo } = createDeps();
      repo.create.mockResolvedValue(baseDocument());

      const result = await service.createForDoctor('doctor-1', {
        documentType: 'registration_certificate',
        storageKey: 'secret/key.pdf',
        fileName: 'x.pdf',
      });

      expect(result).not.toHaveProperty('storageKey');
    });

    it('createForDoctor 404s when the doctor does not exist', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(
        service.createForDoctor('missing', { documentType: 'registration_certificate', storageKey: 'k', fileName: 'x.pdf' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('listForDoctor strips storageKey from every row', async () => {
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
