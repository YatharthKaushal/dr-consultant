import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BookingFacade } from '../booking/booking.facade';
import type { CareHubFacade } from '../carehub/carehub.facade';
import type { ClarificationFacade } from '../clarification/clarification.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import type { DataDeletionRequestRecord } from '../consent/data-deletion.types';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { DocumentFacade } from '../document/document.facade';
import type { FeedbackFacade } from '../feedback/feedback.facade';
import type { FollowupFacade } from '../followup/followup.facade';
import type { InstantFacade } from '../instant/instant.facade';
import type { NotificationFacade } from '../notification/notification.facade';
import type { PatientFacade } from '../patient/patient.facade';
import type { PaymentFacade } from '../payment/payment.facade';
import type { PricingFacade } from '../pricing/pricing.facade';
import type { PromotionFacade } from '../promotion/promotion.facade';
import type { SearchFacade } from '../search/search.facade';
import type { VideoFacade } from '../video/video.facade';
import { DataRightsService } from './data-rights.service';
import type { DeletedAccountsService } from './deleted-accounts.service';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_ID = '22222222-2222-4222-8222-222222222222';
const DOCTOR_ID = '55555555-5555-4555-8555-555555555555';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CONSULTATION_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ACTOR = { actorType: 'admin' as const, actorId: ADMIN_ID };
const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null };

