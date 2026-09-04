/**
 * `ConsentService` — FR-2.3 capture, and the pre-consult check M-14 gates a
 * consultation on.
 *
 * `new ConsentService(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { ConsentRow } from '../../schema/consents.schema';
import type { LegalDocumentRow } from '../../schema/legal-documents.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { CONSENT_AUDIT_ENTITY_TYPES, CONSENT_ERROR_CODES } from './consent.constants';
import type { ConsentAcceptance, ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';
import type { LegalDocumentRepository } from './legal-document.repository';

const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'd0c00000-0000-4000-8000-000000000001';
const IP = '203.0.113.7';

function document(overrides: Partial<LegalDocumentRow> = {}): LegalDocumentRow {
  return {
    id: 'l0000000-0000-4000-8000-000000000002',
    documentType: 'teleconsultation_consent',
    version: 'v2',
    title: 'Teleconsultation Consent',
    body: 'The text.',
    isCurrent: true,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function consentRow(overrides: Partial<ConsentRow> = {}): ConsentRow {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    patientId: PATIENT_ID,
    doctorId: null,
    legalDocumentId: 'l0000000-0000-4000-8000-000000000002',
    documentType: 'teleconsultation_consent',
    acceptedAt: new Date('2026-03-01T10:00:00.000Z'),
    ipAddress: IP,
    ...overrides,
  };
}

function acceptance(overrides: Partial<ConsentAcceptance> = {}): ConsentAcceptance {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    legalDocumentId: 'l0000000-0000-4000-8000-000000000002',
    documentType: 'teleconsultation_consent',
    acceptedAt: new Date('2026-03-01T10:00:00.000Z'),
    version: 'v2',
    title: 'Teleconsultation Consent',
    ...overrides,
  };
}

const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

describe('ConsentService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<ConsentRepository>;
  let legalDocuments: jest.Mocked<LegalDocumentRepository>;
  let audit: jest.Mocked<AuditService>;
  let service: ConsentService;

  beforeEach(() => {
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      findLatestPatientAcceptance: jest.fn().mockResolvedValue(null),
      findPatientAcceptanceOfDocument: jest.fn().mockResolvedValue(null),
      findDoctorAcceptanceOfDocument: jest.fn().mockResolvedValue(null),
      listPatientAcceptances: jest.fn().mockResolvedValue([]),
      listDoctorAcceptances: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (data: Partial<ConsentRow>) => consentRow(data)),
    } as unknown as jest.Mocked<ConsentRepository>;

    legalDocuments = {
      findById: jest.fn().mockResolvedValue(document()),
      findCurrent: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<LegalDocumentRepository>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    service = new ConsentService(db as unknown as Database, repo, legalDocuments, audit);
  });

  /* ------------------------------------------------------------------ */

  describe('recordConsent', () => {
    it('404s on an unknown legal document id', async () => {
      legalDocuments.findById.mockResolvedValue(null);
      await expect(service.recordConsent('patient', PATIENT_ID, 'missing', IP)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    /**
     * *** A SUPERSEDED VERSION IS REFUSED, NOT STORED. *** SRS §6.2 requires
     * consent before teleconsultation; consent to text nobody serves any more
     * is not that, and storing it would create evidence of an agreement the
     * platform never asked for.
     */
    it('refuses acceptance of a version that is no longer current', async () => {
      legalDocuments.findById.mockResolvedValue(document({ isCurrent: false, version: 'v1' }));

      await expect(service.recordConsent('patient', PATIENT_ID, 'l1', IP)).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.SUPERSEDED_LEGAL_DOCUMENT },
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('records patient acceptance with the pinned version, the timestamp and the IP', async () => {
      const record = await service.recordConsent('patient', PATIENT_ID, 'l1', IP);

      expect(repo.create).toHaveBeenCalledWith(
        {
          patientId: PATIENT_ID,
          doctorId: null,
          legalDocumentId: document().id,
          documentType: 'teleconsultation_consent',
          ipAddress: IP,
        },
        db,
      );
      expect(record).toMatchObject({
        documentType: 'teleconsultation_consent',
        version: 'v2',
        acceptedAt: '2026-03-01T10:00:00.000Z',
      });
    });

    /** `document_type` is copied from the pinned row, never taken from the request — the composite FK depends on it. */
    it('copies documentType from the document, not from the caller', async () => {
      legalDocuments.findById.mockResolvedValue(document({ documentType: 'terms_of_use' }));

      await service.recordConsent('patient', PATIENT_ID, 'l1', IP);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'terms_of_use' }), db);
    });

    it('records a doctor acceptance against doctorId, leaving patientId null', async () => {
      legalDocuments.findById.mockResolvedValue(document({ documentType: 'doctor_agreement' }));
      repo.create.mockImplementation(async (data) => consentRow({ ...data, patientId: null, doctorId: DOCTOR_ID }));

      await service.recordConsent('doctor', DOCTOR_ID, 'l1', IP);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: null, doctorId: DOCTOR_ID, documentType: 'doctor_agreement' }),
        db,
      );
    });

    it('refuses a patient accepting the doctor agreement', async () => {
      legalDocuments.findById.mockResolvedValue(document({ documentType: 'doctor_agreement' }));

      await expect(service.recordConsent('patient', PATIENT_ID, 'l1', IP)).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR },
      });
    });

    it('refuses a doctor accepting the teleconsultation consent — that is the patient’s to give', async () => {
      await expect(service.recordConsent('doctor', DOCTOR_ID, 'l1', IP)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    /** *** THE AUDIT COMMITS OR ROLLS BACK WITH THE CONSENT IT AUDITS. *** */
    it('audits inside the transaction, on the same executor, carrying the version and the IP', async () => {
      await service.recordConsent('patient', PATIENT_ID, 'l1', IP);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'patient',
          actorId: PATIENT_ID,
          action: 'create',
          entityType: CONSENT_AUDIT_ENTITY_TYPES.CONSENT,
          ipAddress: IP,
          metadata: expect.objectContaining({ version: 'v2', documentType: 'teleconsultation_consent' }),
        }),
        db,
      );
    });

    it('omits ipAddress from the audit entry when the request had none', async () => {
      await service.recordConsent('patient', PATIENT_ID, 'l1', null);

      expect(audit.write.mock.calls[0]?.[0]).not.toHaveProperty('ipAddress');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: null }), db);
    });

    /** The first acceptance is the legally interesting one; a double-tap must not rewrite its timestamp. */
    it('is idempotent for a version already accepted — no second row, no second audit', async () => {
      repo.findPatientAcceptanceOfDocument.mockResolvedValue(
        consentRow({ acceptedAt: new Date('2026-02-02T09:00:00.000Z') }),
      );

      const record = await service.recordConsent('patient', PATIENT_ID, 'l1', IP);

      expect(record.acceptedAt).toBe('2026-02-02T09:00:00.000Z');
      expect(repo.create).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    /** The check-then-insert race on `consents_patient_id_legal_document_id_index`. */
    it('answers with the stored row when a concurrent double-tap loses the unique index', async () => {
      repo.create.mockRejectedValue(uniqueViolation);
      repo.findPatientAcceptanceOfDocument
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(consentRow({ acceptedAt: new Date('2026-02-02T09:00:00.000Z') }));

      const record = await service.recordConsent('patient', PATIENT_ID, 'l1', IP);

      expect(record.acceptedAt).toBe('2026-02-02T09:00:00.000Z');
    });

    it('rethrows a unique violation it cannot explain', async () => {
      repo.create.mockRejectedValue(uniqueViolation);
      await expect(service.recordConsent('patient', PATIENT_ID, 'l1', IP)).rejects.toBe(uniqueViolation);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('checkPatientConsent', () => {
    /** The M-14 gate: consent is only consent against the version being served now. */
    it('is true when the patient accepted the current version', async () => {
      legalDocuments.findCurrent.mockResolvedValue(document({ id: 'l2', version: 'v2' }));
      repo.findLatestPatientAcceptance.mockResolvedValue(acceptance({ legalDocumentId: 'l2', version: 'v2' }));

      expect(await service.checkPatientConsent(PATIENT_ID, 'teleconsultation_consent')).toEqual({
        hasCurrentConsent: true,
        acceptedVersion: 'v2',
        acceptedAt: new Date('2026-03-01T10:00:00.000Z'),
        currentVersion: 'v2',
      });
      // The common case costs one acceptance lookup, not two.
      expect(repo.findPatientAcceptanceOfDocument).not.toHaveBeenCalled();
    });

    /**
     * *** ACCEPTING A SUPERSEDED VERSION DOES NOT READ AS CONSENT. *** And
     * `acceptedVersion` still reports v1, so the app says "please review the
     * updated consent" rather than "please consent".
     */
    it('is false when the patient accepted only an older version, and names that version', async () => {
      legalDocuments.findCurrent.mockResolvedValue(document({ id: 'l2', version: 'v2' }));
      repo.findLatestPatientAcceptance.mockResolvedValue(
        acceptance({ legalDocumentId: 'l1', version: 'v1', acceptedAt: new Date('2025-12-01T00:00:00.000Z') }),
      );

      expect(await service.checkPatientConsent(PATIENT_ID, 'teleconsultation_consent')).toEqual({
        hasCurrentConsent: false,
        acceptedVersion: 'v1',
        acceptedAt: new Date('2025-12-01T00:00:00.000Z'),
        currentVersion: 'v2',
      });
    });

    it('is false, and empty, when the patient never consented', async () => {
      legalDocuments.findCurrent.mockResolvedValue(document({ id: 'l2', version: 'v2' }));

      expect(await service.checkPatientConsent(PATIENT_ID, 'teleconsultation_consent')).toEqual({
        hasCurrentConsent: false,
        acceptedVersion: null,
        acceptedAt: null,
        currentVersion: 'v2',
      });
    });

    /** Nothing published means nothing to consent to — false, with a null `currentVersion` the app can act on. */
    it('is false with a null currentVersion when no version is published', async () => {
      legalDocuments.findCurrent.mockResolvedValue(null);
      repo.findLatestPatientAcceptance.mockResolvedValue(acceptance({ version: 'v1' }));

      expect(await service.checkPatientConsent(PATIENT_ID, 'teleconsultation_consent')).toMatchObject({
        hasCurrentConsent: false,
        acceptedVersion: 'v1',
        currentVersion: null,
      });
    });

    /**
     * An admin re-publishing an older version makes it current again. A patient
     * who accepted it back then HAS accepted what is being served — the latest
     * acceptance is a different (newer) row, so the second lookup is what finds
     * the truth.
     */
    it('is true when the current version is one the patient accepted earlier, even if a later acceptance exists', async () => {
      legalDocuments.findCurrent.mockResolvedValue(document({ id: 'l1', version: 'v1' }));
      repo.findLatestPatientAcceptance.mockResolvedValue(acceptance({ legalDocumentId: 'l2', version: 'v2' }));
      repo.findPatientAcceptanceOfDocument.mockResolvedValue(
        consentRow({ legalDocumentId: 'l1', acceptedAt: new Date('2025-11-01T00:00:00.000Z') }),
      );

      expect(await service.checkPatientConsent(PATIENT_ID, 'teleconsultation_consent')).toEqual({
        hasCurrentConsent: true,
        acceptedVersion: 'v1',
        acceptedAt: new Date('2025-11-01T00:00:00.000Z'),
        currentVersion: 'v1',
      });
    });
  });

  /* ------------------------------------------------------------------ */

  describe('listOwnConsents', () => {
    it('reads the patient history — every version accepted, and when', async () => {
      repo.listPatientAcceptances.mockResolvedValue([acceptance({ version: 'v2' }), acceptance({ version: 'v1' })]);

      const records = await service.listOwnConsents('patient', PATIENT_ID);

      expect(records.map((record) => record.version)).toEqual(['v2', 'v1']);
      expect(records[0]?.acceptedAt).toBe('2026-03-01T10:00:00.000Z');
    });

    it('reads the doctor history from the doctor side', async () => {
      await service.listOwnConsents('doctor', DOCTOR_ID);

      expect(repo.listDoctorAcceptances).toHaveBeenCalledWith(DOCTOR_ID);
      expect(repo.listPatientAcceptances).not.toHaveBeenCalled();
    });

    /** `ip_address` is legal evidence, not a field an API echoes back. */
    it('never returns the stored IP address', async () => {
      repo.listPatientAcceptances.mockResolvedValue([acceptance()]);
      expect(await service.listOwnConsents('patient', PATIENT_ID)).toEqual([
        expect.not.objectContaining({ ipAddress: expect.anything() }),
      ]);
    });
  });
});
