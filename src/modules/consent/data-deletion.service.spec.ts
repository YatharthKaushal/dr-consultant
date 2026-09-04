/**
 * `DataDeletionService` — FR-2.5: raising a data-deletion request and its
 * admin review. `new DataDeletionService(mockedDeps)` with hand-rolled
 * `jest.fn()`s, never `Test.createTestingModule`.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DataDeletionRequestRow } from '../../schema/data-deletion-requests.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { DATA_DELETION_AUDIT_ENTITY_TYPES, DATA_DELETION_ERROR_CODES } from './data-deletion.constants';
import type { DataDeletionRepository } from './data-deletion.repository';
import { DataDeletionService } from './data-deletion.service';

const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';
const OTHER_PATIENT_ID = 'p0000000-0000-4000-8000-000000000002';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'r0000000-0000-4000-8000-000000000001';

function requestRow(overrides: Partial<DataDeletionRequestRow> = {}): DataDeletionRequestRow {
  return {
    id: REQUEST_ID,
    patientId: PATIENT_ID,
    status: 'requested',
    reason: 'Closing my account.',
    reviewedByAdminId: null,
    reviewedAt: null,
    reviewNote: null,
    executionOutcome: null,
    executedAt: null,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    ...overrides,
  } as DataDeletionRequestRow;
}

describe('DataDeletionService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<DataDeletionRepository>;
  let audit: jest.Mocked<AuditService>;
  let service: DataDeletionService;

  beforeEach(() => {
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      create: jest.fn(async (data: Partial<DataDeletionRequestRow>) => requestRow(data)),
      findById: jest.fn().mockResolvedValue(requestRow()),
      listByPatient: jest.fn().mockResolvedValue([]),
      findOpenByPatient: jest.fn().mockResolvedValue(null),
      listForAdmin: jest.fn().mockResolvedValue([]),
      updateReview: jest.fn(async (id: string, data: Partial<DataDeletionRequestRow>) => requestRow({ id, ...data })),
      recordExecutionOutcome: jest.fn(async (id: string, data: Partial<DataDeletionRequestRow>) => requestRow({ id, ...data })),
    } as unknown as jest.Mocked<DataDeletionRepository>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    service = new DataDeletionService(db as unknown as Database, repo, audit);
  });

  /* ---------------------------------------------------------------------- */
  /* raiseRequest                                                            */
  /* ---------------------------------------------------------------------- */

  describe('raiseRequest', () => {
    it('creates a new request with status requested', async () => {
      const record = await service.raiseRequest(PATIENT_ID, 'Please delete my data.');

      expect(repo.create).toHaveBeenCalledWith({ patientId: PATIENT_ID, reason: 'Please delete my data.' }, db);
      expect(record.status).toBe('requested');
      expect(record.patientId).toBe(PATIENT_ID);
    });

    it('writes the creation audit entry inside the transaction', async () => {
      await service.raiseRequest(PATIENT_ID, null);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST }),
        db,
      );
    });

    /** No unique index backs this — it is an application-level guard, tested here rather than at the database. */
    it('returns the existing OPEN request instead of creating a second one', async () => {
      const open = requestRow({ status: 'in_review' });
      repo.findOpenByPatient.mockResolvedValueOnce(open);

      const record = await service.raiseRequest(PATIENT_ID, 'Another reason.');

      expect(record.id).toBe(open.id);
      expect(record.status).toBe('in_review');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('does not treat a DECIDED request (approved/rejected) as open', async () => {
      repo.findOpenByPatient.mockResolvedValueOnce(null); // the repo query itself excludes approved/rejected
      await service.raiseRequest(PATIENT_ID, 'A fresh request.');
      expect(repo.create).toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Patient reads                                                           */
  /* ---------------------------------------------------------------------- */

  describe('listOwnRequests / getOwnRequest', () => {
    it('lists the caller’s own requests', async () => {
      repo.listByPatient.mockResolvedValueOnce([requestRow(), requestRow({ id: 'r2', status: 'approved' })]);
      const records = await service.listOwnRequests(PATIENT_ID);
      expect(records).toHaveLength(2);
      expect(repo.listByPatient).toHaveBeenCalledWith(PATIENT_ID);
    });

    it('returns one of the caller’s own requests', async () => {
      const record = await service.getOwnRequest(PATIENT_ID, REQUEST_ID);
      expect(record.id).toBe(REQUEST_ID);
    });

    /** 404, never 403 — the same ownership discipline `booking.controller.ts` states for its own routes. */
    it('404s (not 403s) when the request belongs to a different patient', async () => {
      await expect(service.getOwnRequest(OTHER_PATIENT_ID, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getOwnRequest(OTHER_PATIENT_ID, REQUEST_ID)).rejects.toMatchObject({
        response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_REQUEST_NOT_FOUND },
      });
    });

    it('404s when the request does not exist at all', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.getOwnRequest(PATIENT_ID, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Admin reads                                                             */
  /* ---------------------------------------------------------------------- */

  describe('listForAdmin / getForAdmin', () => {
    it('forwards the status filter and pagination to the repository', async () => {
      await service.listForAdmin({ status: 'requested', limit: 10, offset: 0 });
      expect(repo.listForAdmin).toHaveBeenCalledWith({ status: 'requested', limit: 10, offset: 0 });
    });

    it('404s reading an admin detail that does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.getForAdmin('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* reviewRequest — the state machine                                      */
  /* ---------------------------------------------------------------------- */

  describe('reviewRequest', () => {
    it('moves requested -> in_review, recording the admin, the timestamp and the note', async () => {
      const record = await service.reviewRequest(ADMIN_ID, REQUEST_ID, {
        status: 'in_review',
        reviewNote: 'Looking into it.',
      });

      expect(repo.updateReview).toHaveBeenCalledWith(
        REQUEST_ID,
        expect.objectContaining({
          status: 'in_review',
          reviewedByAdminId: ADMIN_ID,
          reviewNote: 'Looking into it.',
          reviewedAt: expect.any(Date) as unknown as Date,
        }),
        db,
      );
      expect(record.status).toBe('in_review');
    });

    it('moves requested -> approved directly, without requiring in_review first', async () => {
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' });
      expect(repo.updateReview).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ status: 'approved' }), db);
    });

    it('moves in_review -> rejected', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'in_review' }));
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'rejected' });
      expect(repo.updateReview).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ status: 'rejected' }), db);
    });

    it('refuses to move a DECIDED request (approved) anywhere — that is terminal from this module’s side', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));

      const error = await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'in_review' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_ILLEGAL_TRANSITION } });
      expect(repo.updateReview).not.toHaveBeenCalled();
    });

    it('refuses to move a rejected request anywhere', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'rejected' }));
      await expect(service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s reviewing a request that does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.reviewRequest(ADMIN_ID, 'nope', { status: 'approved' })).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateReview).not.toHaveBeenCalled();
    });

    it('writes the review audit entry inside the transaction, naming the transition', async () => {
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved', reviewNote: 'Verified identity.' });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: REQUEST_ID,
          metadata: expect.objectContaining({ transition: { from: 'requested', to: 'approved' } }) as unknown,
        }),
        db,
      );
    });

    /**
     * *** THE BOUNDARY THE WHOLE MODULE EXISTS TO RESPECT. ***
     * `executed`/`failed` are not even expressible through
     * `ReviewDataDeletionRequestDto`'s `status` type at the API layer, and
     * this proves the SERVICE'S OWN type also cannot express them — a
     * TypeScript compile error, not a runtime refusal, is the enforcement
     * mechanism, which is stronger than a test can demonstrate by calling the
     * method. What this test can and does prove is the weaker, adjacent
     * claim: `reviewRequest` never writes `executedAt`/`executionOutcome`
     * under any successful path.
     */
    it('never writes executedAt or executionOutcome', async () => {
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' });

      const patch = repo.updateReview.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('executedAt');
      expect(patch).not.toHaveProperty('executionOutcome');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* findForExecution / recordExecutionOutcome — M-21 (data rights)         */
  /* ---------------------------------------------------------------------- */

  describe('findForExecution', () => {
    it('returns the record when it exists', async () => {
      const record = await service.findForExecution(REQUEST_ID);
      expect(record?.id).toBe(REQUEST_ID);
    });

    it('returns null (never throws) when the request does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.findForExecution('nope')).resolves.toBeNull();
    });
  });

  describe('recordExecutionOutcome', () => {
    it('writes executedAt/executionOutcome and the target status when the request is approved', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));

      const outcome = { tables: [{ table: 'patients', decision: 'anonymize', rowCount: 1 }] };
      const record = await service.recordExecutionOutcome(ADMIN_ID, REQUEST_ID, { status: 'executed', executionOutcome: outcome });

      expect(repo.recordExecutionOutcome).toHaveBeenCalledWith(
        REQUEST_ID,
        { status: 'executed', executionOutcome: outcome, executedAt: expect.any(Date) as unknown as Date },
        db,
      );
      expect(record.status).toBe('executed');
    });

    it('writes a failed outcome the same way', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ID, REQUEST_ID, { status: 'failed', executionOutcome: { reason: 'partial failure' } });
      expect(repo.recordExecutionOutcome).toHaveBeenCalledWith(
        REQUEST_ID,
        expect.objectContaining({ status: 'failed' }),
        db,
      );
    });

    it.each(['requested', 'in_review', 'rejected', 'executed', 'failed'] as const)(
      'refuses when the request is currently "%s", not approved',
      async (status) => {
        repo.findById.mockResolvedValue(requestRow({ status }));
        const error = await service
          .recordExecutionOutcome(ADMIN_ID, REQUEST_ID, { status: 'executed', executionOutcome: {} })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({ response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_APPROVED } });
        expect(repo.recordExecutionOutcome).not.toHaveBeenCalled();
      },
    );

    it('404s when the request does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(
        service.recordExecutionOutcome(ADMIN_ID, 'nope', { status: 'executed', executionOutcome: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes the execution audit entry inside the transaction, naming the transition', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ID, REQUEST_ID, { status: 'executed', executionOutcome: { ok: true } });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: REQUEST_ID,
          metadata: expect.objectContaining({ transition: { from: 'approved', to: 'executed' } }) as unknown,
        }),
        db,
      );
    });
  });
});
