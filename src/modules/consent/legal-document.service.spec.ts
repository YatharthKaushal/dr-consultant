/**
 * `LegalDocumentService` — the write path that decides which version of a legal
 * document every patient is asked to accept.
 *
 * `new LegalDocumentService(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 */

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { LegalDocumentType } from '../../schema/enums.schema';
import type { LegalDocumentRow } from '../../schema/legal-documents.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { CONSENT_AUDIT_ENTITY_TYPES, CONSENT_ERROR_CODES } from './consent.constants';
import type { LegalDocumentRepository } from './legal-document.repository';
import { LegalDocumentService, parseLegalDocumentType } from './legal-document.service';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

function row(overrides: Partial<LegalDocumentRow> = {}): LegalDocumentRow {
  return {
    id: 'd0000000-0000-4000-8000-000000000001',
    documentType: 'privacy_policy',
    version: 'v1',
    title: 'Privacy Policy',
    body: 'The text.',
    isCurrent: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The `pg` driver's unique-violation shape, as `postgres-error.util.ts` documents it. */
const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

describe('LegalDocumentService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<LegalDocumentRepository>;
  let audit: jest.Mocked<AuditService>;
  let service: LegalDocumentService;
  /** Records the order of repository/audit calls, which is where the concurrency guarantee lives. */
  let calls: string[];
  /** The row `create` wrote, so `setCurrent` can return what it actually flipped. */
  let stored: LegalDocumentRow | null;

  beforeEach(() => {
    calls = [];
    stored = null;
    // A fake transaction that simply invokes its callback on the same handle.
    // It has no locking or rollback semantics — it is enough to assert that the
    // write and its audit are issued together, on one executor.
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      findById: jest.fn().mockResolvedValue(null),
      findByTypeAndVersion: jest.fn().mockResolvedValue(null),
      findCurrent: jest.fn().mockResolvedValue(null),
      listCurrent: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (data: Partial<LegalDocumentRow>) => {
        calls.push('create');
        stored = row({ ...data, id: 'd0000000-0000-4000-8000-0000000000ff' });
        return stored;
      }),
      lockDocumentTypeGuard: jest.fn(async () => {
        calls.push('lock');
      }),
      clearCurrent: jest.fn(async () => {
        calls.push('clearCurrent');
        return [];
      }),
      // Returns the row it actually flipped, as the real UPDATE ... RETURNING
      // does — a mock that invented a row would let a service bug that audits
      // the wrong version pass unnoticed.
      setCurrent: jest.fn(async (id: string) => {
        calls.push('setCurrent');
        const target = stored && stored.id === id ? stored : row({ id });
        return { ...target, isCurrent: true };
      }),
    } as unknown as jest.Mocked<LegalDocumentRepository>;

    audit = {
      write: jest.fn(async () => {
        calls.push('audit');
      }),
    } as unknown as jest.Mocked<AuditService>;

    service = new LegalDocumentService(db as unknown as Database, repo, audit);
  });

  /* ------------------------------------------------------------------ */

  describe('adminCreate', () => {
    const dto = { documentType: 'privacy_policy' as LegalDocumentType, version: 'v2', title: 'Privacy', body: 'Text' };

    it('writes a new version that is NOT current by default', async () => {
      const created = await service.adminCreate(ADMIN_ID, dto);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ version: 'v2', isCurrent: false }), db);
      expect(repo.setCurrent).not.toHaveBeenCalled();
      expect(repo.clearCurrent).not.toHaveBeenCalled();
      expect(repo.lockDocumentTypeGuard).not.toHaveBeenCalled();
      expect(created.isCurrent).toBe(false);
    });

    it('refuses a version string already used for this document type', async () => {
      repo.findByTypeAndVersion.mockResolvedValue(row({ version: 'v2' }));

      await expect(service.adminCreate(ADMIN_ID, dto)).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.LEGAL_DOCUMENT_VERSION_TAKEN },
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    /** The check-then-insert race: two admins pass `findByTypeAndVersion` before either writes. */
    it('converts the unique-index violation into the same 409, not a 500', async () => {
      repo.create.mockRejectedValue(uniqueViolation);

      await expect(service.adminCreate(ADMIN_ID, dto)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.adminCreate(ADMIN_ID, dto)).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.LEGAL_DOCUMENT_VERSION_TAKEN },
      });
    });

    /**
     * *** THE LOCK IS TAKEN BEFORE ANYTHING READS OR WRITES `is_current`. ***
     * Without it two concurrent publishes of one document type both demote the
     * old version and both promote their own, leaving two current versions —
     * and a pre-consult check whose answer depends on which row `limit 1`
     * returns. See `consent.constants.ts`.
     */
    it('publishes in the same transaction, under the document-type lock, taken first', async () => {
      const created = await service.adminCreate(ADMIN_ID, { ...dto, publish: true });

      expect(calls).toEqual(['lock', 'create', 'clearCurrent', 'setCurrent', 'audit']);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(created.isCurrent).toBe(true);
    });

    /** Demoting everything EXCEPT the row being promoted keeps a re-publish a no-op rather than a flap. */
    it('demotes every other current version of the type, excluding the new row', async () => {
      await service.adminCreate(ADMIN_ID, { ...dto, publish: true });

      expect(repo.clearCurrent).toHaveBeenCalledWith('privacy_policy', 'd0000000-0000-4000-8000-0000000000ff', db);
    });

    /** Legal evidence: a published version with no record of who published it is not an acceptable half-success. */
    it('audits inside the transaction, on the same executor, naming what it superseded', async () => {
      repo.clearCurrent.mockResolvedValue([row({ version: 'v1', isCurrent: true })]);

      await service.adminCreate(ADMIN_ID, { ...dto, publish: true });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'create',
          entityType: CONSENT_AUDIT_ENTITY_TYPES.LEGAL_DOCUMENT,
          metadata: expect.objectContaining({ version: 'v2', published: true, supersededVersions: ['v1'] }),
        }),
        db,
      );
    });

    it('audits a draft as unpublished', async () => {
      await service.adminCreate(ADMIN_ID, dto);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ published: false, supersededVersions: [] }) }),
        db,
      );
    });
  });

  /* ------------------------------------------------------------------ */

  describe('adminPublish', () => {
    beforeEach(() => {
      stored = row({ id: 'd1', version: 'v2' });
      repo.findById.mockResolvedValue(stored);
    });

    it('404s on an unknown id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.adminPublish(ADMIN_ID, 'd1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('locks the document type, demotes the previous current version, then promotes this one', async () => {
      repo.clearCurrent.mockImplementation(async () => {
        calls.push('clearCurrent');
        return [row({ id: 'd0', version: 'v1', isCurrent: true })];
      });

      const published = await service.adminPublish(ADMIN_ID, 'd1');

      expect(calls).toEqual(['lock', 'clearCurrent', 'setCurrent', 'audit']);
      expect(repo.clearCurrent).toHaveBeenCalledWith('privacy_policy', 'd1', db);
      expect(published.isCurrent).toBe(true);
    });

    /** Re-publishing the live version demotes nothing, and is still recorded — an auditor may need the fact. */
    it('is idempotent for an already-current version, and still audits', async () => {
      repo.findById.mockResolvedValue(row({ id: 'd1', version: 'v2', isCurrent: true }));

      await service.adminPublish(ADMIN_ID, 'd1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          metadata: expect.objectContaining({ alreadyCurrent: true, supersededVersions: [] }),
        }),
        db,
      );
    });

    /** The row is re-read INSIDE the transaction, under the lock — the pre-read only resolves which lock to take. */
    it('re-reads the row inside the transaction', async () => {
      await service.adminPublish(ADMIN_ID, 'd1');
      expect(repo.findById).toHaveBeenCalledTimes(2);
      expect(repo.findById).toHaveBeenLastCalledWith('d1', db);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('in-app reads', () => {
    it('hides the doctor agreement from a patient and keeps everything else', async () => {
      repo.listCurrent.mockResolvedValue([
        row({ id: 'd1', documentType: 'privacy_policy', isCurrent: true }),
        row({ id: 'd2', documentType: 'doctor_agreement', isCurrent: true }),
      ]);

      const patientView = await service.listCurrentForAccountType('patient');
      expect(patientView.map((doc) => doc.documentType)).toEqual(['privacy_policy']);

      const doctorView = await service.listCurrentForAccountType('doctor');
      expect(doctorView.map((doc) => doc.documentType)).toEqual(['privacy_policy', 'doctor_agreement']);
    });

    /** The listing must never carry whole legal texts. */
    it('lists without bodies', async () => {
      repo.listCurrent.mockResolvedValue([row({ isCurrent: true })]);
      expect(await service.listCurrentForAccountType('patient')).toEqual([
        expect.not.objectContaining({ body: expect.anything() }),
      ]);
    });

    it('serves the current version in full — FR-2.4', async () => {
      repo.findCurrent.mockResolvedValue(row({ documentType: 'refund_policy', version: 'v3', isCurrent: true }));

      const detail = await service.getCurrentForAccountType('refund_policy', 'patient');

      expect(detail).toMatchObject({ documentType: 'refund_policy', version: 'v3', body: 'The text.' });
      expect(detail.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('404s when nothing is published for the type', async () => {
      repo.findCurrent.mockResolvedValue(null);
      await expect(service.getCurrentForAccountType('terms_of_use', 'patient')).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.NO_CURRENT_LEGAL_DOCUMENT },
      });
    });

    it('refuses a patient reading the doctor agreement', async () => {
      await expect(service.getCurrentForAccountType('doctor_agreement', 'patient')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repo.findCurrent).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */

  describe('parseLegalDocumentType', () => {
    it('accepts a real type', () => {
      expect(parseLegalDocumentType('teleconsultation_consent')).toBe('teleconsultation_consent');
    });

    /** Without this the value reaches Postgres as a bad enum literal and surfaces as a generic 500. */
    it('rejects anything else as a 400, before any query', () => {
      expect(() => parseLegalDocumentType('not_a_type')).toThrow(BadRequestException);
      expect(() => parseLegalDocumentType('not_a_type')).toThrow(/documentType must be one of/);
    });
  });
});
