import { Injectable, Logger } from '@nestjs/common';
import type { LegalDocumentType } from '../../schema/enums.schema';
import type { ConsentCheck, ConsentPort } from './video-consent.contract';

/**
 * The null object bound to `CONSENT_PORT` until `modules/consent` (M-03) is
 * merged — the direct counterpart of `instant`'s
 * `UnavailableNotificationProvider` (for `NOTIFICATION_PORT`), `booking`'s
 * `UnavailableBookingPaymentProvider` (for `BOOKING_PAYMENT_PORT`),
 * `document`'s `UnavailableDocumentStorageProvider` (for
 * `DOCUMENT_STORAGE_PORT`) and `search`'s `SearchAiNullProvider` (for
 * `SEARCH_AI_PORT`).
 *
 * *** IT REFUSES, AND IT DOES NOT THROW. ***
 *
 * Those are two separate decisions and both are deliberate.
 *
 * IT REFUSES — `hasCurrentConsent: false` — because this is a GATE. It is the
 * exact opposite of `UnavailableNotificationProvider`, whose own header
 * explains that "an instant consult with no PUSH notification is still an
 * instant consult". A teleconsultation with no consent is NOT a
 * teleconsultation: FR-8.5 issues a join token "after payment and consent
 * checks pass", and SRS 6.2 says "consent is captured before
 * teleconsultation" without qualification. A consent check that could not be
 * performed has not passed. The same reasoning `UnavailableBookingPaymentProvider`
 * applies to money is applied here to consent — a missing module must mean
 * "cannot join", never "join anyway", because the failure mode of the other
 * choice is a consultation held without a recorded consent and nobody finding
 * out until it matters legally.
 *
 * IT DOES NOT THROW — unlike the booking/payment and document/storage null
 * objects, which raise a 503 — because `ConsentPort#checkPatientConsent` is
 * documented as never throwing and always answering, and the real M-03
 * implementation must honour that too. The caller
 * (`video.service.ts#assertConsent`) turns `hasCurrentConsent: false` into a
 * clean `VIDEO_CONSENT_REQUIRED` conflict with a message a patient can act on,
 * which is a better answer than a 503 whether the cause is "you have not
 * consented yet" or "the consent module is not wired up". An operator tells the
 * two apart from the log line below and from `currentVersion: null`.
 *
 * *** THIS MEANS M-14 IS NOT DEMONSTRABLE END TO END UNTIL M-03 MERGES. ***
 * Every `POST /api/video/consultations/:id/token` refuses while this provider
 * is bound. That is CORRECT and INTENDED: the alternative is a video module
 * that appears to work in a demo and quietly skips a legal precondition in
 * production. Everything else in M-14 — the ownership check, the payment gate,
 * the join window, the room derivation, the webhook, the session metadata and
 * both status moves — is exercised by tests that bind a stub port, so the
 * refusal blocks the demo and not the development.
 *
 * It stays in the tree AFTER the merge, unbound: it is the null object this
 * module was built and tested against, and rebinding it here is the hard
 * kill-switch that takes video consultations out of service at the DI level
 * without a code change anywhere else.
 */
@Injectable()
export class UnavailableConsentProvider implements ConsentPort {
  private readonly logger = new Logger(UnavailableConsentProvider.name);

  async checkPatientConsent(input: {
    patientId: string;
    documentType: LegalDocumentType;
  }): Promise<ConsentCheck> {
    // `warn`, not `debug`: unlike the notification port — where the null object
    // fires on every routing attempt and a warning that is always true is a
    // warning nobody reads — this one fires only when somebody actually tried
    // to join a call and was refused. That is worth a line in the log, because
    // the operator's next question is "why can nobody join?" and this is the
    // answer.
    this.logger.warn(
      `No consent provider configured; refusing ${input.documentType} for patient ${input.patientId}. ` +
        'M-14 fails CLOSED on consent — bind CONSENT_PORT to ConsentFacade once M-03 is merged.',
    );
    return {
      hasCurrentConsent: false,
      acceptedVersion: null,
      acceptedAt: null,
      currentVersion: null,
    };
  }
}
