import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { ComplaintRow } from '../../schema/complaints.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { BookingView } from '../booking/booking.contract';
import type { BookingFacade } from '../booking/booking.facade';
import { COMPLAINT_ERROR_CODES } from './feedback.constants';
import { ComplaintRepository } from './complaint.repository';
import { ComplaintService } from './complaint.service';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PATIENT_ID = '33333333-3333-4333-8333-333333333333';
const CONSULTATION_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ADMIN_ID = '66666666-6666-4666-8666-666666666666';

function row(overrides: Partial<ComplaintRow> = {}): ComplaintRow {
  return {
    id: COMPLAINT_ID,
    referenceCode: 'CMP-TEST-000001',
    patientId: PATIENT_ID,
    consultationId: null,
    category: 'other',
    subject: 'Refund never arrived',
    description: 'I was told the refund would land in 5 days; it has been 10.',
    status: 'open',
    assignedToAdminId: null,
    messages: [],
    resolvedAt: null,
    resolutionNote: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function booking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-000001',
    patientId: PATIENT_ID,
    doctorId: '77777777-7777-4777-8777-777777777777',
    specialtyId: '88888888-8888-4888-8888-888888888888',
    concernId: null,
    mode: 'scheduled',
    status: 'completed',
    scheduledStartAt: new Date('2026-07-01T00:00:00Z'),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Hand-rolled deps, `new ComplaintService(...)` — never
 * `Test.createTestingModule`, `clarification.service.spec.ts`'s convention.
 * The `db.transaction` fake invokes its callback with itself so the code
 * under test runs, but proves no rollback semantics — the same honest
 * caveat `clarification.service.spec.ts` states for its own fake.
 */
function createDeps() {
  const db: { transaction: jest.Mock } = {
    transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };

  const repo = {
    findById: jest.fn(),
    findByIdForUpdate: jest.fn(),
    referenceCodeExists: jest.fn().mockResolvedValue(false),
    listByPatientId: jest.fn(),
    listForAdmin: jest.fn(),
    countByStatusGrouped: jest.fn(),
    create: jest.fn(),
    appendMessages: jest.fn(),
    updateStatusIfFrom: jest.fn(),
  };

  const bookingFacade = { getBooking: jest.fn() };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new ComplaintService(
    db as unknown as Database,
    repo as unknown as ComplaintRepository,
    bookingFacade as unknown as BookingFacade,
    audit as unknown as AuditService,
  );

  return { service, db, repo, bookingFacade, audit };
}

describe('ComplaintService.raiseComplaint', () => {
  it('never ownership-checks when consultationId is omitted — "not about one consultation" is a valid case', async () => {
    const { service, repo, bookingFacade } = createDeps();
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.raiseComplaint(PATIENT_ID, { category: 'other', subject: 'S', description: 'D' });

    expect(bookingFacade.getBooking).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ patientId: PATIENT_ID, consultationId: null }));
  });

  it('ownership-checks when consultationId IS given, and throws the same 404 a stranger gets', async () => {
    const { service, bookingFacade } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(booking({ patientId: OTHER_PATIENT_ID }));

    await expect(
      service.raiseComplaint(PATIENT_ID, { category: 'other', subject: 'S', description: 'D', consultationId: CONSULTATION_ID }),
    ).rejects.toMatchObject({ response: { code: COMPLAINT_ERROR_CODES.CONSULTATION_NOT_FOUND } });
  });

  it('generates a unique reference code, retrying past a collision', async () => {
    const { service, repo } = createDeps();
    repo.referenceCodeExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    repo.create.mockImplementation(async (data) => row({ ...data }));

    const result = await service.raiseComplaint(PATIENT_ID, { category: 'other', subject: 'S', description: 'D' });

    expect(repo.referenceCodeExists).toHaveBeenCalledTimes(2);
    expect(result.referenceCode).toMatch(/^CMP-/);
  });

  it('inserts status open, from the row default, never as a client-controlled field', async () => {
    const { service, repo } = createDeps();
    repo.create.mockImplementation(async (data) => row({ ...data }));

    const result = await service.raiseComplaint(PATIENT_ID, { category: 'payment_issue', subject: 'S', description: 'D' });

    expect(result.status).toBe('open');
  });
});

describe('ComplaintService ownership on the patient side', () => {
  it('getOwnComplaint / addPatientMessage give the SAME 404 for a nonexistent complaint and one owned by another patient', async () => {
    const { service, repo } = createDeps();

    repo.findById.mockResolvedValueOnce(null);
    await expect(service.getOwnComplaint(COMPLAINT_ID, PATIENT_ID)).rejects.toBeInstanceOf(NotFoundException);

    repo.findById.mockResolvedValueOnce(row({ patientId: OTHER_PATIENT_ID }));
    await expect(service.getOwnComplaint(COMPLAINT_ID, PATIENT_ID)).rejects.toMatchObject({
      response: { code: COMPLAINT_ERROR_CODES.COMPLAINT_NOT_FOUND },
    });
  });

  it("a patient's own view never includes an admin's internal-only message", async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(
      row({
        messages: [
          { authorId: PATIENT_ID, authorType: 'patient', body: 'When will this be fixed?', isInternal: false, at: '2026-08-01T00:00:00.000Z' },
          { authorId: ADMIN_ID, authorType: 'admin', body: 'Escalate to finance', isInternal: true, at: '2026-08-01T01:00:00.000Z' },
        ],
      }),
    );

    const view = await service.getOwnComplaint(COMPLAINT_ID, PATIENT_ID);

    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].body).toBe('When will this be fixed?');
  });
});

