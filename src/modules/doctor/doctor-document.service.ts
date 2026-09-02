import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type { CreateDoctorDocumentDto } from './doctor.dto';
import type { ReviewDoctorDocumentDto } from './doctor-admin.dto';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DOCTOR_AUDIT_ENTITY_TYPES, DOCTOR_ERROR_CODES } from './doctor.constants';
import { toSafeDoctorDocumentRow, type SafeDoctorDocumentRow } from './doctor.mapper';
import { doctorNotFound } from './doctor.service';
import { DoctorRepository } from './doctor.repository';

/**
 * `doctor_documents` workflow: doctor uploads (metadata only — this module
 * owns the review row, not the upload mechanism, since M-10 doesn't exist
 * yet), admin lists and reviews.
 */
@Injectable()
export class DoctorDocumentService {
  constructor(
    private readonly doctorRepo: DoctorRepository,
    private readonly repo: DoctorDocumentRepository,
    private readonly audit: AuditService,
  ) {}

  async listForDoctor(doctorId: string): Promise<SafeDoctorDocumentRow[]> {
    const rows = await this.repo.listByDoctor(doctorId);
    return rows.map(toSafeDoctorDocumentRow);
  }

  /** `storageKey`/`fileName` are the object-store key and display name the caller already has from elsewhere — no upload happens here. Always created `reviewStatus: 'pending'`. */
  async createForDoctor(doctorId: string, dto: CreateDoctorDocumentDto): Promise<SafeDoctorDocumentRow> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const row = await this.repo.create({
      doctorId,
      documentType: dto.documentType,
      storageKey: dto.storageKey,
      fileName: dto.fileName,
    });
    return toSafeDoctorDocumentRow(row);
  }

  async listForAdmin(doctorId: string): Promise<SafeDoctorDocumentRow[]> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();
    const rows = await this.repo.listByDoctor(doctorId);
    return rows.map(toSafeDoctorDocumentRow);
  }

  /** Rejecting without a `rejectionReason` is refused — a rejection with no reason is useless to the doctor. */
  async review(
    actingAdminId: string,
    doctorId: string,
    documentId: string,
    dto: ReviewDoctorDocumentDto,
  ): Promise<SafeDoctorDocumentRow> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const document = await this.repo.findByIdForDoctor(documentId, doctorId);
    if (!document) {
      throw new NotFoundException({ code: DOCTOR_ERROR_CODES.DOCUMENT_NOT_FOUND, message: 'Document not found.' });
    }

    if (dto.reviewStatus === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException({
        code: DOCTOR_ERROR_CODES.REJECTION_REASON_REQUIRED,
        message: 'A rejection reason is required when rejecting a document.',
      });
    }

    const updated = await this.repo.review(documentId, {
      reviewStatus: dto.reviewStatus,
      verifiedByAdminId: actingAdminId,
      verifiedAt: new Date(),
      rejectionReason: dto.reviewStatus === 'rejected' ? (dto.rejectionReason ?? null) : null,
    });
    if (!updated) {
      throw new NotFoundException({ code: DOCTOR_ERROR_CODES.DOCUMENT_NOT_FOUND, message: 'Document not found.' });
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'verify',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_DOCUMENT,
      entityId: documentId,
      metadata: { doctorId, documentType: document.documentType, reviewStatus: dto.reviewStatus, rejectionReason: dto.rejectionReason },
    });
    return toSafeDoctorDocumentRow(updated);
  }
}