function request(overrides: Partial<DataDeletionRequestRecord> = {}): DataDeletionRequestRecord {
  return {
    id: REQUEST_ID,
    patientId: PATIENT_ID,
    doctorId: null,
    status: 'approved',
    reason: null,
    reviewedByAdminId: ADMIN_ID,
    reviewedAt: new Date().toISOString(),
    reviewNote: null,
    executedAt: null,
    executionOutcome: null,
    scheduledFor: new Date().toISOString(),
    cancelledAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Hand-rolled `jest.fn()` collaborators for every facade — never `Test.createTestingModule`. */
function createDeps() {
  const deletionRequests = {
    getRequest: jest.fn().mockResolvedValue(request()),
    recordExecutionOutcome: jest.fn(),
    countConsentsForPatient: jest.fn().mockResolvedValue(0),
    listDueForSweep: jest.fn().mockResolvedValue([]),
    autoApproveForSweep: jest.fn(),
  } as unknown as jest.Mocked<DataDeletionExecutionFacade>;

  const booking = {
    listConsultationIdsForPatient: jest.fn().mockResolvedValue([CONSULTATION_ID]),
    // ADDITIVE (open-obligations round). Default: a single TERMINAL
    // consultation, so every EXISTING test in this file (none of which are
    // about the obligations gate) keeps exercising a clean execute path
    // unchanged. Tests of the gate itself override this per-case.
    listConsultationIdsForDoctor: jest.fn().mockResolvedValue([]),
    getBooking: jest.fn().mockResolvedValue({ id: CONSULTATION_ID, status: 'completed', scheduledStartAt: null }),
  } as unknown as jest.Mocked<BookingFacade>;

  const clinical = { countRecordsForConsultations: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<ClinicalFacade>;
  const followup = {
    countDataRightsRowsForConsultations: jest
      .fn()
      .mockResolvedValue({ checkinResponses: 0, safetyAlerts: 0, followupAssignments: 0 }),
  } as unknown as jest.Mocked<FollowupFacade>;
  const video = { countParticipantRowsForConsultations: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<VideoFacade>;
  const document = {
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({ patientFiles: 0, reportRequests: 0 }),
  } as unknown as jest.Mocked<DocumentFacade>;
  const clarification = { countCasesForConsultations: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<ClarificationFacade>;
  const instant = { countOffersForConsultations: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<InstantFacade>;
  const carehub = { countRecommendationsForConsultations: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<CareHubFacade>;
  const feedback = {
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({ feedback: 0, complaints: 0 }),
  } as unknown as jest.Mocked<FeedbackFacade>;
  const notification = { countNotificationsForPatient: jest.fn().mockResolvedValue(0) } as unknown as jest.Mocked<NotificationFacade>;
  const search = {
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({ searchQueries: 0, searchRateLimits: 0 }),
    deleteSearchQueriesForPatient: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  } as unknown as jest.Mocked<SearchFacade>;
  const promotion = {
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({
      discountInstruments: 0,
      discountRedemptions: 0,
      affiliateAttributions: 0,
      affiliateCommissions: 0,
      referralEvents: 0,
      promotionCodeAttempts: 0,
    }),
    anonymizePromotionCodeAttemptsForPatient: jest.fn().mockResolvedValue({ anonymizedCount: 0 }),
  } as unknown as jest.Mocked<PromotionFacade>;
  const pricing = {
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({ priceQuotes: 0, priceQuoteComponents: 0, refundComponents: 0 }),
  } as unknown as jest.Mocked<PricingFacade>;
  const payment = {
    countDataRightsRowsForConsultations: jest.fn().mockResolvedValue({ payments: 0, refunds: 0, paymentEvents: 0 }),
    getByConsultationId: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<PaymentFacade>;
  const patient = {
    softDeleteForDeletionRequest: jest.fn().mockResolvedValue({ softDeleted: true, snapshot: { id: PATIENT_ID }, originalMobileNumber: '+919876543210' }),
  } as unknown as jest.Mocked<PatientFacade>;
  const doctor = {
    softDeleteForDeletionRequest: jest.fn().mockResolvedValue({ softDeleted: true, snapshot: { id: DOCTOR_ID }, originalMobileNumber: '+911234567890' }),
  } as unknown as jest.Mocked<DoctorFacade>;
  const deletedAccounts = {
    recordSnapshot: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DeletedAccountsService>;

  const service = new DataRightsService(
    deletionRequests,
    booking,
    clinical,
    followup,
    video,
    document,
    clarification,
    instant,
    carehub,
    feedback,
    notification,
    search,
    promotion,
    pricing,
    payment,
    patient,
    doctor,
    deletedAccounts,
  );

  return {
    service,
    deletionRequests,
    booking,
    clinical,
    followup,
    video,
    document,
    clarification,
    instant,
    carehub,
    feedback,
    notification,
    search,
    promotion,
    pricing,
    payment,
    patient,
    doctor,
    deletedAccounts,
  };
}

describe('DataRightsService.previewExecution', () => {
  it('throws NotFoundException for an unknown request', async () => {
    const { service, deletionRequests } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(null);

    await expect(service.previewExecution('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes nothing — no mutating method on any facade is ever called', async () => {
    const { service, search, promotion, patient, deletionRequests } = createDeps();

    await service.previewExecution(REQUEST_ID);

    expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
    expect(patient.softDeleteForDeletionRequest).not.toHaveBeenCalled();
    expect(deletionRequests.recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('returns one entry per surveyed table, each carrying a decision and a row count', async () => {
    const { service } = createDeps();

    const preview = await service.previewExecution(REQUEST_ID);

    expect(preview.requestId).toBe(REQUEST_ID);
    expect(preview.patientId).toBe(PATIENT_ID);
    expect(preview.doctorId).toBeNull();
    expect(preview.requestStatus).toBe('approved');
    expect(preview.tables.length).toBeGreaterThan(25);

    const byTable = new Map(preview.tables.map((t) => [t.table, t]));
    expect(byTable.get('patients')).toEqual(expect.objectContaining({ decision: 'soft_delete', rowCount: 1 }));
    expect(byTable.get('search_queries')).toEqual(expect.objectContaining({ decision: 'hard_delete' }));
    expect(byTable.get('promotion_code_attempts')).toEqual(expect.objectContaining({ decision: 'anonymize' }));
    expect(byTable.get('payments')).toEqual(expect.objectContaining({ decision: 'retain' }));
    expect(byTable.get('refunds')).toEqual(expect.objectContaining({ decision: 'retain' }));
    expect(byTable.get('audit_log')).toEqual(expect.objectContaining({ decision: 'retain', rowCount: null }));
    expect(byTable.get('patient_files')).toEqual(expect.objectContaining({ decision: 'retain', flaggedForHumanDecision: true }));
  });

  it('resolves the patient consultation set once and scopes every consultation-linked count to it', async () => {
    const { service, booking, clinical, video } = createDeps();

    await service.previewExecution(REQUEST_ID);

    expect(booking.listConsultationIdsForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(clinical.countRecordsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
    expect(video.countParticipantRowsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
  });

  it('previews a DOCTOR request against the much shorter DOCTOR_TABLE_SURVEY — no patient-side counting at all', async () => {
    const { service, deletionRequests, booking } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(request({ patientId: null, doctorId: DOCTOR_ID }));

    const preview = await service.previewExecution(REQUEST_ID);

    expect(preview.patientId).toBeNull();
    expect(preview.doctorId).toBe(DOCTOR_ID);
    expect(preview.tables).toEqual([expect.objectContaining({ table: 'doctors', decision: 'soft_delete', rowCount: 1 })]);
    expect(booking.listConsultationIdsForPatient).not.toHaveBeenCalled();
  });
});

describe('DataRightsService.executeForRequest', () => {
  it('refuses a request that is not currently approved, and touches nothing', async () => {
    const { service, deletionRequests, search, promotion, patient } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(request({ status: 'requested' }));

    await expect(service.executeForRequest(REQUEST_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(ConflictException);

    expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
    expect(patient.softDeleteForDeletionRequest).not.toHaveBeenCalled();
    expect(deletionRequests.recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for an unknown request', async () => {
    const { service, deletionRequests } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(null);

    await expect(service.executeForRequest('missing', ADMIN_ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('runs all three mutating steps, records status "executed", and persists the deleted_accounts snapshot', async () => {
    const { service, search, promotion, patient, deletionRequests, deletedAccounts } = createDeps();
    search.deleteSearchQueriesForPatient.mockResolvedValue({ deletedCount: 5 });
    promotion.anonymizePromotionCodeAttemptsForPatient.mockResolvedValue({ anonymizedCount: 2 });
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

    expect(search.deleteSearchQueriesForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(patient.softDeleteForDeletionRequest).toHaveBeenCalledWith(PATIENT_ID, ADMIN_ACTOR);
    expect(deletedAccounts.recordSnapshot).toHaveBeenCalledWith({
      accountType: 'patient',
      accountId: PATIENT_ID,
      deletionRequestId: REQUEST_ID,
      snapshot: { id: PATIENT_ID },
      originalMobileNumber: '+919876543210',
      deletedByAdminId: ADMIN_ID,
    });
    expect(result.status).toBe('executed');
    expect(result.executionOutcome.overallStatus).toBe('executed');
    expect(result.executionOutcome.mutatingSteps).toEqual([
      expect.objectContaining({ table: 'search_queries', status: 'success', rowsAffected: 5 }),
      expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 2 }),
      expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
    ]);

    const [actorArg, , outcomeArg] = deletionRequests.recordExecutionOutcome.mock.calls[0];
    expect(actorArg).toEqual(ADMIN_ACTOR);
    expect(outcomeArg).toEqual({ status: 'executed', executionOutcome: result.executionOutcome });
  });

  it('records status "failed" and continues the OTHER steps when one mutating step throws — partial failure is never hidden as success', async () => {
    const { service, search, promotion, deletionRequests } = createDeps();
    search.deleteSearchQueriesForPatient.mockRejectedValue(new Error('connection reset'));
    promotion.anonymizePromotionCodeAttemptsForPatient.mockResolvedValue({ anonymizedCount: 1 });
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'failed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

    // The failure in step 1 must not prevent steps 2 and 3 from running.
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).toHaveBeenCalled();

    expect(result.status).toBe('failed');
    expect(result.executionOutcome.overallStatus).toBe('failed');
    expect(result.executionOutcome.mutatingSteps).toEqual([
      expect.objectContaining({ table: 'search_queries', status: 'failed', error: 'connection reset' }),
      expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 1 }),
      expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
    ]);

    expect(deletionRequests.recordExecutionOutcome).toHaveBeenCalledWith(ADMIN_ACTOR, REQUEST_ID, {
      status: 'failed',
      executionOutcome: result.executionOutcome,
    });
  });

  it('carries the retained-table survey (decision + reason) into the permanent execution_outcome record', async () => {
    const { service, deletionRequests } = createDeps();
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

    const retained = result.executionOutcome.retainedTables;
    expect(retained.length).toBeGreaterThan(20);
    expect(retained.every((t) => t.decision === 'retain')).toBe(true);
    expect(retained.find((t) => t.table === 'payments')?.reason).toMatch(/financial/i);
  });

  it('does not persist a deleted_accounts snapshot when the account was already deleted (idempotent retry)', async () => {
    const { service, patient, deletedAccounts, deletionRequests } = createDeps();
    patient.softDeleteForDeletionRequest.mockResolvedValue({ softDeleted: false, snapshot: null, originalMobileNumber: null });
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

    await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

    expect(deletedAccounts.recordSnapshot).not.toHaveBeenCalled();
  });

  describe('a DOCTOR request', () => {
    it('runs the single doctors soft-delete step, never touches any patient-path facade, and records a snapshot', async () => {
      const { service, deletionRequests, doctor, patient, search, promotion, deletedAccounts } = createDeps();
      deletionRequests.getRequest.mockResolvedValue(request({ patientId: null, doctorId: DOCTOR_ID }));
      deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ patientId: null, doctorId: DOCTOR_ID, status: 'executed' }));

      const result = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

      expect(doctor.softDeleteForDeletionRequest).toHaveBeenCalledWith(DOCTOR_ID, ADMIN_ACTOR);
      expect(patient.softDeleteForDeletionRequest).not.toHaveBeenCalled();
      expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
      expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
      expect(deletedAccounts.recordSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ accountType: 'doctor', accountId: DOCTOR_ID, deletedByAdminId: ADMIN_ID }),
      );
      expect(result.executionOutcome.mutatingSteps).toEqual([expect.objectContaining({ table: 'doctors', status: 'success', rowsAffected: 1 })]);
      expect(result.executionOutcome.retainedTables).toEqual([]);
      expect(result.doctorId).toBe(DOCTOR_ID);
      expect(result.patientId).toBeNull();
    });
  });

  describe('the sweep — actorType system, actorId null', () => {
    it('attributes both the account audit and the request audit to the system, not a fabricated admin', async () => {
      const { service, patient, deletedAccounts, deletionRequests } = createDeps();
      deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

      await service.executeForRequest(REQUEST_ID, SYSTEM_ACTOR);

      expect(patient.softDeleteForDeletionRequest).toHaveBeenCalledWith(PATIENT_ID, SYSTEM_ACTOR);
      expect(deletedAccounts.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ deletedByAdminId: null }));
      expect(deletionRequests.recordExecutionOutcome).toHaveBeenCalledWith(SYSTEM_ACTOR, REQUEST_ID, expect.anything());
    });
  });

  describe('open obligations (open-obligations round)', () => {
    function openBooking(overrides: Partial<{ id: string; status: string; scheduledStartAt: Date | null }> = {}) {
      return { id: CONSULTATION_ID, status: 'scheduled', scheduledStartAt: new Date('2026-10-01T09:00:00.000Z'), ...overrides };
    }

    describe('previewExecution', () => {
      it('reports an open consultation for a patient request, without writing anything', async () => {
        const { service, booking, search, promotion, patient } = createDeps();
        booking.getBooking.mockResolvedValue(openBooking() as never);

        const preview = await service.previewExecution(REQUEST_ID);

        expect(preview.openObligations).toEqual([
          expect.objectContaining({ consultationId: CONSULTATION_ID, status: 'scheduled', scheduledStartAt: '2026-10-01T09:00:00.000Z' }),
        ]);
        expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
        expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
        expect(patient.softDeleteForDeletionRequest).not.toHaveBeenCalled();
      });

      it('reports nothing when every consultation is terminal (the default fixture)', async () => {
        const { service } = createDeps();
        const preview = await service.previewExecution(REQUEST_ID);
        expect(preview.openObligations).toEqual([]);
      });

      it('reports an open consultation for a DOCTOR request too, via listConsultationIdsForDoctor', async () => {
        const { service, deletionRequests, booking } = createDeps();
        deletionRequests.getRequest.mockResolvedValue(request({ patientId: null, doctorId: DOCTOR_ID }));
        booking.listConsultationIdsForDoctor.mockResolvedValue([CONSULTATION_ID]);
        booking.getBooking.mockResolvedValue(openBooking() as never);

        const preview = await service.previewExecution(REQUEST_ID);

        expect(booking.listConsultationIdsForDoctor).toHaveBeenCalledWith(DOCTOR_ID);
        expect(preview.openObligations).toHaveLength(1);
      });

      it('includes the payment status when a payment row exists for the open consultation', async () => {
        const { service, booking, payment } = createDeps();
        booking.getBooking.mockResolvedValue(openBooking() as never);
        payment.getByConsultationId.mockResolvedValue({ paymentId: 'pay-1', status: 'pending', paidAt: null });

        const preview = await service.previewExecution(REQUEST_ID);

        expect(preview.openObligations[0]).toMatchObject({ paymentStatus: 'pending' });
      });
    });

    describe('executeForRequest', () => {
      it('refuses with DATA_DELETION_OPEN_OBLIGATIONS and touches nothing when the account has an open consultation', async () => {
        const { service, booking, search, promotion, patient, deletionRequests } = createDeps();
        booking.getBooking.mockResolvedValue(openBooking() as never);

        const error = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({ response: { code: 'DATA_DELETION_OPEN_OBLIGATIONS' } });
        expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
        expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
        expect(patient.softDeleteForDeletionRequest).not.toHaveBeenCalled();
        expect(deletionRequests.recordExecutionOutcome).not.toHaveBeenCalled();
      });

      it('proceeds when an ADMIN passes options.override: true, even with an open consultation', async () => {
        const { service, booking, deletionRequests } = createDeps();
        booking.getBooking.mockResolvedValue(openBooking() as never);
        deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

        const result = await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR, { override: true });

        expect(result.status).toBe('executed');
      });

      /** *** THE OVERRIDE IS ADMIN-ONLY BY CONSTRUCTION. *** Even a caller mistakenly passing `override: true` alongside a SYSTEM actor must not bypass the check — see `DataRightsService#executeForRequest`'s own doc comment. */
      it('a SYSTEM actor can never override, even if options.override is somehow true', async () => {
        const { service, booking } = createDeps();
        booking.getBooking.mockResolvedValue(openBooking() as never);

        const error = await service.executeForRequest(REQUEST_ID, SYSTEM_ACTOR, { override: true }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({ response: { code: 'DATA_DELETION_OPEN_OBLIGATIONS' } });
      });

      it('a terminal-status consultation is never reported as an obligation', async () => {
        const { service, booking, deletionRequests } = createDeps();
        booking.getBooking.mockResolvedValue({ id: CONSULTATION_ID, status: 'cancelled', scheduledStartAt: null } as never);
        deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

        await expect(service.executeForRequest(REQUEST_ID, ADMIN_ACTOR)).resolves.toMatchObject({ status: 'executed' });
      });

      it('does not call the payment lookup at all when there is nothing open — avoids an N+1 for the common case', async () => {
        const { service, payment, deletionRequests } = createDeps();
        deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

        await service.executeForRequest(REQUEST_ID, ADMIN_ACTOR);

        expect(payment.getByConsultationId).not.toHaveBeenCalled();
      });
    });
  });
});
