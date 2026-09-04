/**
 * *** REAL-DATABASE TEST. *** This is the one execution path in the whole
 * project so far where a wrong answer permanently destroys real patient
 * data, so `data-rights.service.spec.ts`'s mocks (which prove the SEQUENCE
 * and the honest partial-failure bookkeeping) are not enough on their own.
 * This file proves, against real Postgres:
 *
 *   1. HARD-DELETE really removes the row — `search_queries`.
 *   2. ANONYMIZE really nulls EXACTLY the claimed columns and nothing
 *      else — `patients` (fullName/dateOfBirth/mobileNumber/pushToken/
 *      deviceId, status -> deleted) and `promotion_code_attempts`
 *      (patientId/ipAddress, leaving `outcome`/`createdAt` untouched).
 *   3. A RETAINED table is provably untouched — `consultations`, read back
 *      byte-for-byte identical before and after.
 *   4. A PARTIAL FAILURE mid-sequence leaves `data_deletion_requests` in an
 *      honest `failed` state with a per-step record, and the steps that DID
 *      succeed really did commit for real (no accidental cross-module
 *      transaction rolls them back) — `backend/README.md` §2 forbids one
 *      transaction spanning modules, and this is the proof that restraint
 *      does not silently undo work that legitimately happened.
 *
 * ── What is real here and what is not ──────────────────────────────────
 *
 * Real: the database; `PatientRepository`/`PatientService`/`PatientFacade`
 * (the full M-21 anonymize path); `SearchRepository`'s
 * `deleteAllForPatient`/`countDataRightsRows`; `PromotionRepository`'s
 * `anonymizeCodeAttemptsForPatient`/`countDataRightsRows`;
 * `IdentityRepository`'s `bumpTokenVersion`/`anonymizeMobileNumber`;
 * `BookingRepository`'s `listConsultationIdsForPatient`; the full
 * `DataDeletionService`/`DataDeletionRepository`/`ConsentRepository`
 * chain behind `DataDeletionExecutionFacade` — the actual state machine
 * this module writes `executed_at`/`execution_outcome` through.
 *
 * Not constructed: the other ten owning modules' full service/repository
 * stacks (clinical, followup, video, document, carehub, notification,
 * pricing, payment, instant, clarification). Every one of them is RETAIN
 * in the M-21 survey and this module never writes to any of them — their
 * OWN facade specs (built alongside this module) already prove their
 * individual count methods read real rows correctly. What matters here is
 * that `DataRightsService` calls them and does not mutate anything through
 * them, which the mocked `data-rights.service.spec.ts` already proves —
 * constructing all ten for real here would prove the identical fact a
 * second time at a much higher cost, the same restraint
 * `feedback.integration.spec.ts`'s own header states for `BookingService`.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env.local`
 * exactly as the seed scripts do, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminsTable } from '../../schema/admins.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { dataDeletionRequestsTable } from '../../schema/data-deletion-requests.schema';
import { patientsTable } from '../../schema/patients.schema';
import { promotionCodeAttemptsTable } from '../../schema/promotion-code-attempts.schema';
import { searchQueriesTable } from '../../schema/search-queries.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import { BookingRepository } from '../booking/booking.repository';
import type { CareHubFacade } from '../carehub/carehub.facade';
import type { ClarificationFacade } from '../clarification/clarification.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import { ConsentRepository } from '../consent/consent.repository';
import { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import { DataDeletionRepository } from '../consent/data-deletion.repository';
import { DataDeletionService } from '../consent/data-deletion.service';
import type { DocumentFacade } from '../document/document.facade';
import type { FeedbackFacade } from '../feedback/feedback.facade';
import type { FollowupFacade } from '../followup/followup.facade';
import type { IdentityFacade } from '../identity/identity.facade';
import { IdentityRepository } from '../identity/identity.repository';
import type { InstantFacade } from '../instant/instant.facade';
import type { NotificationFacade } from '../notification/notification.facade';
import { PatientFacade } from '../patient/patient.facade';
import { PatientRepository } from '../patient/patient.repository';
import { PatientService } from '../patient/patient.service';
import type { PaymentFacade } from '../payment/payment.facade';
import type { PricingFacade } from '../pricing/pricing.facade';
import { PromotionRepository } from '../promotion/promotion.repository';
import type { PromotionFacade } from '../promotion/promotion.facade';
import { SearchRepository } from '../search/search.repository';
import type { SearchFacade } from '../search/search.facade';
import type { VideoFacade } from '../video/video.facade';
import { DataRightsService } from './data-rights.service';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  adminId: string;
}

async function seedShared(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `data_rights_${runId}`, name: `Data Rights Test Specialty ${runId}`, canPrescribe: false })
    .returning({ id: specialtiesTable.id });
  const [admin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `+9197${runId.slice(0, 6)}01`, fullName: `Data Rights Admin ${runId}` })
    .returning({ id: adminsTable.id });
  return { runId, specialtyId: specialty.id, adminId: admin.id };
}

/** One patient, one consultation, seeded rows in the two tables this execution writes, and an `approved` deletion request. */
async function seedPatientScenario(db: Database, shared: Fixtures, tag: string) {
  const phone = `+9198${shared.runId.slice(0, 4)}${tag}${String(Math.floor(Math.random() * 90) + 10)}`;
  const [patient] = await db
    .insert(patientsTable)
    .values({
      mobileNumber: phone,
      status: 'active',
      fullName: `Real Patient ${tag}`,
      dateOfBirth: '1990-01-01',
      pushToken: `push-token-${tag}`,
      deviceId: `device-${tag}`,
    })
    .returning();

  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `DR-${shared.runId}-${tag}`,
      patientId: patient.id,
      specialtyId: shared.specialtyId,
      mode: 'scheduled',
      status: 'completed',
      durationMinutes: 30,
      cancellationReason: null,
    })
    .returning();

  await db.insert(searchQueriesTable).values([
    { patientId: patient.id, queryText: 'feeling anxious before exams' },
    { patientId: patient.id, queryText: 'trouble sleeping at night' },
  ]);

  const [attempt] = await db
    .insert(promotionCodeAttemptsTable)
    .values({ patientId: patient.id, ipAddress: '203.0.113.5', outcome: 'resolved' })
    .returning();

  const [request] = await db
    .insert(dataDeletionRequestsTable)
    .values({ patientId: patient.id, status: 'approved', reviewedByAdminId: shared.adminId, reviewedAt: new Date() })
    .returning();

  return { patient, consultation, request, attempt };
}

