import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import { LEGAL_DOCUMENT_TYPES, type AccountType, type LegalDocumentType } from '../../schema/enums.schema';
import type { LegalDocumentRow } from '../../schema/legal-documents.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { CONSENT_AUDIT_ENTITY_TYPES, CONSENT_ERROR_CODES } from './consent.constants';
import { toLegalDocumentDetail, toLegalDocumentSummary } from './consent.mapper';
import type { LegalDocumentDetail, LegalDocumentSummary } from './consent.types';
import type { CreateLegalDocumentDto } from './legal-document-admin.dto';
import { LegalDocumentRepository } from './legal-document.repository';

/** Shared 404 shape for a missing legal-document id. */
export function legalDocumentNotFound(): NotFoundException {
  return new NotFoundException({
    code: CONSENT_ERROR_CODES.LEGAL_DOCUMENT_NOT_FOUND,
    message: 'Legal document not found.',
  });
}

/**
 * `doctor_agreement` is the platform's contract with its doctors, not text a
 * patient is asked to read or accept. Everything else in the enum is
 * patient-facing (FR-2.4: privacy policy, terms of use, refund policy; M-03
 * adds the reconsult policy and the teleconsultation consent itself).
 */
const DOCTOR_ONLY_DOCUMENT_TYPES: readonly LegalDocumentType[] = ['doctor_agreement'];

/** True when this account type may read this document type at all. Admins read everything. */
export function isReadableByAccountType(documentType: LegalDocumentType, accountType: AccountType): boolean {
  if (accountType === 'patient') return !DOCTOR_ONLY_DOCUMENT_TYPES.includes(documentType);
  return true;
}

/**
 * Validates a `document_type` path segment against the enum before it reaches a
 * query. Without this an unknown value reaches Postgres as an invalid enum
 * literal (`22P02`) and `HttpExceptionFilter` reports it as a generic 500 —
 * the same failure `uuid-param.pipe.ts` exists to prevent for uuid params.
 */
export function parseLegalDocumentType(value: string): LegalDocumentType {
  const match = LEGAL_DOCUMENT_TYPES.find((type) => type === value);
  if (!match) {
    throw new BadRequestException({
      code: CONSENT_ERROR_CODES.UNKNOWN_DOCUMENT_TYPE,
      message: `documentType must be one of: ${LEGAL_DOCUMENT_TYPES.join(', ')}.`,
    });
  }
  return match;
}

/**
 * `legal_documents`: the admin write path (a new version is a new row, then a
 * publish that makes it the current one) and the in-app reads FR-2.4 requires.
 *
 * A version is NEVER edited in place. Once anyone has accepted a version, its
 * text is the evidence of what they accepted — editing it would rewrite that
 * evidence, so the only mutation this service performs on an existing row is
 * flipping `is_current`.
 */
