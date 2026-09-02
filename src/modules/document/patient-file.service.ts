import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { NewPatientFileRow, PatientFileRow } from '../../schema/patient-files.schema';
import type { PatientFileCategory } from '../../schema/enums.schema';
import type { ReportRequestRow } from '../../schema/report-requests.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import {
  CONSULTATION_LOOKUP_PROVIDER,
  DOCUMENT_AUDIT_ENTITY_TYPES,
  DOCUMENT_CONFIG_FALLBACKS,
  DOCUMENT_CONFIG_KEYS,
  DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
  DOCUMENT_ERROR_CODES,
  DOCUMENT_MIME_ALLOWLIST,
  DOCUMENT_STORAGE_PORT,
  PATIENT_UPLOADABLE_CATEGORIES,
  type PatientUploadableCategory,
} from './document.constants';
import type { ConsultationLookupPort } from './consultation-lookup.provider';
import type { DocumentStoragePort, StoredFileResult } from './document-storage.contract';
// A pure, stateless util — imported directly rather than through a facade or
// DI token, exactly as `modules/doctor` imports this module's own
// `parseSingleFileRequest`. `backend/README.md` §2's "a module's only public
// surface is its facade" governs a module's SERVICES and DATA, not a
// dependency-free function; see that util's own header comment for why
// content sniffing lives in `modules/storage`.
import { verifyDeclaredContentType } from '../storage/file-content-type.util';
import { toSafePatientFileRow, type SafePatientFileRow } from './document.mapper';
import { PatientFileRepository } from './patient-file.repository';
import { ReportRequestRepository } from './report-request.repository';
import { consultationNotFound, reportRequestNotFound, reportRequestNotOpen } from './report-request.service';
import { AppConfigService } from '../../shared/app-config/app-config.service';

/** What the controller hands the service after `multipart-file.util.ts` has already read the file off the wire — `category`/`consultationId`/`reportRequestId` are still raw, unvalidated strings at this point. */
export interface UploadFileInput {
  category: string;
  consultationId?: string;
  reportRequestId?: string;
  buffer: Buffer;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * `patient_files` workflow: upload (with the size/type/category rules,
 * consultation and report-request ownership checks, and the implicit-fulfil
 * transaction), listing, access-controlled download, soft delete, and the
 * doctor-facing cross-consultation history read.
 */
@Injectable()
export class PatientFileService {
  private readonly logger = new Logger(PatientFileService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: PatientFileRepository,
    private readonly reportRequestRepo: ReportRequestRepository,
    @Inject(CONSULTATION_LOOKUP_PROVIDER) private readonly consultationLookup: ConsultationLookupPort,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rules 1-3 of the module brief, in one place:
   *  - `medical_history` needs no `consultationId` (rule 1) — and, per rule
   *    6's own wording ("regardless of which consultation... it's attached
   *    to"), a `consultationId` on a `medical_history` upload is ALLOWED,
   *    just never required.
   *  - `prescription_pdf`/`clarification_attachment` are rejected outright
   *    (rule 2), by name, before any other validation runs.
   *  - A `reportRequestId` on a currently-`open` request fulfils it,
   *    atomically, in the SAME transaction as the file insert (rule 3).
   *
   * Ordering is deliberate and load-bearing: `storage.store()` is called
   * ONLY after every validation/ownership check has passed, and the DB
   * insert is built ONLY from a confirmed `StoredFileResult` — never the
   * reverse. A DB row is therefore never created pointing at a `storageKey`
   * that was never actually stored.
   *
   * The content type handed to storage is the VERIFIED one — the file's
   * actual sniffed type — never the client's declared header. See
   * `resolveVerifiedContentType`.
   */
  async upload(patientId: string, input: UploadFileInput): Promise<SafePatientFileRow> {
    const category = this.validateCategory(input.category);
    const verifiedContentType = this.resolveVerifiedContentType(category, input.contentType, input.buffer);
    await this.validateSize(input.sizeBytes);

    const consultationId = await this.resolveConsultationId(patientId, input.consultationId);
    const reportRequest = await this.resolveReportRequest(patientId, input.reportRequestId, consultationId);
    const finalConsultationId = reportRequest ? reportRequest.consultationId : consultationId;

    let stored: StoredFileResult;
    try {
      stored = await this.storage.store({
        buffer: input.buffer,
        fileName: input.fileName,
        contentType: verifiedContentType,
        category,
      });
    } catch (error) {
      throw this.wrapStorageError(error, 'upload');
    }

    const newRow: NewPatientFileRow = {
      fileCategory: category,
      patientId,
      consultationId: finalConsultationId,
      reportRequestId: reportRequest?.id ?? null,
      storageKey: stored.storageKey,
      fileName: input.fileName,
    };

    if (reportRequest) {
      const created = await this.db.transaction(async (tx) => {
        const row = await this.repo.create(newRow, tx);

        const fulfilled = await this.reportRequestRepo.updateStatusIfOpen(reportRequest.id, 'fulfilled', tx);
        if (!fulfilled) {
          // Raced with a doctor's cancel (or another upload) between the
          // pre-flight check in `resolveReportRequest` and this write —
          // throwing here rolls back the file insert too.
          throw reportRequestNotOpen();
        }

        await this.audit.write(
          {
            actorType: 'patient',
            actorId: patientId,
            action: 'create',
            entityType: DOCUMENT_AUDIT_ENTITY_TYPES.PATIENT_FILE,
            entityId: row.id,
            consultationId: finalConsultationId ?? undefined,
            metadata: { fileCategory: category, reportRequestId: reportRequest.id },
          },
          tx,
        );

        return row;
      });

      return toSafePatientFileRow(created);
    }

    const created = await this.repo.create(newRow);
    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: DOCUMENT_AUDIT_ENTITY_TYPES.PATIENT_FILE,
      entityId: created.id,
      consultationId: finalConsultationId ?? undefined,
      metadata: { fileCategory: category },
    });

