import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BookingFacade } from '../booking/booking.facade';
import type { CareHubFacade } from '../carehub/carehub.facade';
import type { ClarificationFacade } from '../clarification/clarification.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import type { DataDeletionRequestRecord } from '../consent/data-deletion.types';
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

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CONSULTATION_ID = '44444444-4444-4444-8444-444444444444';

function request(overrides: Partial<DataDeletionRequestRecord> = {}): DataDeletionRequestRecord {
  return {
    id: REQUEST_ID,
    patientId: PATIENT_ID,
    status: 'approved',
    reason: null,
    reviewedByAdminId: ADMIN_ID,
    reviewedAt: new Date().toISOString(),
    reviewNote: null,
    executedAt: null,
    executionOutcome: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Hand-rolled `jest.fn()` collaborators for every one of the 16 facades — never `Test.createTestingModule`. */
function createDeps() {
  const deletionRequests = {
    getRequest: jest.fn().mockResolvedValue(request()),
    recordExecutionOutcome: jest.fn(),
    countConsentsForPatient: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<DataDeletionExecutionFacade>;

  const booking = {
    listConsultationIdsForPatient: jest.fn().mockResolvedValue([CONSULTATION_ID]),
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
  } as unknown as jest.Mocked<PaymentFacade>;
  const patient = { anonymizeForDeletion: jest.fn().mockResolvedValue({ anonymized: true }) } as unknown as jest.Mocked<PatientFacade>;

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
    expect(patient.anonymizeForDeletion).not.toHaveBeenCalled();
    expect(deletionRequests.recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('returns one entry per surveyed table, each carrying a decision and a row count', async () => {
    const { service } = createDeps();

    const preview = await service.previewExecution(REQUEST_ID);

    expect(preview.requestId).toBe(REQUEST_ID);
    expect(preview.patientId).toBe(PATIENT_ID);
    expect(preview.requestStatus).toBe('approved');
    expect(preview.tables.length).toBeGreaterThan(25);

    const byTable = new Map(preview.tables.map((t) => [t.table, t]));
    expect(byTable.get('patients')).toEqual(expect.objectContaining({ decision: 'anonymize', rowCount: 1 }));
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
});

describe('DataRightsService.executeForRequest', () => {
  it('refuses a request that is not currently approved, and touches nothing', async () => {
    const { service, deletionRequests, search, promotion, patient } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(request({ status: 'requested' }));

    await expect(service.executeForRequest(REQUEST_ID, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(search.deleteSearchQueriesForPatient).not.toHaveBeenCalled();
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).not.toHaveBeenCalled();
    expect(patient.anonymizeForDeletion).not.toHaveBeenCalled();
    expect(deletionRequests.recordExecutionOutcome).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for an unknown request', async () => {
    const { service, deletionRequests } = createDeps();
    deletionRequests.getRequest.mockResolvedValue(null);

    await expect(service.executeForRequest('missing', ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('runs all three mutating steps and records status "executed" when every step succeeds', async () => {
    const { service, search, promotion, patient, deletionRequests } = createDeps();
    search.deleteSearchQueriesForPatient.mockResolvedValue({ deletedCount: 5 });
    promotion.anonymizePromotionCodeAttemptsForPatient.mockResolvedValue({ anonymizedCount: 2 });
    patient.anonymizeForDeletion.mockResolvedValue({ anonymized: true });
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ID);

    expect(search.deleteSearchQueriesForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(patient.anonymizeForDeletion).toHaveBeenCalledWith(PATIENT_ID, ADMIN_ID);
    expect(result.status).toBe('executed');
    expect(result.executionOutcome.overallStatus).toBe('executed');
    expect(result.executionOutcome.mutatingSteps).toEqual([
      expect.objectContaining({ table: 'search_queries', status: 'success', rowsAffected: 5 }),
      expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 2 }),
      expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
    ]);

    const [, , outcomeArg] = deletionRequests.recordExecutionOutcome.mock.calls[0];
    expect(outcomeArg).toEqual({ status: 'executed', executionOutcome: result.executionOutcome });
  });

  it('records status "failed" and continues the OTHER steps when one mutating step throws — partial failure is never hidden as success', async () => {
    const { service, search, promotion, patient, deletionRequests } = createDeps();
    search.deleteSearchQueriesForPatient.mockRejectedValue(new Error('connection reset'));
    promotion.anonymizePromotionCodeAttemptsForPatient.mockResolvedValue({ anonymizedCount: 1 });
    patient.anonymizeForDeletion.mockResolvedValue({ anonymized: true });
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'failed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ID);

    // The failure in step 1 must not prevent steps 2 and 3 from running.
    expect(promotion.anonymizePromotionCodeAttemptsForPatient).toHaveBeenCalled();
    expect(patient.anonymizeForDeletion).toHaveBeenCalled();

    expect(result.status).toBe('failed');
    expect(result.executionOutcome.overallStatus).toBe('failed');
    expect(result.executionOutcome.mutatingSteps).toEqual([
      expect.objectContaining({ table: 'search_queries', status: 'failed', error: 'connection reset' }),
      expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 1 }),
      expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
    ]);

    expect(deletionRequests.recordExecutionOutcome).toHaveBeenCalledWith(ADMIN_ID, REQUEST_ID, {
      status: 'failed',
      executionOutcome: result.executionOutcome,
    });
  });

  it('carries the retained-table survey (decision + reason) into the permanent execution_outcome record', async () => {
    const { service, deletionRequests } = createDeps();
    deletionRequests.recordExecutionOutcome.mockResolvedValue(request({ status: 'executed' }));

    const result = await service.executeForRequest(REQUEST_ID, ADMIN_ID);

    const retained = result.executionOutcome.retainedTables;
    expect(retained.length).toBeGreaterThan(20);
    expect(retained.every((t) => t.decision === 'retain')).toBe(true);
    expect(retained.find((t) => t.table === 'payments')?.reason).toMatch(/financial/i);
  });
});
