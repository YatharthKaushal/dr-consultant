/**
 * `DataDeletionService` — FR-2.5: raising a data-deletion request (patient
 * OR doctor), its admin review, the account's own cancel, and the
 * grace-period sweep's own two entry points. `new DataDeletionService
 * (mockedDeps)` with hand-rolled `jest.fn()`s, never `Test.createTestingModule`.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DataDeletionRequestRow } from '../../schema/data-deletion-requests.schema';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { DataDeletionNotificationPort } from './data-deletion-notification.contract';
import { DATA_DELETION_AUDIT_ENTITY_TYPES, DATA_DELETION_ERROR_CODES, DATA_DELETION_NOTIFICATION_TEMPLATES } from './data-deletion.constants';
import type { DataDeletionRepository } from './data-deletion.repository';
import { DataDeletionService } from './data-deletion.service';
import type { DeletionAccountRef } from './data-deletion.types';

const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';
const OTHER_PATIENT_ID = 'p0000000-0000-4000-8000-000000000002';
const DOCTOR_ID = 'd0000000-0000-4000-8000-000000000001';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'r0000000-0000-4000-8000-000000000001';

const PATIENT: DeletionAccountRef = { accountType: 'patient', accountId: PATIENT_ID };
const OTHER_PATIENT: DeletionAccountRef = { accountType: 'patient', accountId: OTHER_PATIENT_ID };
const DOCTOR: DeletionAccountRef = { accountType: 'doctor', accountId: DOCTOR_ID };

function requestRow(overrides: Partial<DataDeletionRequestRow> = {}): DataDeletionRequestRow {
  return {
    id: REQUEST_ID,
    patientId: PATIENT_ID,
    doctorId: null,
    status: 'requested',
    reason: 'Closing my account.',
    reviewedByAdminId: null,
    reviewedAt: null,
    reviewNote: null,
    executionOutcome: null,
    executedAt: null,
    scheduledFor: new Date('2026-10-01T09:00:00.000Z'),
    cancelledAt: null,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    ...overrides,
  } as DataDeletionRequestRow;
}

describe('DataDeletionService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<DataDeletionRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
  let notifications: jest.Mocked<DataDeletionNotificationPort>;
  let service: DataDeletionService;

  beforeEach(() => {
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      create: jest.fn(async (data: Partial<DataDeletionRequestRow>) => requestRow(data)),
      findById: jest.fn().mockResolvedValue(requestRow()),
      listByAccount: jest.fn().mockResolvedValue([]),
      findOpenByAccount: jest.fn().mockResolvedValue(null),
      listForAdmin: jest.fn().mockResolvedValue([]),
      updateReview: jest.fn(async (id: string, data: Partial<DataDeletionRequestRow>) => requestRow({ id, ...data })),
      cancel: jest.fn(async (id: string, cancelledAt: Date) => requestRow({ id, status: 'cancelled', cancelledAt })),
      autoApprove: jest.fn(async (id: string, reviewedAt: Date) => requestRow({ id, status: 'approved', reviewedAt })),
      recordExecutionOutcome: jest.fn(async (id: string, data: Partial<DataDeletionRequestRow>) => requestRow({ id, ...data })),
      listDueForSweep: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DataDeletionRepository>;

    appConfig = { getNumber: jest.fn().mockResolvedValue(30), getJson: jest.fn() } as unknown as jest.Mocked<AppConfigService>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    // ADDITIVE (notify-on-status-change round).
    notifications = {
      notify: jest.fn().mockResolvedValue({ queued: false, notificationId: null, reason: 'template_missing' }),
    } as unknown as jest.Mocked<DataDeletionNotificationPort>;

    service = new DataDeletionService(db as unknown as Database, repo, appConfig, audit, notifications);
  });

  /* ---------------------------------------------------------------------- */
  /* raiseRequest                                                            */
  /* ---------------------------------------------------------------------- */

  describe('raiseRequest', () => {
    it('creates a new patient request with status requested and a scheduledFor from the grace period', async () => {
      const record = await service.raiseRequest(PATIENT, 'Please delete my data.');

      expect(repo.create).toHaveBeenCalledWith(
        { patientId: PATIENT_ID, doctorId: null, reason: 'Please delete my data.', scheduledFor: expect.any(Date) as unknown as Date },
        db,
      );
      expect(record.status).toBe('requested');
      expect(record.patientId).toBe(PATIENT_ID);
      expect(record.doctorId).toBeNull();
    });

    it('creates a new DOCTOR request the same way, on doctorId not patientId', async () => {
      await service.raiseRequest(DOCTOR, null);
      expect(repo.create).toHaveBeenCalledWith(
        { patientId: null, doctorId: DOCTOR_ID, reason: null, scheduledFor: expect.any(Date) as unknown as Date },
        db,
      );
    });

    it('reads compliance.deletion_grace_period_days for the scheduledFor computation', async () => {
      appConfig.getNumber.mockResolvedValueOnce(7);
      const before = Date.now();
      const record = await service.raiseRequest(PATIENT, null);
      const scheduledFor = new Date(record.scheduledFor as string).getTime();
      expect(scheduledFor).toBeGreaterThanOrEqual(before + 6 * 24 * 60 * 60 * 1000);
      expect(scheduledFor).toBeLessThanOrEqual(before + 8 * 24 * 60 * 60 * 1000);
    });

    it('writes the creation audit entry inside the transaction, attributed to the requesting account', async () => {
      await service.raiseRequest(PATIENT, null);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'patient', actorId: PATIENT_ID, action: 'create', entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST }),
        db,
      );
    });

    /** No unique index backs the friendly-return half of this — it is an application-level convenience; the database's own partial unique index is the actual race guard, proven at the integration level. */
    it('returns the existing OPEN request instead of creating a second one', async () => {
      const open = requestRow({ status: 'in_review' });
      repo.findOpenByAccount.mockResolvedValueOnce(open);

      const record = await service.raiseRequest(PATIENT, 'Another reason.');

      expect(record.id).toBe(open.id);
      expect(record.status).toBe('in_review');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('does not treat a DECIDED request (approved/rejected/cancelled) as open', async () => {
      repo.findOpenByAccount.mockResolvedValueOnce(null); // the repo query itself excludes decided requests
      await service.raiseRequest(PATIENT, 'A fresh request.');
      expect(repo.create).toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Patient/doctor reads and cancel                                         */
  /* ---------------------------------------------------------------------- */

  describe('listOwnRequests / getOwnRequest', () => {
    it('lists the caller’s own requests', async () => {
      repo.listByAccount.mockResolvedValueOnce([requestRow(), requestRow({ id: 'r2', status: 'approved' })]);
      const records = await service.listOwnRequests(PATIENT);
      expect(records).toHaveLength(2);
      expect(repo.listByAccount).toHaveBeenCalledWith('patient', PATIENT_ID);
    });

    it('returns one of the caller’s own requests', async () => {
      const record = await service.getOwnRequest(PATIENT, REQUEST_ID);
      expect(record.id).toBe(REQUEST_ID);
    });

    /** 404, never 403 — the same ownership discipline `booking.controller.ts` states for its own routes. */
    it('404s (not 403s) when the request belongs to a different patient', async () => {
      await expect(service.getOwnRequest(OTHER_PATIENT, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getOwnRequest(OTHER_PATIENT, REQUEST_ID)).rejects.toMatchObject({
        response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_REQUEST_NOT_FOUND },
      });
    });

    it('404s when a DOCTOR reads a PATIENT’s request — accountType, not just accountId, must match', async () => {
      await expect(service.getOwnRequest(DOCTOR, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the request does not exist at all', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.getOwnRequest(PATIENT, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancelRequest — the "cancel deletion" option', () => {
    it('cancels a requested request and audits it, attributed to the account itself', async () => {
      const record = await service.cancelRequest(PATIENT, REQUEST_ID);

      expect(repo.cancel).toHaveBeenCalledWith(REQUEST_ID, expect.any(Date), db);
      expect(record.status).toBe('cancelled');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'patient', actorId: PATIENT_ID, action: 'update', metadata: expect.objectContaining({ transition: { from: 'requested', to: 'cancelled' } }) as unknown }),
        db,
      );
    });

    it.each(['requested', 'in_review', 'approved'] as const)('cancels from "%s"', async (status) => {
      repo.findById.mockResolvedValue(requestRow({ status }));
      await service.cancelRequest(PATIENT, REQUEST_ID);
      expect(repo.cancel).toHaveBeenCalled();
    });

    it.each(['rejected', 'cancelled', 'executed', 'failed'] as const)('refuses to cancel a terminal "%s" request', async (status) => {
      repo.findById.mockResolvedValue(requestRow({ status }));
      const error = await service.cancelRequest(PATIENT, REQUEST_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_CANCELLABLE } });
      expect(repo.cancel).not.toHaveBeenCalled();
    });

    it('404s (not 403s) cancelling someone else’s request', async () => {
      await expect(service.cancelRequest(OTHER_PATIENT, REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.cancel).not.toHaveBeenCalled();
    });

    it('reports the race loser honestly — repo.cancel returning null becomes a conflict, not a silent success', async () => {
      repo.cancel.mockResolvedValueOnce(null);
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'requested' })).mockResolvedValueOnce(requestRow({ status: 'executed' }));
      await expect(service.cancelRequest(PATIENT, REQUEST_ID)).rejects.toMatchObject({
        response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_CANCELLABLE, currentStatus: 'executed' },
      });
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
  /* reviewRequest — the state machine, including the failed -> approved retry */
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

    /** *** THE RETRY PATH (account-deletion lifecycle round). *** A partial execution failure used to be a dead end. */
    it('moves failed -> approved — the retry path for a partial execution failure', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'failed' }));
      const record = await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved', reviewNote: 'Retrying.' });
      expect(record.status).toBe('approved');
      expect(repo.updateReview).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ status: 'approved' }), db);
    });

    it('refuses to move failed to anything other than approved', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'failed' }));
      await expect(service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'rejected' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to move a DECIDED request (approved) anywhere — that is terminal from this module’s side', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));

      const error = await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'in_review' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_ILLEGAL_TRANSITION } });
      expect(repo.updateReview).not.toHaveBeenCalled();
    });

    it('refuses to move a rejected or cancelled request anywhere', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'rejected' }));
      await expect(service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' })).rejects.toBeInstanceOf(ConflictException);

      repo.findById.mockResolvedValueOnce(requestRow({ status: 'cancelled' }));
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

    it('never writes executedAt or executionOutcome', async () => {
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' });

      const patch = repo.updateReview.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('executedAt');
      expect(patch).not.toHaveProperty('executionOutcome');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* The sweep's own two entry points                                        */
  /* ---------------------------------------------------------------------- */

  describe('listDueForSweep', () => {
    it('reads through to the repository with the current time', async () => {
      repo.listDueForSweep.mockResolvedValueOnce([requestRow()]);
      const records = await service.listDueForSweep(50);
      expect(records).toHaveLength(1);
      expect(repo.listDueForSweep).toHaveBeenCalledWith(expect.any(Date), 50);
    });
  });

  describe('autoApproveForSweep', () => {
    it('approves without a reviewedByAdminId, and audits actorType system / actorId null', async () => {
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'requested' }));
      const record = await service.autoApproveForSweep(REQUEST_ID);

      expect(record.status).toBe('approved');
      expect(repo.autoApprove).toHaveBeenCalledWith(REQUEST_ID, expect.any(Date), db);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'system', actorId: null, metadata: expect.objectContaining({ reason: 'grace_period_elapsed_no_admin_review' }) as unknown }),
        db,
      );
    });

    it('is a no-op returning the current row when the request already moved past requested/in_review', async () => {
      repo.autoApprove.mockResolvedValueOnce(null);
      // The guarded UPDATE matched zero rows (status is no longer
      // requested/in_review); the method re-reads once, inside the `!updated`
      // branch, to report what the request actually is now.
      repo.findById.mockResolvedValueOnce(requestRow({ status: 'approved' }));

      const record = await service.autoApproveForSweep(REQUEST_ID);
      expect(record.status).toBe('approved');
      expect(audit.write).not.toHaveBeenCalled();
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
    const ADMIN_ACTOR = { actorType: 'admin' as const, actorId: ADMIN_ID };
    const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null };

    it('writes executedAt/executionOutcome and the target status when the request is approved', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));

      const outcome = { tables: [{ table: 'patients', decision: 'soft_delete', rowCount: 1 }] };
      const record = await service.recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'executed', executionOutcome: outcome });

      expect(repo.recordExecutionOutcome).toHaveBeenCalledWith(
        REQUEST_ID,
        { status: 'executed', executionOutcome: outcome, executedAt: expect.any(Date) as unknown as Date },
        db,
      );
      expect(record.status).toBe('executed');
    });

    it('attributes a sweep-driven execution to actorType system, actorId null — never a fabricated admin', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(SYSTEM_ACTOR, REQUEST_ID, { status: 'executed', executionOutcome: {} });
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'system', actorId: null }), db);
    });

    it('writes a failed outcome the same way', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'failed', executionOutcome: { reason: 'partial failure' } });
      expect(repo.recordExecutionOutcome).toHaveBeenCalledWith(
        REQUEST_ID,
        expect.objectContaining({ status: 'failed' }),
        db,
      );
    });

    it.each(['requested', 'in_review', 'rejected', 'cancelled', 'executed', 'failed'] as const)(
      'refuses when the request is currently "%s", not approved',
      async (status) => {
        repo.findById.mockResolvedValue(requestRow({ status }));
        const error = await service
          .recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'executed', executionOutcome: {} })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({ response: { code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_APPROVED } });
        expect(repo.recordExecutionOutcome).not.toHaveBeenCalled();
      },
    );

    it('404s when the request does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(
        service.recordExecutionOutcome(ADMIN_ACTOR, 'nope', { status: 'executed', executionOutcome: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes the execution audit entry inside the transaction, naming the transition', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'executed', executionOutcome: { ok: true } });

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

  /**
   * ADDITIVE (notify-on-status-change round). Proves the WIRING itself —
   * every other describe block above already exercises these methods
   * without asserting on `notifications.notify`, and `notifications` degrades
   * gracefully by default (`template_missing`), so those tests would keep
   * passing even if a call site were silently dropped. These don't.
   */
  describe('notifications', () => {
    const ADMIN_ACTOR = { actorType: 'admin' as const, actorId: ADMIN_ID };

    it('raiseRequest notifies the requester with the scheduledFor date', async () => {
      await service.raiseRequest(PATIENT, 'Closing my account.');

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.REQUESTED,
          audience: { kind: 'patient', id: PATIENT_ID },
          variables: { scheduledFor: expect.any(String) as unknown },
        }),
      );
    });

    it('raiseRequest does NOT notify again when it returns an existing open request', async () => {
      repo.findOpenByAccount.mockResolvedValue(requestRow());
      await service.raiseRequest(PATIENT, 'Closing my account.');
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('cancelRequest notifies the requester', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'requested' }));
      await service.cancelRequest(PATIENT, REQUEST_ID);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.CANCELLED, audience: { kind: 'patient', id: PATIENT_ID } }),
      );
    });

    it('reviewRequest(approved) notifies the requester, DOCTOR audience when it is a doctor request', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'requested', patientId: null, doctorId: DOCTOR_ID }));
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'approved' });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.APPROVED, audience: { kind: 'doctor', id: DOCTOR_ID } }),
      );
    });

    it('reviewRequest(rejected) notifies the requester', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'requested' }));
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'rejected' });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.REJECTED, audience: { kind: 'patient', id: PATIENT_ID } }),
      );
    });

    it('reviewRequest(in_review) does NOT notify — not a decision yet', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'requested' }));
      await service.reviewRequest(ADMIN_ID, REQUEST_ID, { status: 'in_review' });
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('autoApproveForSweep notifies on a real transition', async () => {
      repo.autoApprove.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.autoApproveForSweep(REQUEST_ID);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.APPROVED, audience: { kind: 'patient', id: PATIENT_ID } }),
      );
    });

    it('autoApproveForSweep does NOT notify on the idempotent no-op branch', async () => {
      repo.autoApprove.mockResolvedValue(null);
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.autoApproveForSweep(REQUEST_ID);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('recordExecutionOutcome(executed) notifies the requester', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'executed', executionOutcome: {} });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: DATA_DELETION_NOTIFICATION_TEMPLATES.EXECUTED, audience: { kind: 'patient', id: PATIENT_ID } }),
      );
    });

    it('recordExecutionOutcome(failed) does NOT notify — internal-only, an admin retries via reviewRequest instead', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'approved' }));
      await service.recordExecutionOutcome(ADMIN_ACTOR, REQUEST_ID, { status: 'failed', executionOutcome: {} });
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('a notify() throw is swallowed, never fails the caller', async () => {
      repo.findById.mockResolvedValue(requestRow({ status: 'requested' }));
      notifications.notify.mockRejectedValueOnce(new Error('provider exploded'));
      await expect(service.cancelRequest(PATIENT, REQUEST_ID)).resolves.toMatchObject({ status: 'cancelled' });
    });
  });
});