async function teardownPatientScenario(db: Database, patientId: string, requestId: string, consultationId: string) {
  await db.delete(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, requestId));
  await db.delete(searchQueriesTable).where(eq(searchQueriesTable.patientId, patientId));
  await db.delete(promotionCodeAttemptsTable).where(eq(promotionCodeAttemptsTable.patientId, patientId));
  await db.delete(consultationsTable).where(eq(consultationsTable.id, consultationId));
  await db.delete(patientsTable).where(eq(patientsTable.id, patientId));
}

/** A `count() => Promise<0>`-shaped stub for the ten owning modules this execution never mutates — see this file's header for why they are not constructed for real here. */
function zeroCounts<T extends object>(shape: T): T {
  return shape;
}

describe('M-21 data-rights execution, against a real database', () => {
  let db: Database;
  let shared: Fixtures;
  let service: DataRightsService;
  let promotionRepo: PromotionRepository;
  let searchRepo: SearchRepository;

  /** `search.deleteSearchQueriesForPatient` for the ONE patient this flag names throws — simulating a genuine mid-sequence failure without faking anything else. */
  let throwSearchForPatientId: string | null;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    shared = await seedShared(db);

    const audit = new AuditService(db);

    // ── The real M-21 write paths ──────────────────────────────────────
    const patientRepo = new PatientRepository(db);
    const identityRepo = new IdentityRepository(db);
    const identityStandIn: Pick<IdentityFacade, 'revokeAllSessions' | 'anonymizeMobileNumber'> = {
      revokeAllSessions: async (accountType, id, actor) => {
        const newTokenVersion = await identityRepo.bumpTokenVersion(accountType, id);
        await audit.write({
          actorType: actor?.actorType ?? accountType,
          actorId: actor?.actorId ?? id,
          action: 'update',
          entityType: 'session',
          entityId: id,
          metadata: { reason: 'logout_all', newTokenVersion },
        });
      },
      anonymizeMobileNumber: (accountType, id) => identityRepo.anonymizeMobileNumber(accountType, id),
    };
    const patientService = new PatientService(patientRepo, identityStandIn as IdentityFacade, audit);
    const patientFacade = new PatientFacade(patientRepo, patientService);

    searchRepo = new SearchRepository(db);
    const searchStandIn: Pick<SearchFacade, 'deleteSearchQueriesForPatient' | 'countDataRightsRowsForPatient'> = {
      deleteSearchQueriesForPatient: async (patientId: string) => {
        if (patientId === throwSearchForPatientId) {
          throw new Error('simulated infrastructure failure — search_queries delete');
        }
        return searchRepo.deleteAllForPatient(patientId);
      },
      countDataRightsRowsForPatient: (patientId: string) => searchRepo.countDataRightsRows(patientId),
    };

    promotionRepo = new PromotionRepository(db);
    const promotionStandIn: Pick<PromotionFacade, 'anonymizePromotionCodeAttemptsForPatient' | 'countDataRightsRowsForPatient'> = {
      anonymizePromotionCodeAttemptsForPatient: (patientId: string) => promotionRepo.anonymizeCodeAttemptsForPatient(patientId),
      countDataRightsRowsForPatient: async (input: { patientId: string; consultationIds: readonly string[] }) => {
        const own = await promotionRepo.countDataRightsRows(input.patientId);
        return {
          discountInstruments: own.discountInstruments,
          discountRedemptions: own.discountRedemptions,
          affiliateAttributions: 0,
          affiliateCommissions: 0,
          referralEvents: 0,
          promotionCodeAttempts: own.promotionCodeAttempts,
        };
      },
    };

    const bookingRepo = new BookingRepository(db);
    const bookingStandIn: Pick<BookingFacade, 'listConsultationIdsForPatient'> = {
      listConsultationIdsForPatient: (patientId: string) => bookingRepo.listConsultationIdsForPatient(patientId),
    };

    const deletionRepo = new DataDeletionRepository(db);
    const consentRepo = new ConsentRepository(db);
    const dataDeletionService = new DataDeletionService(db, deletionRepo, audit);
    const deletionExecutionFacade = new DataDeletionExecutionFacade(dataDeletionService, consentRepo);

    // ── The ten RETAIN-only modules this execution never writes to ─────
    // Stubbed, deliberately — see this file's header for the reasoning.
    const clinical = zeroCounts<Pick<ClinicalFacade, 'countRecordsForConsultations'>>({
      countRecordsForConsultations: async () => 0,
    }) as ClinicalFacade;
    const followup = zeroCounts<Pick<FollowupFacade, 'countDataRightsRowsForConsultations'>>({
      countDataRightsRowsForConsultations: async () => ({ checkinResponses: 0, safetyAlerts: 0, followupAssignments: 0 }),
    }) as FollowupFacade;
    const video = zeroCounts<Pick<VideoFacade, 'countParticipantRowsForConsultations'>>({
      countParticipantRowsForConsultations: async () => 0,
    }) as VideoFacade;
    const document = zeroCounts<Pick<DocumentFacade, 'countDataRightsRowsForPatient'>>({
      countDataRightsRowsForPatient: async () => ({ patientFiles: 0, reportRequests: 0 }),
    }) as DocumentFacade;
    const clarification = zeroCounts<Pick<ClarificationFacade, 'countCasesForConsultations'>>({
      countCasesForConsultations: async () => 0,
    }) as ClarificationFacade;
    const instant = zeroCounts<Pick<InstantFacade, 'countOffersForConsultations'>>({
      countOffersForConsultations: async () => 0,
    }) as InstantFacade;
    const carehub = zeroCounts<Pick<CareHubFacade, 'countRecommendationsForConsultations'>>({
      countRecommendationsForConsultations: async () => 0,
    }) as CareHubFacade;
    const feedback = zeroCounts<Pick<FeedbackFacade, 'countDataRightsRowsForPatient'>>({
      countDataRightsRowsForPatient: async () => ({ feedback: 0, complaints: 0 }),
    }) as FeedbackFacade;
    const notification = zeroCounts<Pick<NotificationFacade, 'countNotificationsForPatient'>>({
      countNotificationsForPatient: async () => 0,
    }) as NotificationFacade;
    const pricing = zeroCounts<Pick<PricingFacade, 'countDataRightsRowsForPatient'>>({
      countDataRightsRowsForPatient: async () => ({ priceQuotes: 0, priceQuoteComponents: 0, refundComponents: 0 }),
    }) as PricingFacade;
    const payment = zeroCounts<Pick<PaymentFacade, 'countDataRightsRowsForConsultations'>>({
      countDataRightsRowsForConsultations: async () => ({ payments: 0, refunds: 0, paymentEvents: 0 }),
    }) as PaymentFacade;

    service = new DataRightsService(
      deletionExecutionFacade,
      bookingStandIn as BookingFacade,
      clinical,
      followup,
      video,
      document,
      clarification,
      instant,
      carehub,
      feedback,
      notification,
      searchStandIn as SearchFacade,
      promotionStandIn as PromotionFacade,
      pricing,
      payment,
      patientFacade,
    );
  });

  afterAll(async () => {
    await db.delete(adminsTable).where(eq(adminsTable.id, shared.adminId));
    await db.delete(specialtiesTable).where(eq(specialtiesTable.id, shared.specialtyId));
    await disconnectDatabase();
  });

  describe('previewExecution — writes nothing', () => {
    it('reports real counts and decisions without touching a single row', async () => {
      const { patient, consultation, request } = await seedPatientScenario(db, shared, 'pv');
      try {
        const before = {
          patient: await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id)),
          queries: await db.select().from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patient.id)),
          attempts: await db.select().from(promotionCodeAttemptsTable).where(eq(promotionCodeAttemptsTable.patientId, patient.id)),
        };

        const preview = await service.previewExecution(request.id);

        const byTable = new Map(preview.tables.map((t) => [t.table, t]));
        expect(byTable.get('patients')).toEqual(expect.objectContaining({ decision: 'anonymize', rowCount: 1 }));
        expect(byTable.get('search_queries')).toEqual(expect.objectContaining({ decision: 'hard_delete', rowCount: 2 }));
        expect(byTable.get('promotion_code_attempts')).toEqual(expect.objectContaining({ decision: 'anonymize', rowCount: 1 }));
        expect(byTable.get('consultations')).toEqual(expect.objectContaining({ decision: 'retain', rowCount: 1 }));

        const after = {
          patient: await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id)),
          queries: await db.select().from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patient.id)),
          attempts: await db.select().from(promotionCodeAttemptsTable).where(eq(promotionCodeAttemptsTable.patientId, patient.id)),
        };
        expect(after).toEqual(before);

        const [freshRequest] = await db
          .select()
          .from(dataDeletionRequestsTable)
          .where(eq(dataDeletionRequestsTable.id, request.id));
        expect(freshRequest.status).toBe('approved');
        expect(freshRequest.executedAt).toBeNull();
        expect(freshRequest.executionOutcome).toBeNull();
      } finally {
        await teardownPatientScenario(db, patient.id, request.id, consultation.id);
      }
    });
  });

  describe('executeForRequest — the full success path', () => {
    it('hard-deletes search_queries, anonymizes patients and promotion_code_attempts exactly, and leaves consultations byte-for-byte untouched', async () => {
      const { patient, consultation, request, attempt } = await seedPatientScenario(db, shared, 'ok');
      try {
        const [consultationBefore] = await db.select().from(consultationsTable).where(eq(consultationsTable.id, consultation.id));

        const result = await service.executeForRequest(request.id, shared.adminId);

        expect(result.status).toBe('executed');
        expect(result.executionOutcome.overallStatus).toBe('executed');
        expect(result.executionOutcome.mutatingSteps).toEqual([
          expect.objectContaining({ table: 'search_queries', status: 'success', rowsAffected: 2 }),
          expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 1 }),
          expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
        ]);

        // 1. HARD-DELETE: search_queries really has zero rows for this patient.
        const remainingQueries = await db.select().from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patient.id));
        expect(remainingQueries).toHaveLength(0);

        // 2a. ANONYMIZE: patients — exactly the claimed columns, nothing else.
        const [patientAfter] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
        expect(patientAfter.fullName).toBeNull();
        expect(patientAfter.dateOfBirth).toBeNull();
        expect(patientAfter.pushToken).toBeNull();
        expect(patientAfter.deviceId).toBeNull();
        expect(patientAfter.status).toBe('deleted');
        expect(patientAfter.mobileNumber).not.toBe(patient.mobileNumber);
        expect(patientAfter.mobileNumber.startsWith('+')).toBe(false);
        expect(patientAfter.mobileNumber).toHaveLength(16);
        // Untouched by this execution: id, gender, preferredLanguage, createdAt.
        expect(patientAfter.id).toBe(patient.id);
        expect(patientAfter.gender).toBe(patient.gender);
        expect(patientAfter.preferredLanguage).toBe(patient.preferredLanguage);
        expect(patientAfter.createdAt).toEqual(patient.createdAt);

        // 2b. ANONYMIZE: promotion_code_attempts — patient_id/ip_address only.
        const [attemptAfter] = await db
          .select()
          .from(promotionCodeAttemptsTable)
          .where(eq(promotionCodeAttemptsTable.id, attempt.id));
        expect(attemptAfter.patientId).toBeNull();
        expect(attemptAfter.ipAddress).toBeNull();
        expect(attemptAfter.outcome).toBe('resolved');
        expect(attemptAfter.createdAt).toEqual(attempt.createdAt);

        // 3. RETAIN: consultations is byte-for-byte identical.
        const [consultationAfter] = await db.select().from(consultationsTable).where(eq(consultationsTable.id, consultation.id));
        expect(consultationAfter).toEqual(consultationBefore);

        // 4. The permanent record: data_deletion_requests really says "executed".
        const [requestAfter] = await db.select().from(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, request.id));
        expect(requestAfter.status).toBe('executed');
        expect(requestAfter.executedAt).not.toBeNull();
        expect((requestAfter.executionOutcome as { overallStatus: string }).overallStatus).toBe('executed');
      } finally {
        await teardownPatientScenario(db, patient.id, request.id, consultation.id);
      }
    });

    it('refuses a request that is not approved, and touches nothing', async () => {
      const { patient, consultation, request } = await seedPatientScenario(db, shared, 'na');
      try {
        await db.update(dataDeletionRequestsTable).set({ status: 'requested' }).where(eq(dataDeletionRequestsTable.id, request.id));

        await expect(service.executeForRequest(request.id, shared.adminId)).rejects.toBeDefined();

        const [patientAfter] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
        expect(patientAfter.fullName).toBe(patient.fullName);
        expect(patientAfter.status).toBe('active');
        const remainingQueries = await db.select().from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patient.id));
        expect(remainingQueries).toHaveLength(2);
      } finally {
        await teardownPatientScenario(db, patient.id, request.id, consultation.id);
      }
    });
  });

  describe('executeForRequest — partial failure', () => {
    it('leaves data_deletion_requests honestly "failed" while the OTHER steps commit for real, and the failed table stays untouched', async () => {
      const { patient, consultation, request, attempt } = await seedPatientScenario(db, shared, 'pf');
      throwSearchForPatientId = patient.id;
      try {
        const result = await service.executeForRequest(request.id, shared.adminId);

        expect(result.status).toBe('failed');
        expect(result.executionOutcome.overallStatus).toBe('failed');
        expect(result.executionOutcome.mutatingSteps).toEqual([
          expect.objectContaining({
            table: 'search_queries',
            status: 'failed',
            error: 'simulated infrastructure failure — search_queries delete',
          }),
          expect.objectContaining({ table: 'promotion_code_attempts', status: 'success', rowsAffected: 1 }),
          expect.objectContaining({ table: 'patients', status: 'success', rowsAffected: 1 }),
        ]);

        // The FAILED step's table is genuinely untouched — still 2 rows.
        const remainingQueries = await db.select().from(searchQueriesTable).where(eq(searchQueriesTable.patientId, patient.id));
        expect(remainingQueries).toHaveLength(2);

        // The steps that DID succeed really committed — no accidental
        // cross-module transaction rolled them back because a sibling step failed.
        const [attemptAfter] = await db.select().from(promotionCodeAttemptsTable).where(eq(promotionCodeAttemptsTable.id, attempt.id));
        expect(attemptAfter?.patientId).toBeNull();
        const [patientAfter] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
        expect(patientAfter.status).toBe('deleted');
        expect(patientAfter.fullName).toBeNull();

        // The permanent record is honest, not a false "success".
        const [requestAfter] = await db.select().from(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, request.id));
        expect(requestAfter.status).toBe('failed');
        expect(requestAfter.executedAt).not.toBeNull();
        const outcome = requestAfter.executionOutcome as { mutatingSteps: Array<{ table: string; status: string }> };
        expect(outcome.mutatingSteps.find((s) => s.table === 'search_queries')?.status).toBe('failed');
      } finally {
        throwSearchForPatientId = null;
        await teardownPatientScenario(db, patient.id, request.id, consultation.id);
      }
    });
  });
});
