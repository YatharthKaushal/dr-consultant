import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BookingView } from '../booking/booking.contract';
import type { BookingFacade } from '../booking/booking.facade';
import type { AuditService } from '../../shared/audit/audit.service';
import type { FeedbackRow } from '../../schema/feedback.schema';
import { FEEDBACK_ERROR_CODES } from './feedback.constants';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PATIENT_ID = '33333333-3333-4333-8333-333333333333';
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444';

function booking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-000001',
    patientId: PATIENT_ID,
    doctorId: '55555555-5555-4555-8555-555555555555',
    specialtyId: '66666666-6666-4666-8666-666666666666',
    concernId: null,
    mode: 'scheduled',
    status: 'completed',
    scheduledStartAt: new Date('2026-08-01T00:00:00Z'),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function row(overrides: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: FEEDBACK_ID,
    consultationId: CONSULTATION_ID,
    patientId: PATIENT_ID,
    rating: 5,
    comment: 'Great consult.',
    createdAt: new Date('2026-08-01T01:00:00Z'),
    ...overrides,
  };
}

/** Hand-rolled deps, `new FeedbackService(...)` — never `Test.createTestingModule`, `clarification.service.spec.ts`'s convention. */
function createDeps() {
  const repo = { findByConsultationId: jest.fn(), create: jest.fn(), listForAdmin: jest.fn(), countByPatientId: jest.fn() };
  const booking = { getBooking: jest.fn() };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new FeedbackService(
    repo as unknown as FeedbackRepository,
    booking as unknown as BookingFacade,
    audit as unknown as AuditService,
  );

  return { service, repo, booking, audit };
}

describe('FeedbackService.submitFeedback', () => {
  it('accepts patientId as a parameter, never reads it from the dto', async () => {
    const { service, repo, booking } = createDeps();
    booking.getBooking.mockResolvedValue(bookingOf());
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 4 });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ patientId: PATIENT_ID, consultationId: CONSULTATION_ID }));
  });

  it('throws the SAME 404 for a consultation that does not exist and one owned by another patient', async () => {
    const { service, booking: bookingFacade } = createDeps();

    bookingFacade.getBooking.mockResolvedValueOnce(null);
    await expect(service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 3 })).rejects.toMatchObject({
      response: { code: FEEDBACK_ERROR_CODES.CONSULTATION_NOT_FOUND },
    });

    bookingFacade.getBooking.mockResolvedValueOnce(bookingOf({ patientId: OTHER_PATIENT_ID }));
    await expect(service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 3 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('translates a UNIQUE(consultation_id) collision into a clean 409, not a 500', async () => {
    const { service, repo, booking: bookingFacade } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(bookingOf());
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    repo.create.mockRejectedValue(uniqueViolation);

    await expect(service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 2 })).rejects.toMatchObject({
      response: { code: FEEDBACK_ERROR_CODES.ALREADY_SUBMITTED },
    });
    await expect(service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows any other database error unchanged', async () => {
    const { service, repo, booking: bookingFacade } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(bookingOf());
    const otherError = new Error('connection reset');
    repo.create.mockRejectedValue(otherError);

    await expect(service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 2 })).rejects.toBe(otherError);
  });

  it('writes an audit entry on success', async () => {
    const { service, repo, booking: bookingFacade, audit } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(bookingOf());
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.submitFeedback(CONSULTATION_ID, PATIENT_ID, { rating: 5, comment: 'Loved it' });

    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'patient', actorId: PATIENT_ID, action: 'create', consultationId: CONSULTATION_ID }),
    );
  });

  function bookingOf(overrides: Partial<BookingView> = {}) {
    return booking(overrides);
  }
});

describe('FeedbackService.getOwnFeedback', () => {
  it('returns null (not a 404) when the patient owns the consultation but has not submitted yet', async () => {
    const { service, repo, booking: bookingFacade } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(booking());
    repo.findByConsultationId.mockResolvedValue(null);

    await expect(service.getOwnFeedback(CONSULTATION_ID, PATIENT_ID)).resolves.toBeNull();
  });

  it('throws the ownership 404 for a stranger', async () => {
    const { service, booking: bookingFacade } = createDeps();
    bookingFacade.getBooking.mockResolvedValue(booking({ patientId: OTHER_PATIENT_ID }));

    await expect(service.getOwnFeedback(CONSULTATION_ID, PATIENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FeedbackService.listForAdmin', () => {
  it('is unconditional — no ownership check, forwards the filter as given', async () => {
    const { service, repo } = createDeps();
    repo.listForAdmin.mockResolvedValue([row()]);

    const result = await service.listForAdmin({ rating: 5, limit: 10, offset: 0 });

    expect(repo.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ rating: 5, limit: 10, offset: 0 }));
    expect(result).toHaveLength(1);
  });
});

describe('FeedbackService.countByPatientId', () => {
  it('delegates to the repository', async () => {
    const { service, repo } = createDeps();
    repo.countByPatientId.mockResolvedValue(3);

    await expect(service.countByPatientId(PATIENT_ID)).resolves.toBe(3);
    expect(repo.countByPatientId).toHaveBeenCalledWith(PATIENT_ID);
  });
});
