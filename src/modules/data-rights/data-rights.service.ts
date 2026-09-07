import { ConflictException, Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { BookingFacade } from '../booking/booking.facade';
import { CareHubFacade } from '../carehub/carehub.facade';
import { ClarificationFacade } from '../clarification/clarification.facade';
import { ClinicalFacade } from '../clinical/clinical.facade';
import { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import type { DataDeletionRequestRecord } from '../consent/data-deletion.types';
import { DocumentFacade } from '../document/document.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { FeedbackFacade } from '../feedback/feedback.facade';
import { FollowupFacade } from '../followup/followup.facade';
import { InstantFacade } from '../instant/instant.facade';
import { NotificationFacade } from '../notification/notification.facade';
import { PatientFacade } from '../patient/patient.facade';
import { PaymentFacade } from '../payment/payment.facade';
import { PricingFacade } from '../pricing/pricing.facade';
import { PromotionFacade } from '../promotion/promotion.facade';
import { SearchFacade } from '../search/search.facade';
import { VideoFacade } from '../video/video.facade';
import { DATA_RIGHTS_ERROR_CODES, DOCTOR_TABLE_SURVEY, STATIC_TABLE_SURVEY } from './data-rights.constants';
import { DeletedAccountsService } from './deleted-accounts.service';
import type {
  DataRightsExecutionOutcome,
  DataRightsExecutionResult,
  DataRightsPreview,
  DataRightsStepOutcome,
  DataRightsTableEntry,
} from './data-rights.types';

/** Who is executing — an admin's explicit action, or the grace-period sweep. See `data-deletion.types.ts#DeletionExecutionActor`'s own header. */
export type ExecutionActor = { actorType: 'admin'; actorId: string } | { actorType: 'system'; actorId: null };

/**
 * M-21's execution half: given an APPROVED `data_deletion_requests` row,
 * `previewExecution` computes and reports what would happen — writing
 * NOTHING — and `executeForRequest` is the separate, explicit action that
 * actually performs it (an admin's `POST .../execute`, or the sweep's own
 * call — `data-rights-execution-sweep.service.ts`). Both are documented at
 * length in the coordinator's build report; the short version:
 *
 *   - No implicit trigger inside a review transition. `reviewRequest`
 *     moving a request to `approved` NEVER itself executes anything — only
 *     the two callers named above ever reach `executeForRequest`.
 *   - *** THIS MODULE OWNS NO TABLE OF ITS OWN, WITH ONE ADDITIVE EXCEPTION
 *     (account-deletion lifecycle round): `deleted_accounts`. *** Every
 *     count, hard-delete, anonymize and soft-delete call for a PATIENT/
 *     DOCTOR'S OWN account still goes through the owning module's facade —
 *     this service never opens a transaction that spans another module's
 *     write (`backend/README.md` §2 forbids a cross-module transaction).
 *     `deleted_accounts` is the one table this module writes directly,
 *     through `DeletedAccountsService`, because "another copy, for safety"
 *     is the compliance function this module itself exists to perform, not
 *     something any owning module could sensibly hold instead.
 *   - The compliance POLICY (which table is hard-deleted/anonymized/
 *     retained, and why) lives in `data-rights.constants.ts#
 *     STATIC_TABLE_SURVEY`/`DOCTOR_TABLE_SURVEY`, not scattered across the
 *     owning modules this service composes.
 *
 * *** PATIENT VS. DOCTOR (account-deletion lifecycle round). *** A request
 * now carries exactly one of `patientId`/`doctorId`
 * (`data-deletion-requests.schema.ts#account_xor_check`). The patient path
 * is unchanged in shape from before this round (the 30-ish-table survey);
 * the doctor path is deliberately much narrower — see
 * `DOCTOR_TABLE_SURVEY`'s own header for why a doctor's deletion touches
 * exactly one table.
 */
@Injectable()
export class DataRightsService {
  private readonly logger = new Logger(DataRightsService.name);

  constructor(
    @Inject(DataDeletionExecutionFacade) private readonly deletionRequests: DataDeletionExecutionFacade,
    private readonly booking: BookingFacade,
    private readonly clinical: ClinicalFacade,
    private readonly followup: FollowupFacade,
    private readonly video: VideoFacade,
    private readonly document: DocumentFacade,
    private readonly clarification: ClarificationFacade,
    private readonly instant: InstantFacade,
    private readonly carehub: CareHubFacade,
    private readonly feedback: FeedbackFacade,
    private readonly notification: NotificationFacade,
    private readonly search: SearchFacade,
    private readonly promotion: PromotionFacade,
    private readonly pricing: PricingFacade,
    private readonly payment: PaymentFacade,
    private readonly patient: PatientFacade,
    private readonly doctor: DoctorFacade,
    private readonly deletedAccounts: DeletedAccountsService,
  ) {}

  /**
   * *** WRITES ABSOLUTELY NOTHING. *** Safe to call any number of times, in
   * any request status — it is a report, not a precondition check;
   * `executeForRequest` is what enforces `status === 'approved'`.
   */
  async previewExecution(requestId: string): Promise<DataRightsPreview> {
    const request = await this.findRequestOrThrow(requestId);

    if (request.doctorId) {
      const tables = DOCTOR_TABLE_SURVEY.map((entry) => ({ ...entry, rowCount: 1 }));
      return { requestId: request.id, patientId: null, doctorId: request.doctorId, requestStatus: request.status, tables, generatedAt: new Date().toISOString() };
    }

    const patientId = request.patientId as string; // XOR-guaranteed by the schema's own check constraint
    const consultationIds = await this.booking.listConsultationIdsForPatient(patientId);
    const tables = await this.buildTableEntries(patientId, consultationIds);

    return { requestId: request.id, patientId, doctorId: null, requestStatus: request.status, tables, generatedAt: new Date().toISOString() };
  }

  /** Performs what the preview describes. Refuses (`ConflictException`) unless the request is CURRENTLY `approved`. Branches on `request.doctorId` — see the class header. */
  async executeForRequest(requestId: string, actor: ExecutionActor): Promise<DataRightsExecutionResult> {
    const request = await this.findRequestOrThrow(requestId);
    if (request.status !== 'approved') {
      throw new ConflictException({
        code: DATA_RIGHTS_ERROR_CODES.DATA_DELETION_NOT_APPROVED,
        message: `A request in "${request.status}" may not be executed — only an "approved" request may.`,
        currentStatus: request.status,
      });
    }

    return request.doctorId ? this.executeDoctorRequest(request, actor) : this.executePatientRequest(request, actor);
  }

  /* ------------------------------------------------------------------ */
  /* Patient execution                                                    */
  /* ------------------------------------------------------------------ */

  private async executePatientRequest(request: DataDeletionRequestRecord, actor: ExecutionActor): Promise<DataRightsExecutionResult> {
    const patientId = request.patientId as string;
    const consultationIds = await this.booking.listConsultationIdsForPatient(patientId);
    const retainedTables = await this.buildRetainedTableEntries(patientId, consultationIds);

    const mutatingSteps: DataRightsStepOutcome[] = [];

    mutatingSteps.push(
      await this.runStep('search_queries', 'search', 'hard_delete', async () => {
        const { deletedCount } = await this.search.deleteSearchQueriesForPatient(patientId);
        return deletedCount;
      }),
    );

    mutatingSteps.push(
      await this.runStep('promotion_code_attempts', 'promotion', 'anonymize', async () => {
        const { anonymizedCount } = await this.promotion.anonymizePromotionCodeAttemptsForPatient(patientId);
        return anonymizedCount;
      }),
    );

    mutatingSteps.push(
      await this.runStep('patients', 'patient', 'soft_delete', async () => {
        const result = await this.patient.softDeleteForDeletionRequest(patientId, actor);
        if (result.softDeleted && result.snapshot && result.originalMobileNumber) {
          await this.deletedAccounts.recordSnapshot({
            accountType: 'patient',
            accountId: patientId,
            deletionRequestId: request.id,
            snapshot: result.snapshot,
            originalMobileNumber: result.originalMobileNumber,
            deletedByAdminId: actor.actorType === 'admin' ? actor.actorId : null,
          });
        }
        return result.softDeleted ? 1 : 0;
      }),
    );

    return this.finishExecution(request, actor, mutatingSteps, retainedTables);
  }

  /* ------------------------------------------------------------------ */
  /* Doctor execution — deliberately narrow, see DOCTOR_TABLE_SURVEY.      */
  /* ------------------------------------------------------------------ */

  private async executeDoctorRequest(request: DataDeletionRequestRecord, actor: ExecutionActor): Promise<DataRightsExecutionResult> {
    const doctorId = request.doctorId as string;
    const mutatingSteps: DataRightsStepOutcome[] = [];

    mutatingSteps.push(
      await this.runStep('doctors', 'doctor', 'soft_delete', async () => {
        const result = await this.doctor.softDeleteForDeletionRequest(doctorId, actor);
        if (result.softDeleted && result.snapshot && result.originalMobileNumber) {
          await this.deletedAccounts.recordSnapshot({
            accountType: 'doctor',
            accountId: doctorId,
            deletionRequestId: request.id,
            snapshot: result.snapshot,
            originalMobileNumber: result.originalMobileNumber,
            deletedByAdminId: actor.actorType === 'admin' ? actor.actorId : null,
          });
        }
        return result.softDeleted ? 1 : 0;
      }),
    );

    // Nothing to retain-report for a doctor beyond the survey's own entry —
    // there is no per-consultation table this execution touches, so there
    // is nothing else to enumerate as "deliberately left alone".
    return this.finishExecution(request, actor, mutatingSteps, []);
  }

  /* ------------------------------------------------------------------ */

  private async finishExecution(
    request: DataDeletionRequestRecord,
    actor: ExecutionActor,
    mutatingSteps: DataRightsStepOutcome[],
    retainedTables: DataRightsTableEntry[],
  ): Promise<DataRightsExecutionResult> {
    const overallStatus: 'executed' | 'failed' = mutatingSteps.every((step) => step.status === 'success') ? 'executed' : 'failed';

    const executionOutcome: DataRightsExecutionOutcome = {
      requestId: request.id,
      patientId: request.patientId,
      doctorId: request.doctorId,
      executedAt: new Date().toISOString(),
      overallStatus,
      mutatingSteps,
      retainedTables,
    };

    if (overallStatus === 'failed') {
      this.logger.error(
        `Data-deletion execution for request ${request.id} (${request.patientId ? `patient ${request.patientId}` : `doctor ${request.doctorId}`}) did not fully complete: ${JSON.stringify(
          mutatingSteps.filter((s) => s.status === 'failed'),
        )}`,
      );
    }

    const updated = await this.deletionRequests.recordExecutionOutcome(actor, request.id, { status: overallStatus, executionOutcome });

    return { requestId: updated.id, patientId: updated.patientId, doctorId: updated.doctorId, status: overallStatus, executionOutcome };
  }

  /** Runs one mutating step, converting a throw into an honest `failed` entry rather than aborting the whole sequence. */
  private async runStep(
    table: string,
    module: string,
    decision: Extract<DataRightsTableEntry['decision'], 'hard_delete' | 'anonymize' | 'soft_delete'>,
    run: () => Promise<number>,
  ): Promise<DataRightsStepOutcome> {
    try {
      const rowsAffected = await run();
      return { table, module, decision, status: 'success', rowsAffected };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Data-rights step failed — table=${table} module=${module} decision=${decision}: ${message}`);
      return { table, module, decision, status: 'failed', error: message };
    }
  }

  /** Every table in the survey, decision + live row count — what `previewExecution` returns (patient path). */
  private async buildTableEntries(patientId: string, consultationIds: readonly string[]): Promise<DataRightsTableEntry[]> {
    const counts = await this.collectCounts(patientId, consultationIds);
    return STATIC_TABLE_SURVEY.map((entry) => ({ ...entry, rowCount: counts.get(entry.table) ?? null }));
  }

  /** Only the RETAIN rows, decision + live row count — what `executeForRequest` freezes into `execution_outcome.retainedTables` (patient path). */
  private async buildRetainedTableEntries(patientId: string, consultationIds: readonly string[]): Promise<DataRightsTableEntry[]> {
    const all = await this.buildTableEntries(patientId, consultationIds);
    return all.filter((entry) => entry.decision === 'retain');
  }

  /**
   * One round trip per owning module (not per table) — every module here
   * exposes ONE additive `count*` method covering every table it owns in
   * the survey, so this is ~14 calls total, not ~30.
   */
  private async collectCounts(patientId: string, consultationIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    counts.set('patients', 1);

    const [
      clinicalRecords,
      followupCounts,
      participants,
      documentCounts,
      consentsCount,
      feedbackCounts,
      recommendations,
      notificationsCount,
      searchCounts,
      promotionCounts,
      pricingCounts,
      paymentCounts,
      clarificationCases,
      instantOffers,
    ] = await Promise.all([
      this.clinical.countRecordsForConsultations(consultationIds),
      this.followup.countDataRightsRowsForConsultations(consultationIds),
      this.video.countParticipantRowsForConsultations(consultationIds),
      this.document.countDataRightsRowsForPatient({ patientId, consultationIds }),
      this.deletionRequests.countConsentsForPatient(patientId),
      this.feedback.countDataRightsRowsForPatient(patientId),
      this.carehub.countRecommendationsForConsultations(consultationIds),
      this.notification.countNotificationsForPatient(patientId),
      this.search.countDataRightsRowsForPatient(patientId),
      this.promotion.countDataRightsRowsForPatient({ patientId, consultationIds }),
      this.pricing.countDataRightsRowsForPatient({ patientId, consultationIds }),
      this.payment.countDataRightsRowsForConsultations(consultationIds),
      this.clarification.countCasesForConsultations(consultationIds),
      this.instant.countOffersForConsultations(consultationIds),
    ]);

    counts.set('consultations', consultationIds.length);
    counts.set('clinical_records', clinicalRecords);
    counts.set('checkin_responses', followupCounts.checkinResponses);
    counts.set('safety_alerts', followupCounts.safetyAlerts);
    counts.set('followup_assignments', followupCounts.followupAssignments);
    counts.set('consultation_participants', participants);
    counts.set('patient_files', documentCounts.patientFiles);
    counts.set('report_requests', documentCounts.reportRequests);
    counts.set('consents', consentsCount);
    counts.set('feedback', feedbackCounts.feedback);
    counts.set('complaints', feedbackCounts.complaints);
    counts.set('content_recommendations', recommendations);
    counts.set('notifications', notificationsCount);
    counts.set('search_queries', searchCounts.searchQueries);
    counts.set('search_rate_limits', searchCounts.searchRateLimits);
    counts.set('discount_instruments', promotionCounts.discountInstruments);
    counts.set('discount_redemptions', promotionCounts.discountRedemptions);
    counts.set('affiliate_attributions', promotionCounts.affiliateAttributions);
    counts.set('affiliate_commissions', promotionCounts.affiliateCommissions);
    counts.set('referral_events', promotionCounts.referralEvents);
    counts.set('promotion_code_attempts', promotionCounts.promotionCodeAttempts);
    counts.set('price_quotes', pricingCounts.priceQuotes);
    counts.set('price_quote_components', pricingCounts.priceQuoteComponents);
    counts.set('refund_components', pricingCounts.refundComponents);
    counts.set('payments', paymentCounts.payments);
    counts.set('refunds', paymentCounts.refunds);
    counts.set('payment_events', paymentCounts.paymentEvents);
    counts.set('clarification_cases', clarificationCases);
    counts.set('instant_consultancy', instantOffers);
    // 'audit_log' deliberately absent — see its STATIC_TABLE_SURVEY entry.

    return counts;
  }

  private async findRequestOrThrow(requestId: string): Promise<DataDeletionRequestRecord> {
    const request = await this.deletionRequests.getRequest(requestId);
    if (!request) {
      throw new NotFoundException({
        code: DATA_RIGHTS_ERROR_CODES.DATA_DELETION_REQUEST_NOT_FOUND,
        message: 'That data-deletion request does not exist.',
      });
    }
    return request;
  }
}