    return toSafePatientFileRow(created);
  }

  async listOwn(patientId: string, category?: PatientFileCategory): Promise<SafePatientFileRow[]> {
    const rows = await this.repo.listByPatient(patientId, category);
    return rows.map(toSafePatientFileRow);
  }

  /** Ownership check: the patient who owns the file, the treating doctor (any consultation with this patient — rule 6's relationship test), or an admin. Returns a freshly-minted signed URL, never the raw `storageKey`. */
  async getDownloadUrl(auth: AuthContext, fileId: string): Promise<{ url: string; expiresAt: Date }> {
    const file = await this.repo.findById(fileId);
    if (!file || file.deletedAt) {
      throw fileNotFound();
    }

    const allowed = await this.canAccessForDownload(auth, file);
    if (!allowed) {
      throw fileNotFound();
    }

    let url: string;
    try {
      url = await this.storage.getSignedUrl(file.storageKey, DOCUMENT_DOWNLOAD_URL_TTL_SECONDS);
    } catch (error) {
      throw this.wrapStorageError(error, 'download');
    }

    return { url, expiresAt: new Date(Date.now() + DOCUMENT_DOWNLOAD_URL_TTL_SECONDS * 1000) };
  }

  /**
   * Rule 7: soft delete only, own uploads only. `uploadedByDoctorId` MUST be
   * null — a file a doctor uploaded on the patient's behalf is attached to
   * their record but is explicitly NOT "the patient's own upload" per the
   * module brief, so it cannot be deleted here even though `patientId`
   * matches. Refused with 409 if `consultationId` resolves to a `completed`
   * consultation; a file with no `consultationId` (e.g. medical history) is
   * always deletable by its owner.
   */
  async deleteOwn(patientId: string, fileId: string): Promise<void> {
    const file = await this.repo.findById(fileId);
    if (!file || file.deletedAt || file.patientId !== patientId || file.uploadedByDoctorId !== null) {
      throw fileNotFound();
    }

    if (file.consultationId) {
      const consultation = await this.consultationLookup.findById(file.consultationId);
      if (consultation && consultation.status === 'completed') {
        throw deleteBlockedByCompletedConsultation();
      }
    }

    const deleted = await this.repo.softDelete(fileId);
    if (!deleted) {
      // Raced with a concurrent delete of the same file.
      throw fileNotFound();
    }

    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'delete',
      entityType: DOCUMENT_AUDIT_ENTITY_TYPES.PATIENT_FILE,
      entityId: fileId,
      consultationId: file.consultationId ?? undefined,
      metadata: { fileCategory: file.fileCategory },
    });
  }

  /**
   * Rule 6, the trickiest one: every `medical_history` file for the patient
   * who owns `consultationId`, regardless of which consultation (or none)
   * it's attached to, PLUS every file across ANY consultation this doctor
   * has had with that patient — not just `consultationId` itself. Before
   * returning anything, confirms the calling doctor has at least one
   * consultation (any status) with that patient; if not, 404s the WHOLE
   * request rather than an empty list, so a doctor with zero relationship to
   * the patient cannot learn the consultation exists at all.
   */
  async listForDoctorHistory(doctorId: string, consultationId: string): Promise<SafePatientFileRow[]> {
    const consultation = await this.consultationLookup.findById(consultationId);
    if (!consultation) {
      throw consultationNotFound();
    }

    const relatedConsultationIds = await this.consultationLookup.listConsultationIdsBetween(doctorId, consultation.patientId);
    if (relatedConsultationIds.length === 0) {
      throw consultationNotFound();
    }

    const rows = await this.repo.listForDoctorHistory(consultation.patientId, relatedConsultationIds);
    return rows.map(toSafePatientFileRow);
  }

  /** For `DocumentFacade#getPatientFileById` — see `document.contract.ts` for why this is the module's one exposed read. No auth check: a trusted module-to-module call. */
  async getPatientFileById(fileId: string): Promise<SafePatientFileRow | null> {
    const file = await this.repo.findById(fileId);
    if (!file || file.deletedAt) return null;
    return toSafePatientFileRow(file);
  }

  /* ---------------------------------------------------------------------- */
  /* Validation                                                               */
  /* ---------------------------------------------------------------------- */

  private validateCategory(raw: string): PatientUploadableCategory {
    if (raw === 'prescription_pdf' || raw === 'clarification_attachment') {
      throw new BadRequestException({
        code: DOCUMENT_ERROR_CODES.CATEGORY_NOT_UPLOADABLE,
        message: `'${raw}' cannot be uploaded directly — it is generated by the platform, not uploaded by a patient.`,
      });
    }
    if (!(PATIENT_UPLOADABLE_CATEGORIES as readonly string[]).includes(raw)) {
      throw new BadRequestException({
        code: DOCUMENT_ERROR_CODES.CATEGORY_NOT_UPLOADABLE,
        message: `category must be one of ${PATIENT_UPLOADABLE_CATEGORIES.join(', ')}.`,
      });
    }
    return raw as PatientUploadableCategory;
  }

  /**
   * TWO checks, ONE indistinguishable failure.
   *
   *   1. The DECLARED type is on this category's allowlist.
   *   2. The file's ACTUAL BYTES are that type (`verifyDeclaredContentType`,
   *      `modules/storage`) — because the declared type is just a header the
   *      client wrote, and a client that wants to store an executable in a
   *      patient's medical record only has to call it `image/jpeg`.
   *
   * Both failures raise the IDENTICAL exception, built once below rather than
   * duplicated, so the two cases are indistinguishable from outside. That is
   * deliberate: an error that said "you declared JPEG but these bytes are a
   * PDF" would turn this endpoint into an oracle for probing what the server
   * thinks arbitrary bytes are.
   *
   * Returns the VERIFIED content type, which is what gets handed to storage —
   * so the object store later serves the file back as something this server
   * confirmed rather than something a client asserted.
   */
  private resolveVerifiedContentType(category: PatientUploadableCategory, contentType: string, buffer: Buffer): string {
    const rejected = (): UnsupportedMediaTypeException =>
      new UnsupportedMediaTypeException({
        code: DOCUMENT_ERROR_CODES.INVALID_FILE_TYPE,
        message: `File type '${contentType}' is not accepted for category '${category}'.`,
      });

    // Normalised ONCE and reused for both checks — see the matching note in
    // `doctor-document.service.ts#resolveVerifiedContentType`. HTTP header
    // values carry optional surrounding whitespace (RFC 7231), and
    // normalising in one place is what keeps the allowlist check and the
    // sniff check from disagreeing about what was declared.
    const declared = contentType.trim().toLowerCase();

    const allowed = DOCUMENT_MIME_ALLOWLIST[category];
    if (!allowed.includes(declared)) {
      throw rejected();
    }

    const verified = verifyDeclaredContentType(buffer, declared);
    if (verified === null) {
      throw rejected();
    }

    return verified;
  }

  private async validateSize(sizeBytes: number): Promise<void> {
    const capMb = await this.appConfig.getNumber(DOCUMENT_CONFIG_KEYS.MAX_FILE_SIZE_MB, DOCUMENT_CONFIG_FALLBACKS.MAX_FILE_SIZE_MB);
    const capBytes = capMb * 1024 * 1024;
    if (sizeBytes > capBytes) {
      throw new PayloadTooLargeException({
        code: DOCUMENT_ERROR_CODES.FILE_TOO_LARGE,
        message: `File exceeds the maximum allowed size of ${capMb}MB.`,
      });
    }
  }

  /** `null` when no `consultationId` was given. Throws (404) when given but it doesn't exist or isn't the caller's own. */
  private async resolveConsultationId(patientId: string, consultationId: string | undefined): Promise<string | null> {
    if (!consultationId) return null;
    if (!isUUID(consultationId)) throw validationFailed('consultationId must be a valid UUID.');

    const consultation = await this.consultationLookup.findById(consultationId);
    if (!consultation || consultation.patientId !== patientId) {
      throw consultationNotFound();
    }
    return consultationId;
  }

  /** `null` when no `reportRequestId` was given. Throws when given but not found/not the caller's own (404), not currently `open` (409), or its own consultation disagrees with an explicitly-supplied `consultationId` (400). */
  private async resolveReportRequest(
    patientId: string,
    reportRequestId: string | undefined,
    consultationId: string | null,
  ): Promise<ReportRequestRow | null> {
    if (!reportRequestId) return null;
    if (!isUUID(reportRequestId)) throw validationFailed('reportRequestId must be a valid UUID.');

    const reportRequest = await this.reportRequestRepo.findById(reportRequestId);
    if (!reportRequest) throw reportRequestNotFound();

    const requestConsultation = await this.consultationLookup.findById(reportRequest.consultationId);
    if (!requestConsultation || requestConsultation.patientId !== patientId) {
      throw reportRequestNotFound();
    }

    if (consultationId && consultationId !== reportRequest.consultationId) {
      throw validationFailed('consultationId does not match the consultation this report request belongs to.');
    }

    if (reportRequest.status !== 'open') {
      throw reportRequestNotOpen();
    }

    return reportRequest;
  }

  private async canAccessForDownload(auth: AuthContext, file: PatientFileRow): Promise<boolean> {
    if (auth.accountType === 'admin') return true;
    if (auth.accountType === 'patient') return file.patientId === auth.accountId;
    if (auth.accountType === 'doctor') {
      if (!file.patientId) return false;
      const relatedIds = await this.consultationLookup.listConsultationIdsBetween(auth.accountId, file.patientId);
      return relatedIds.length > 0;
    }
    return false;
  }

  /**
   * Every method above that calls the storage port wraps ANY throw from it
   * through here — the raw `STORAGE_UNAVAILABLE`/`STORAGE_PORT_UNAVAILABLE`
   * (or any other provider-side code/message) never reaches a client. Logged
   * server-side, at `warn` rather than `error`: a storage outage is an
   * operational fact this module already degrades cleanly from, not a bug in
   * this module.
   */
  private wrapStorageError(error: unknown, action: 'upload' | 'download'): ServiceUnavailableException {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Document storage port failed during ${action}: ${detail}`);

    const message =
      action === 'upload'
        ? 'Could not upload your file right now. Please try again shortly.'
        : 'Could not generate a download link right now. Please try again shortly.';

    return new ServiceUnavailableException({ code: DOCUMENT_ERROR_CODES.STORAGE_UNAVAILABLE, message });
  }
}

/** One code for "doesn't exist", "already deleted", and "not yours" — a non-owner cannot distinguish any of the three, matching `doctor-document.repository.ts`'s `findByIdForDoctor` visibility pattern (404, never 403). */
export function fileNotFound(): NotFoundException {
  return new NotFoundException({ code: DOCUMENT_ERROR_CODES.FILE_NOT_FOUND, message: 'File not found.' });
}

export function deleteBlockedByCompletedConsultation(): ConflictException {
  return new ConflictException({
    code: DOCUMENT_ERROR_CODES.DELETE_BLOCKED_COMPLETED,
    message: 'This file is attached to a completed consultation and can no longer be deleted.',
  });
}

/** A malformed `consultationId`/`reportRequestId`, or a supplied `consultationId` that disagrees with `reportRequestId`'s own consultation — reuses the app-wide `VALIDATION_FAILED` code (`uuid-param.pipe.ts`'s own convention) rather than a document-specific one, since these are shape/consistency failures on the request itself. */
export function validationFailed(message: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', message });
}
