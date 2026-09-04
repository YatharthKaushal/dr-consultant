import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CLINICAL_RECORD_FINALISED_EVENT, type ClinicalRecordFinalisedEvent } from '../clinical/clinical.contract';
import { BookingFacade } from '../booking/booking.facade';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { FollowupService } from './followup.service';

/**
 * *** THE M-15 -> M-16 SEAM, CLOSED. *** `FollowupService#assignPathway` had
 * no caller anywhere in the codebase until this listener — the module was
 * built, tested and merged as dead code from a real user's point of view.
 * Wired here, by the coordinator, exactly as `followup.service.ts
 * #assignPathway`'s own header anticipated.
 *
 * ── Why an event, and why THIS module resolves `pathwayCode` ──────────────
 *
 * `clinical -> followup` cannot be a direct call: `followup` already depends
 * on `ClinicalFacade` (for the Care Plan's prescription/warning-signs read),
 * so a direct call the other way closes a cycle. `CLINICAL_RECORD_FINALISED_EVENT`
 * inverts the RUNTIME direction while leaving the COMPILE-TIME direction
 * untouched — `clinical.contract.ts` documents the same reasoning
 * `booking-payment.listener.ts` gives for `PAYMENT_CAPTURED_EVENT`.
 *
 * The event carries only `consultationId` (`ClinicalConsultationView`, what
 * `finalise` has in hand, carries `specialtyId` but not `concernId`) — this
 * listener already depends on `BookingFacade` directly (M-11 is merged), so
 * it reads the full booking (specialty AND concern) itself rather than
 * widening `clinical`'s port for one event.
 *
 * ── The concern -> pathway mapping, and why it is a best-effort default ───
 *
 * `docs/MODULES.md` names five pathways: depression_anxiety, sleep,
 * substance_use, bipolar_psychosis, general. `concerns.schema.ts` names nine
 * concern codes, not a 1:1 match. This is a plain-word, reviewable mapping —
 * not a clinical judgment the platform is making, just which admin-authored
 * question set a patient starts on; `general` is the deliberate catch-all for
 * every concern this table does not name specifically, and for a booking
 * with no concern recorded at all.
 */
const CONCERN_TO_PATHWAY_CODE: Readonly<Record<string, string>> = {
  depression: 'depression_anxiety',
  anxiety: 'depression_anxiety',
  sleep: 'sleep',
  substance_use: 'substance_use',
  psychosis: 'bipolar_psychosis',
};
const DEFAULT_PATHWAY_CODE = 'general';

@Injectable()
export class FollowupClinicalListener {
  private readonly logger = new Logger(FollowupClinicalListener.name);

  constructor(
    private readonly followup: FollowupService,
    private readonly booking: BookingFacade,
    private readonly catalogue: CatalogueFacade,
  ) {}

  /**
   * Non-throwing throughout, matching every other best-effort consequence of
   * finalising (`clinical.service.ts#moveConsultationToCompleted`,
   * `#clearCompletionGate`): `@nestjs/event-emitter` would swallow a throw
   * here anyway (`suppressErrors` defaults to true), but catching it
   * ourselves is what lets the log name the consultation that failed.
   *
   * *** EXPECTED TO LOG-AND-SKIP UNTIL AN ADMIN HAS PUBLISHED AT LEAST ONE
   * CURRENT PATHWAY VERSION FOR EVERY CODE THIS MAPPING CAN PRODUCE. ***
   * `followup_pathways` ships with no seed data — `assignPathway` throws
   * `PATHWAY_NOT_FOUND` until `POST /admin/followup-pathways` has been used at
   * least once per code. That is a deployment/content gap, not a bug in this
   * listener.
   */
  @OnEvent(CLINICAL_RECORD_FINALISED_EVENT)
  async onRecordFinalised(event: ClinicalRecordFinalisedEvent): Promise<void> {
    try {
      const pathwayCode = await this.resolvePathwayCode(event.consultationId);
      const assignment = await this.followup.assignPathway({ consultationId: event.consultationId, pathwayCode });
      this.logger.log(
        `Consultation ${event.consultationId} assigned to follow-up pathway ${pathwayCode} (assignment ${assignment.id}).`,
      );
    } catch (error) {
      this.logger.error(
        `Consultation ${event.consultationId} finalised, but assigning a follow-up pathway failed: ${describeError(error)}`,
      );
    }
  }

  private async resolvePathwayCode(consultationId: string): Promise<string> {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking?.concernId) return DEFAULT_PATHWAY_CODE;

    const concern = await this.catalogue.getConcernById(booking.concernId);
    if (!concern) return DEFAULT_PATHWAY_CODE;

    return CONCERN_TO_PATHWAY_CODE[concern.code] ?? DEFAULT_PATHWAY_CODE;
  }
}

/** Local, same pattern every other sweep/listener in this codebase uses (e.g. `followup.service.ts`'s own copy) rather than a shared util. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
