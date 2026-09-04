/**
 * *** THE M-14 -> M-03 (CONSENT) SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/consent` is being built in a PARALLEL WORKTREE and does not exist in
 * this one, so a direct `import from '../consent/consent.contract'` would not
 * compile. This file declares the interface LOCALLY and it is bound to the
 * `CONSENT_PORT` DI token (`video.constants.ts`) — precisely the pattern
 * `instant/instant-notification.contract.ts` uses for
 * `NotificationPort`/`NOTIFICATION_PORT`, `booking/booking-payment.contract.ts`
 * for `BookingPaymentPort`/`BOOKING_PAYMENT_PORT`, `search/search-ai.contract
 * .ts` for `SearchAiPort`/`SEARCH_AI_PORT` and `document/document-storage
 * .contract.ts` for `DocumentStoragePort`/`DOCUMENT_STORAGE_PORT`.
 *
 * The types below are a VERBATIM mirror of `modules/consent`'s own FIXED
 * signature — the other worktree is implementing this exact shape, blind.
 * *** DO NOT RENAME A FIELD OR ADD A REQUIRED ARGUMENT. *** Because TypeScript
 * is structural, `ConsentFacade` will satisfy `ConsentPort` with no adapter, no
 * cast and no change on either side.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `CONSENT_PORT` FROM
 * `UnavailableConsentProvider` TO `ConsentFacade` IN `video.module.ts`. *** That
 * is the whole handover: one line in the `providers` array. If the consent
 * module's signature ever changes, change it HERE too — a structural mismatch
 * will surface as a `tsc` error at that binding, which is the point.
 *
 * Do NOT "fix" this into a cross-module import of `modules/consent`:
 * `backend/README.md` §2 says a module's only public surface is its facade,
 * resolved through DI, and the token is exactly that.
 *
 * ── WHY THIS PORT IS THE OPPOSITE OF THE NOTIFICATION ONE ──────────────────
 *
 * `UnavailableNotificationProvider` does not throw and does not refuse, because
 * M-13 is fully functional without push. *** THE NULL OBJECT HERE REFUSES. ***
 * FR-8.5 issues a join token "after payment and consent checks pass" and SRS
 * 6.2 states flatly that "consent is captured before teleconsultation". A
 * consent check that cannot be performed has therefore not passed, and the only
 * safe reading of a missing consent module is "cannot join" — never "join
 * anyway". It is a gate, like payment, not a courtesy, like a push.
 *
 * The consequence is deliberate and is worth writing down: *** M-14 IS NOT
 * DEMONSTRABLE END TO END UNTIL M-03 MERGES. *** Every join attempt refuses
 * with `VIDEO_CONSENT_REQUIRED` while `CONSENT_PORT` is bound to the null
 * object. That is correct behaviour, not a broken build — see
 * `unavailable-consent.provider.ts`.
 */

import type { LegalDocumentType } from '../../schema/enums.schema';

/** What M-03 hands back about one patient's standing on one legal document. */
export interface ConsentCheck {
  hasCurrentConsent: boolean;
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  currentVersion: string | null;
}

export interface ConsentPort {
  /** NEVER THROWS, and FAILS CLOSED — any failure answers `hasCurrentConsent: false`. */
  checkPatientConsent(input: { patientId: string; documentType: LegalDocumentType }): Promise<ConsentCheck>;
}
