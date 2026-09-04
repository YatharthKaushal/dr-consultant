import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import type { AccountType, LegalDocumentType } from '../../schema/enums.schema';
import type { LegalDocumentRow } from '../../schema/legal-documents.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { CONSENT_AUDIT_ENTITY_TYPES, CONSENT_ERROR_CODES } from './consent.constants';
import type { ConsentCheck } from './consent.contract';
import { toConsentRecord } from './consent.mapper';
import { ConsentRepository } from './consent.repository';
import type { ConsentRecord } from './consent.types';
import { legalDocumentNotFound } from './legal-document.service';
import { LegalDocumentRepository } from './legal-document.repository';

/** Only a patient or a doctor accepts a legal document. An admin acting for someone else would not be that person's consent. */
export type ConsentActorType = Extract<AccountType, 'patient' | 'doctor'>;

/**
 * The one document type a DOCTOR accepts. A doctor is not asked for
 * teleconsultation consent (the patient gives that), and a patient is never
 * shown the doctor agreement — so the acceptable set is a function of who is
 * accepting, checked here rather than trusted from the client.
 */
const DOCTOR_ACCEPTABLE_DOCUMENT_TYPES: readonly LegalDocumentType[] = ['doctor_agreement'];

/**
 * FR-2.3: capture explicit consent against a specific document VERSION, with
 * the timestamp, the user and the IP address that accepted it.
 *
 * *** APPEND-ONLY. *** Accepting a newer version INSERTS a row; the row proving
 * acceptance of the older version is never updated and never deleted. That is
 * what makes "what exactly did this patient agree to, and when" answerable
 * years later, which is the whole point of the table.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: ConsentRepository,
    private readonly legalDocuments: LegalDocumentRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Capture (FR-2.3)                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Records acceptance of ONE EXACT VERSION, identified by `legalDocumentId`
   * rather than by document type: the client accepted the text it displayed,
   * and pinning the id is what makes the stored evidence match what was on
   * screen. `consents.document_type` is copied from that row, never from the
   * request — the composite FK to `legal_documents (id, document_type)` would
   * reject a disagreeing pair anyway.
   *
   * Refuses a superseded version (409) instead of storing it. Re-accepting the
   * version already accepted is idempotent, returning the original row and its
   * original timestamp: the first acceptance is the legally interesting one,
   * and the `(patient_id, legal_document_id)` unique index says so.
   */
  async recordConsent(
    actorType: ConsentActorType,
    actorId: string,
    legalDocumentId: string,
    ipAddress: string | null,
  ): Promise<ConsentRecord> {
    const document = await this.legalDocuments.findById(legalDocumentId);
    if (!document) throw legalDocumentNotFound();

    this.assertAcceptableByActor(document.documentType, actorType);

    if (!document.isCurrent) {
      throw new ConflictException({
        code: CONSENT_ERROR_CODES.SUPERSEDED_LEGAL_DOCUMENT,
        message: 'This version is no longer current. Fetch the current version and accept that.',
      });
    }

    const existing = await this.findExistingAcceptance(actorType, actorId, document.id);
    if (existing) return this.toRecord(existing.id, existing.acceptedAt, document);

    try {
      const row = await this.db.transaction(async (tx) => {
        const created = await this.repo.create(
          {
            patientId: actorType === 'patient' ? actorId : null,
            doctorId: actorType === 'doctor' ? actorId : null,
            legalDocumentId: document.id,
            documentType: document.documentType,
            ipAddress,
          },
          tx,
        );

        // *** THE AUDIT COMMITS OR ROLLS BACK WITH THE CONSENT IT AUDITS. ***
        // This is legal evidence (SRS §8), so a consent row with no record of
        // how it came to exist is not an acceptable half-success — the
        // best-effort audit mode `AuditService` also offers is for logins, not
        // for this.
        await this.audit.write(
          {
            actorType,
            actorId,
            action: 'create',
            entityType: CONSENT_AUDIT_ENTITY_TYPES.CONSENT,
            entityId: created.id,
            metadata: {
              legalDocumentId: document.id,
              documentType: document.documentType,
              version: document.version,
              title: document.title,
            },
            ...(ipAddress ? { ipAddress } : {}),
          },
          tx,
        );

        return created;
      });

      return this.toRecord(row.id, row.acceptedAt, document);
    } catch (error) {
      // Safety net for the check-then-insert race on
      // `consents_(patient|doctor)_id_legal_document_id_index`: a client that
      // fires the same acceptance twice can pass the `findExistingAcceptance`
      // check on both. Re-read and answer with the row that won, so a
      // double-tap is idempotent rather than a 500.
      if (isUniqueConstraintViolation(error)) {
        const stored = await this.findExistingAcceptance(actorType, actorId, document.id);
        if (stored) return this.toRecord(stored.id, stored.acceptedAt, document);
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  /** The accepting account's own history — "consent version and time are retrievable" (M-03's done-when). */
  async listOwnConsents(actorType: ConsentActorType, actorId: string): Promise<ConsentRecord[]> {
    const rows =
      actorType === 'patient'
        ? await this.repo.listPatientAcceptances(actorId)
        : await this.repo.listDoctorAcceptances(actorId);
    return rows.map(toConsentRecord);
  }

  /**
   * *** THE PRE-CONSULT CHECK. *** Backs `ConsentFacade.checkPatientConsent`,
   * which is what M-14 gates joining a consultation on.
   *
   * `hasCurrentConsent` is true ONLY against the version that is current right
   * now. A patient who accepted v1 while v2 is published has not consented, and
   * `acceptedVersion` reports v1 so the app can say "please review the updated
   * consent" instead of "please consent".
   *
   * This method may throw (a dead database throws); the FACADE is what turns
   * any failure into a closed answer. Keeping the refusal there rather than
   * here means the HTTP read below still surfaces a real error to an operator
   * instead of silently reporting "no consent".
   */
  async checkPatientConsent(patientId: string, documentType: LegalDocumentType): Promise<ConsentCheck> {
    const current = await this.legalDocuments.findCurrent(documentType);
    const latest = await this.repo.findLatestPatientAcceptance(patientId, documentType);

    if (current) {
      // The usual case is one query: the most recent acceptance IS of the
      // current version. The second lookup only runs when it is not — which
      // includes the awkward-but-real case of an admin re-publishing an older
      // version that this patient had already accepted.
      const acceptedCurrent =
        latest && latest.legalDocumentId === current.id
          ? { acceptedAt: latest.acceptedAt }
          : await this.repo.findPatientAcceptanceOfDocument(patientId, current.id);

      if (acceptedCurrent) {
        return {
          hasCurrentConsent: true,
          acceptedVersion: current.version,
          acceptedAt: acceptedCurrent.acceptedAt,
          currentVersion: current.version,
        };
      }
    }

    return {
      hasCurrentConsent: false,
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
      currentVersion: current?.version ?? null,
    };
  }

  /* ---------------------------------------------------------------------- */

  private assertAcceptableByActor(documentType: LegalDocumentType, actorType: ConsentActorType): void {
    const acceptable =
      actorType === 'doctor'
        ? DOCTOR_ACCEPTABLE_DOCUMENT_TYPES.includes(documentType)
        : !DOCTOR_ACCEPTABLE_DOCUMENT_TYPES.includes(documentType);

    if (!acceptable) {
      throw new ConflictException({
        code: CONSENT_ERROR_CODES.DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR,
        message: 'This document is not accepted by this account type.',
      });
    }
  }

  private async findExistingAcceptance(
    actorType: ConsentActorType,
    actorId: string,
    legalDocumentId: string,
  ): Promise<{ id: string; acceptedAt: Date } | null> {
    return actorType === 'patient'
      ? this.repo.findPatientAcceptanceOfDocument(actorId, legalDocumentId)
      : this.repo.findDoctorAcceptanceOfDocument(actorId, legalDocumentId);
  }

  private toRecord(id: string, acceptedAt: Date, document: LegalDocumentRow): ConsentRecord {
    return toConsentRecord({
      id,
      legalDocumentId: document.id,
      documentType: document.documentType,
      acceptedAt,
      version: document.version,
      title: document.title,
    });
  }
}