@Injectable()
export class LegalDocumentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: LegalDocumentRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Admin (admin/legal-documents)                                           */
  /* ---------------------------------------------------------------------- */

  /** The version history, newest first. Summaries — a history list of full legal texts is a payload nobody asked for. */
  async adminList(documentType?: LegalDocumentType): Promise<LegalDocumentSummary[]> {
    const rows = await this.repo.list(documentType);
    return rows.map(toLegalDocumentSummary);
  }

  async adminGetById(id: string): Promise<LegalDocumentDetail> {
    return toLegalDocumentDetail(await this.getRowOrThrow(id));
  }

  /**
   * Writes a new version. `publish: true` makes it current in the SAME
   * transaction — the common admin action is "here is v2, it is live now", and
   * splitting it into two requests leaves a window in which v2 exists but v1 is
   * still what patients are asked to accept.
   *
   * The insert, the demotion of the previous current version and the audit
   * entry share one transaction: this is legal evidence, so a published version
   * with no record of who published it is not an acceptable half-success.
   */
  async adminCreate(actingAdminId: string, dto: CreateLegalDocumentDto): Promise<LegalDocumentDetail> {
    const duplicate = await this.repo.findByTypeAndVersion(dto.documentType, dto.version);
    if (duplicate) throw this.versionTaken();

    try {
      const row = await this.db.transaction(async (tx) => {
        // Taken BEFORE the insert so the whole publish decision — read who is
        // current, demote, promote — happens under one lock per document type.
        if (dto.publish) await this.repo.lockDocumentTypeGuard(dto.documentType, tx);

        const created = await this.repo.create(
          {
            documentType: dto.documentType,
            version: dto.version,
            title: dto.title,
            body: dto.body,
            isCurrent: false,
          },
          tx,
        );

        const demoted = dto.publish ? await this.repo.clearCurrent(dto.documentType, created.id, tx) : [];
        const published = dto.publish ? await this.repo.setCurrent(created.id, tx) : null;
        const result = published ?? created;

        await this.audit.write(
          {
            actorType: 'admin',
            actorId: actingAdminId,
            action: 'create',
            entityType: CONSENT_AUDIT_ENTITY_TYPES.LEGAL_DOCUMENT,
            entityId: result.id,
            metadata: {
              documentType: result.documentType,
              version: result.version,
              title: result.title,
              published: result.isCurrent,
              supersededVersions: demoted.map((previous) => previous.version),
            },
          },
          tx,
        );

        return result;
      });

      return toLegalDocumentDetail(row);
    } catch (error) {
      // Safety net for the check-then-insert race on
      // `legal_documents_document_type_version_index`: two admins can both
      // pass the `findByTypeAndVersion` check above before either inserts.
      if (isUniqueConstraintViolation(error)) throw this.versionTaken();
      throw error;
    }
  }

  /**
   * Makes one existing version the current one for its type, demoting whoever
   * held that place. Idempotent: publishing the already-current version demotes
   * nothing and still records who asked, because "an admin re-published the
   * live terms of use" is a fact an auditor may need.
   */
  async adminPublish(actingAdminId: string, id: string): Promise<LegalDocumentDetail> {
    // Read first purely to resolve `document_type`, which names the lock. Every
    // decision below is re-read INSIDE the transaction, under that lock.
    const target = await this.getRowOrThrow(id);

    const row = await this.db.transaction(async (tx) => {
      await this.repo.lockDocumentTypeGuard(target.documentType, tx);

      const fresh = await this.repo.findById(id, tx);
      if (!fresh) throw legalDocumentNotFound();

      const demoted = await this.repo.clearCurrent(fresh.documentType, fresh.id, tx);
      const published = await this.repo.setCurrent(fresh.id, tx);
      if (!published) throw legalDocumentNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: CONSENT_AUDIT_ENTITY_TYPES.LEGAL_DOCUMENT,
          entityId: published.id,
          metadata: {
            documentType: published.documentType,
            version: published.version,
            published: true,
            alreadyCurrent: fresh.isCurrent,
            supersededVersions: demoted.map((previous) => previous.version),
          },
        },
        tx,
      );

      return published;
    });

    return toLegalDocumentDetail(row);
  }

  /* ---------------------------------------------------------------------- */
  /* In-app reads (FR-2.4)                                                   */
  /* ---------------------------------------------------------------------- */

  /** The legal section index: every published document this account type may read, without bodies. */
  async listCurrentForAccountType(accountType: AccountType): Promise<LegalDocumentSummary[]> {
    const rows = await this.repo.listCurrent();
    return rows.filter((row) => isReadableByAccountType(row.documentType, accountType)).map(toLegalDocumentSummary);
  }

  /** The published privacy policy / terms of use / refund policy / reconsult policy / consent text, in full. */
  async getCurrentForAccountType(documentType: LegalDocumentType, accountType: AccountType): Promise<LegalDocumentDetail> {
    if (!isReadableByAccountType(documentType, accountType)) {
      throw new ForbiddenException({
        code: CONSENT_ERROR_CODES.DOCUMENT_TYPE_NOT_READABLE_BY_ACTOR,
        message: 'This document is not available to this account type.',
      });
    }

    const row = await this.repo.findCurrent(documentType);
    if (!row) {
      throw new NotFoundException({
        code: CONSENT_ERROR_CODES.NO_CURRENT_LEGAL_DOCUMENT,
        message: 'No current version of this document has been published.',
      });
    }
    return toLegalDocumentDetail(row);
  }

  /* ---------------------------------------------------------------------- */

  private async getRowOrThrow(id: string): Promise<LegalDocumentRow> {
    const row = await this.repo.findById(id);
    if (!row) throw legalDocumentNotFound();
    return row;
  }

  private versionTaken(): ConflictException {
    return new ConflictException({
      code: CONSENT_ERROR_CODES.LEGAL_DOCUMENT_VERSION_TAKEN,
      message: 'This version already exists for this document type.',
    });
  }
}
