import { ConflictException, Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { BookingFacade } from '../booking/booking.facade';
import { CareHubFacade } from '../carehub/carehub.facade';
import { ClarificationFacade } from '../clarification/clarification.facade';
import { ClinicalFacade } from '../clinical/clinical.facade';
import { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import type { DataDeletionRequestRecord } from '../consent/data-deletion.types';
import { DocumentFacade } from '../document/document.facade';
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
import { DATA_RIGHTS_ERROR_CODES, STATIC_TABLE_SURVEY } from './data-rights.constants';
import type {
  DataRightsExecutionOutcome,
  DataRightsExecutionResult,
  DataRightsPreview,
  DataRightsStepOutcome,
  DataRightsTableEntry,
} from './data-rights.types';

/**
 * M-21's execution half: given an APPROVED `data_deletion_requests` row,
 * `previewExecution` computes and reports what would happen — writing
 * NOTHING — and `executeForRequest` is the separate, explicit admin action
 * that actually performs it. Both are documented at length in the coordinator's
 * build report; the short version:
 *
 *   - No sweep, no scheduler, no automatic trigger. Both methods are called
 *     ONLY from `data-rights-admin.controller.ts`'s two explicit HTTP routes,
 *     each gated on `compliance.manage_deletion_requests`.
 *   - This module owns no table of its own (like `GovernanceModule`) — every
 *     count, hard-delete and anonymize call goes through the owning module's
 *     facade. This service never opens a transaction that spans another
 *     module's write (`backend/README.md` §2 forbids a cross-module
 *     transaction) — see `executeForRequest`'s own header for how a PARTIAL
 *     failure is therefore represented honestly rather than hidden.
 *   - The compliance POLICY (which table is hard-deleted/anonymized/retained,
 *     and why) lives in `data-rights.constants.ts#STATIC_TABLE_SURVEY`, not
 *     scattered across the fifteen owning modules this service composes.
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
  ) {}

  /**
   * *** WRITES ABSOLUTELY NOTHING. *** Reads the request, reads every
   * owning module's live row count for this patient, and merges each with
   * `STATIC_TABLE_SURVEY`'s decision/reason. Safe to call any number of
   * times, in any request status — it is a report, not a precondition
   * check; `executeForRequest` is what enforces `status === 'approved'`.
   */
  async previewExecution(requestId: string): Promise<DataRightsPreview> {
    const request = await this.findRequestOrThrow(requestId);
    const consultationIds = await this.booking.listConsultationIdsForPatient(request.patientId);
    const tables = await this.buildTableEntries(request.patientId, consultationIds);

    return {
      requestId: request.id,
      patientId: request.patientId,
      requestStatus: request.status,
      tables,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Performs what the preview describes. Refuses (`ConflictException`)
   * unless the request is CURRENTLY `approved` — checked here, BEFORE any
   * table is touched, so a request in the wrong state fails closed with
   * nothing attempted; `DataDeletionExecutionFacade.recordExecutionOutcome`
   * enforces the identical precondition a second time at the final write,
   * which is defence in depth, not redundancy this method may skip.
   *
   * *** THE SEQUENCE, AND WHY IT IS NOT ONE TRANSACTION. *** Three owning
   * modules each perform ONE write: `search.deleteSearchQueriesForPatient`,
   * `promotion.anonymizePromotionCodeAttemptsForPatient`,
   * `patient.anonymizeForDeletion`. `backend/README.md` §2 forbids a
   * transaction spanning modules, so each call is its own commit, attempted
   * independently — a failure in one does NOT skip or roll back the others.
   * Order is deliberately least-consequential-first: `search_queries` and
   * `promotion_code_attempts` are pure hygiene with no downstream reader;
   * `patients` (identity, sessions, the account's ability to sign in) runs
   * last, once the record is confirmed genuinely necessary regardless.
   *
   * *** PARTIAL FAILURE, STATED HONESTLY. *** `deletion_status` has exactly
   * two outcomes this method may reach: `executed` (every step succeeded)
   * and `failed` (ANY step did not — one, two, or all three). There is no
   * third "partially executed" status in `DELETION_STATUSES`, so this
   * method never invents one; instead `executionOutcome.mutatingSteps`
   * carries a `status: 'success' | 'failed'` PER TABLE, which is the actual
   * honest record of what happened. A caller reading only `status: 'failed'`
   * knows execution did not fully complete; a caller reading
   * `executionOutcome` knows exactly which of the three tables it still
   * needs to retry.
   *
   * *** RETRY. *** `recordExecutionOutcome` refuses a request that is not
   * CURRENTLY `approved` — once this method has written `failed`, the
   * existing M-03 review state machine (`DataDeletionService
   * #LEGAL_REVIEW_TRANSITIONS`) has no transition OUT of `failed` back to
   * `approved`. That is a real, deliberate gap this build does not close:
   * retrying a partial failure today needs a manual/support intervention
   * (or a future added transition), not an automatic retry path — flagged
   * plainly here and in the coordinator's report rather than papered over
   * with a false "it just retries".
   */
  async executeForRequest(requestId: string, actorAdminId: string): Promise<DataRightsExecutionResult> {
    const request = await this.findRequestOrThrow(requestId);
    if (request.status !== 'approved') {
      throw new ConflictException({
        code: DATA_RIGHTS_ERROR_CODES.DATA_DELETION_NOT_APPROVED,
        message: `A request in "${request.status}" may not be executed — only an "approved" request may.`,
        currentStatus: request.status,
      });
    }

    const patientId = request.patientId;
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
      await this.runStep('patients', 'patient', 'anonymize', async () => {
        const { anonymized } = await this.patient.anonymizeForDeletion(patientId, actorAdminId);
        return anonymized ? 1 : 0;
      }),
    );

    const overallStatus: 'executed' | 'failed' = mutatingSteps.every((step) => step.status === 'success')
      ? 'executed'
      : 'failed';

    const executionOutcome: DataRightsExecutionOutcome = {
      requestId,
      patientId,
      executedAt: new Date().toISOString(),
      overallStatus,
      mutatingSteps,
      retainedTables,
    };

    if (overallStatus === 'failed') {
      this.logger.error(
        `Data-deletion execution for request ${requestId} (patient ${patientId}) did not fully complete: ${JSON.stringify(
          mutatingSteps.filter((s) => s.status === 'failed'),
        )}`,
      );
    }

    const updated = await this.deletionRequests.recordExecutionOutcome(actorAdminId, requestId, {
      status: overallStatus,
      executionOutcome,
    });

    return { requestId: updated.id, patientId: updated.patientId, status: overallStatus, executionOutcome };
  }

  /* ------------------------------------------------------------------ */

  /** Runs one mutating step, converting a throw into an honest `failed` entry rather than aborting the whole sequence. */
  private async runStep(
    table: string,
    module: string,
    decision: Extract<DataRightsTableEntry['decision'], 'hard_delete' | 'anonymize'>,
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

  /** Every table in the survey, decision + live row count — what `previewExecution` returns. */
  private async buildTableEntries(patientId: string, consultationIds: readonly string[]): Promise<DataRightsTableEntry[]> {
    const counts = await this.collectCounts(patientId, consultationIds);
    return STATIC_TABLE_SURVEY.map((entry) => ({ ...entry, rowCount: counts.get(entry.table) ?? null }));
  }

  /** Only the RETAIN rows, decision + live row count — what `executeForRequest` freezes into `execution_outcome.retainedTables`. */
  private async buildRetainedTableEntries(
    patientId: string,
    consultationIds: readonly string[],
  ): Promise<DataRightsTableEntry[]> {
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