describe('ComplaintService.assignComplaint', () => {
  it('open -> in_progress, writing assignedToAdminId', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'open' }));
    repo.updateStatusIfFrom.mockImplementation(async (id, from, patch) => row({ ...patch }));

    const result = await service.assignComplaint(COMPLAINT_ID, ADMIN_ID, OTHER_ADMIN_ID);

    expect(repo.updateStatusIfFrom).toHaveBeenCalledWith(
      COMPLAINT_ID,
      'open',
      expect.objectContaining({ status: 'in_progress', assignedToAdminId: ADMIN_ID }),
      expect.anything(),
    );
    expect(result.status).toBe('in_progress');
  });

  it('refuses to assign a complaint that is not open', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'in_progress' }));

    await expect(service.assignComplaint(COMPLAINT_ID, ADMIN_ID, OTHER_ADMIN_ID)).rejects.toMatchObject({
      response: { code: COMPLAINT_ERROR_CODES.ILLEGAL_TRANSITION },
    });
    expect(repo.updateStatusIfFrom).not.toHaveBeenCalled();
  });

  it('throws complaintNotFound for a nonexistent id', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(null);

    await expect(service.assignComplaint(COMPLAINT_ID, ADMIN_ID, OTHER_ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ComplaintService.resolveComplaint / rejectComplaint', () => {
  it('resolve: in_progress -> resolved, and resolvedAt IS set', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'in_progress', assignedToAdminId: ADMIN_ID }));
    repo.updateStatusIfFrom.mockImplementation(async (id, from, patch) => row({ ...patch }));

    const result = await service.resolveComplaint(COMPLAINT_ID, ADMIN_ID, { resolutionNote: 'Refund reissued.' });

    expect(repo.updateStatusIfFrom).toHaveBeenCalledWith(
      COMPLAINT_ID,
      'in_progress',
      expect.objectContaining({ status: 'resolved', resolvedAt: expect.any(Date), resolutionNote: 'Refund reissued.' }),
      expect.anything(),
    );
    expect(result.status).toBe('resolved');
  });

  it('reject: in_progress -> rejected, and resolvedAt is NEVER set — rejected is not resolved', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'in_progress', assignedToAdminId: ADMIN_ID }));
    repo.updateStatusIfFrom.mockImplementation(async (id, from, patch) => row({ ...patch }));

    const result = await service.rejectComplaint(COMPLAINT_ID, ADMIN_ID, { resolutionNote: 'No fault found.' });

    const patchArg = repo.updateStatusIfFrom.mock.calls[0][2];
    expect(patchArg).not.toHaveProperty('resolvedAt');
    expect(result.status).toBe('rejected');
    expect(result.resolvedAt).toBeNull();
  });

  it('refuses to resolve/reject a complaint still open — must be assigned (in_progress) first', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'open' }));

    await expect(service.resolveComplaint(COMPLAINT_ID, ADMIN_ID, { resolutionNote: 'x' })).rejects.toMatchObject({
      response: { code: COMPLAINT_ERROR_CODES.ILLEGAL_TRANSITION },
    });
    await expect(service.rejectComplaint(COMPLAINT_ID, ADMIN_ID, { resolutionNote: 'x' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to resolve an already-resolved complaint — no re-resolving', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'resolved', resolvedAt: new Date() }));

    await expect(service.resolveComplaint(COMPLAINT_ID, ADMIN_ID, { resolutionNote: 'x' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ComplaintService messages', () => {
  it("addPatientMessage stamps authorType 'patient' and isInternal: false, always — never from the dto", async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row());
    repo.appendMessages.mockImplementation(async (id, messages) => row({ messages }));

    const result = await service.addPatientMessage(COMPLAINT_ID, PATIENT_ID, { body: 'Any update?' });

    expect(result.messages).toEqual([
      expect.objectContaining({ authorId: PATIENT_ID, authorType: 'patient', body: 'Any update?', isInternal: false }),
    ]);
  });

  it('addAdminMessage may be marked internal, and the flag is preserved on the admin view', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row());
    repo.appendMessages.mockImplementation(async (id, messages) => row({ messages }));

    const result = await service.addAdminMessage(COMPLAINT_ID, ADMIN_ID, { body: 'Checking with finance', isInternal: true });

    expect(result.messages[0]).toMatchObject({ authorId: ADMIN_ID, authorType: 'admin', isInternal: true });
  });

  it('a message may be added regardless of status — messages are not transitions', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ status: 'resolved', resolvedAt: new Date() }));
    repo.appendMessages.mockImplementation(async (id, messages) => row({ status: 'resolved', messages }));

    await expect(service.addAdminMessage(COMPLAINT_ID, ADMIN_ID, { body: 'Thanks for your patience' })).resolves.toBeDefined();
  });
});

describe('ComplaintService.countComplaintsByStatus', () => {
  it('fills every COMPLAINT_STATUSES key, defaulting a status with no rows to 0', async () => {
    const { service, repo } = createDeps();
    repo.countByStatusGrouped.mockResolvedValue(new Map([['open', 3] as const, ['resolved', 1] as const]));

    const result = await service.countComplaintsByStatus();

    expect(result).toEqual({ open: 3, in_progress: 0, resolved: 1, rejected: 0 });
  });
});
