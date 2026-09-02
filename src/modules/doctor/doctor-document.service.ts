import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { DOCTOR_DOCUMENT_TYPES, type DoctorDocumentType } from '../../schema/enums.schema';
import { StorageFacade } from '../storage/storage.facade';
import type { StoredFileResult } from '../storage/storage.contract';
import { verifyDeclaredContentType } from '../storage/file-content-type.util';
import type { ReviewDoctorDocumentDto } from './doctor-admin.dto';
import { DoctorDocumentRepository } from './doctor-document.repository';
import {
  DOCTOR_AUDIT_ENTITY_TYPES,
  DOCTOR_DOCUMENT_MIME_ALLOWLIST,
  DOCTOR_DOCUMENT_STORAGE_CATEGORY,
  DOCTOR_ERROR_CODES,
} from './doctor.constants';
import { toSafeDoctorDocumentRow, type SafeDoctorDocumentRow } from './doctor.mapper';
import { doctorNotFound } from './doctor.service';
import { DoctorRepository } from './doctor.repository';

/** What the controller hands the service after `multipart-file.util.ts` has already read the file off the wire — `documentType` is still a raw, unvalidated string at this point (a multipart form field, never touched by Nest's `ValidationPipe`). */
export interface UploadDoctorDocumentInput {
  documentType: string;
  buffer: Buffer;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * `doctor_documents` workflow: doctor uploads a real file (validated,
 * stored through `StorageFacade` — `modules/storage`'s S3-primary/
 * Cloudinary-secondary gateway — the SAME way `modules/document` consumes
 * it), admin lists and reviews.
 */
@Injectable()
export class DoctorDocumentService {
  private readonly logger = new Logger(DoctorDocumentService.name);

  constructor(
    private readonly doctorRepo: DoctorRepository,
    private readonly repo: DoctorDocumentRepository,
    private readonly storage: StorageFacade,
    private readonly audit: AuditService,
  ) {}

  async listForDoctor(doctorId: string): Promise<SafeDoctorDocumentRow[]> {
    const rows = await this.repo.listByDoctor(doctorId);
    return rows.map(toSafeDoctorDocumentRow);
  }

  /**
   * Real upload. Ordering is deliberate and load-bearing, mirroring
   * `patient-file.service.ts#upload` precisely: cheap validation
   * (documentType, then its MIME allowlist) runs first; `storage.store()`
   * runs ONLY after that passes; the `doctor_documents` insert is built ONLY
   * from a confirmed `StoredFileResult`, never the reverse. A DB row is
   * therefore never created pointing at a `storageKey` that was never
   * actually stored. Always created `reviewStatus: 'pending'` (the
   * column's own default).
   */
  async createForDoctor(doctorId: string, input: UploadDoctorDocumentInput): Promise<SafeDoctorDocumentRow> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const documentType = this.validateDocumentType(input.documentType);
    const verifiedContentType = this.resolveVerifiedContentType(documentType, input.contentType, input.buffer);

    let stored: StoredFileResult;
    try {
      stored = await this.storage.store({
        buffer: input.buffer,
        fileName: input.fileName,
        contentType: verifiedContentType,
        category: DOCTOR_DOCUMENT_STORAGE_CATEGORY,
      });
    } catch (error) {
      throw this.wrapStorageError(error);
    }

    const row = await this.repo.create({
      doctorId,
      documentType,
      storageKey: stored.storageKey,
      fileName: input.fileName,
    });

    await this.audit.write({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'create',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_DOCUMENT,
      entityId: row.id,
      metadata: { documentType },
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

  /* ---------------------------------------------------------------------- */
  /* Validation                                                               */
  /* ---------------------------------------------------------------------- */

  private validateDocumentType(raw: string): DoctorDocumentType {
    if (!(DOCTOR_DOCUMENT_TYPES as readonly string[]).includes(raw)) {
      throw new BadRequestException({
        code: DOCTOR_ERROR_CODES.INVALID_DOCUMENT_TYPE,
        message: `documentType must be one of ${DOCTOR_DOCUMENT_TYPES.join(', ')}.`,
      });
    }
    return raw as DoctorDocumentType;
  }

  /**
   * TWO checks, ONE indistinguishable failure — the exact counterpart of
   * `patient-file.service.ts#resolveVerifiedContentType` (see that method for
   * the full reasoning; both upload paths in this codebase enforce the same
   * rule the same way):
   *
   *   1. The DECLARED type is on this `documentType`'s allowlist — so a PDF
   *      cannot be filed as a `profile_photo`.
   *   2. The file's ACTUAL BYTES are that type, via `verifyDeclaredContentType`
   *      (`modules/storage`) — because a declared `Content-Type` is only a
   *      header the client wrote, and this endpoint accepts credential
   *      documents an admin will later open during verification.
   *
   * Both failures raise the identical exception (built once, below), so a
   * mismatch is externally indistinguishable from a disallowed type and this
   * endpoint cannot be probed as a content-detection oracle.
   */
  private resolveVerifiedContentType(documentType: DoctorDocumentType, contentType: string, buffer: Buffer): string {
    const rejected = (): UnsupportedMediaTypeException =>
      new UnsupportedMediaTypeException({
        code: DOCTOR_ERROR_CODES.INVALID_FILE_TYPE,
        message: `File type '${contentType}' is not accepted for document type '${documentType}'.`,
      });

    // Normalised ONCE and reused for both checks. HTTP header values carry
    // optional surrounding whitespace (RFC 7231), so trimming is the correct
    // reading of a declared type — and normalising in one place is what keeps
    // the allowlist check and the sniff check from disagreeing about what the
    // caller actually declared. The error message below deliberately echoes
    // the RAW value, which is what the caller sent and will recognise.
    const declared = contentType.trim().toLowerCase();

    const allowed = DOCTOR_DOCUMENT_MIME_ALLOWLIST[documentType];
    if (!allowed.includes(declared)) {
      throw rejected();
    }

    const verified = verifyDeclaredContentType(buffer, declared);
    if (verified === null) {
      throw rejected();
    }

    return verified;
  }

  /**
   * Every throw from `StorageFacade` is wrapped here — the raw
   * `STORAGE_UNAVAILABLE` (or any other provider-side code/message) never
   * reaches a client. Mirrors `patient-file.service.ts#wrapStorageError`
   * precisely: same log level (`warn`, not `error` — a storage outage is an
   * operational fact this module already degrades cleanly from, not a bug
   * here), same 503, same "never the raw code" discipline.
   */
  private wrapStorageError(error: unknown): ServiceUnavailableException {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Doctor document storage upload failed: ${detail}`);
    return new ServiceUnavailableException({
      code: DOCTOR_ERROR_CODES.DOCUMENT_UPLOAD_FAILED,
      message: 'Could not upload your document right now. Please try again shortly.',
    });
  }
}
