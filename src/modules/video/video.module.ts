import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { InstantModule } from '../instant/instant.module';
import { PatientModule } from '../patient/patient.module';
import { PaymentModule } from '../payment/payment.module';
import { LivekitClient } from './livekit.client';
import { UnavailableConsentProvider } from './unavailable-consent.provider';
import { VideoAdminController } from './video-admin.controller';
import { VideoConfigService } from './video-config.service';
import { ConsentFacade } from '../consent/consent.facade';
import { ConsentModule } from '../consent/consent.module';
import { CONSENT_PORT } from './video.constants';
import { VideoController } from './video.controller';
import { VideoFacade } from './video.facade';
import { VideoRepository } from './video.repository';
import { VideoService } from './video.service';
import { VideoWebhookController } from './video-webhook.controller';
import { VideoWebhookService } from './video-webhook.service';

/**
 * M-14: Video Consultation.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; M-15 will consume `VideoFacade` via normal
 * constructor injection after importing `VideoModule`.
 *
 * `BookingModule`, `PaymentModule`, `PatientModule` and `InstantModule` are
 * real (non-global) imports, and this module reads and writes NOTHING of theirs
 * directly: it owns exactly one table, `consultation_participants`.
 * `consultations` goes through `BookingFacade`, `payments` through
 * `PaymentFacade`, `patients` through `PatientFacade`, and the instant
 * completion gate through `InstantFacade`. `DATABASE`, `AuditService` and
 * `AppConfigService` are all `@Global()`, so they need no `imports` entry.
 *
 * ---------------------------------------------------------------------------
 * *** THE ONE FACADE METHOD THIS MODULE ADDED, AND WHY IT IS NOT DRIFT ***
 *
 * FR-8.6's flow writes one column this module does not own:
 * `consultations.status`, moving to `in_progress` when the call starts and
 * `awaiting_documentation` when it ends — the two states nothing in this
 * codebase set before. Rather than reach into that table, its owner was
 * extended with a method that takes the LEGAL FROM-STATES as an argument:
 *
 *   `BookingFacade.transitionConsultationStatus`   M-14 owns the call's
 *                                                  lifecycle, M-11 owns the row
 *                                                  and the `FOR UPDATE`.
 *
 * It is a SIBLING of `transitionInstantConsultation` rather than a widening of
 * it: that method's `to` is type-narrowed to three values neither of M-14's is
 * among, and it refuses any row whose `mode` is not `'instant'` — while a video
 * call is the ORDINARY case of a scheduled consultation. See
 * `booking.contract.ts` for the full argument.
 *
 * The rule lives with the module that owns the requirement; the lock lives with
 * the module that owns the table. `tsc` checks the seam.
 *
 * ---------------------------------------------------------------------------
 * *** `CONSENT_PORT` IS THE M-03 SEAM, AND IT FAILS CLOSED. ***
 *
 * *** REBOUND. *** Now bound to `ConsentFacade` (M-03 merged), which satisfies
 * `ConsentPort` structurally — no adapter, no cast — because this module's
 * local mirror in `video-consent.contract.ts` and M-03's own contract were
 * frozen to the same shape before either was written. M-03 additionally keeps
 * a `consent.port-conformance.spec.ts` that re-declares this mirror and
 * assigns its facade to it, so a rename on that side fails `tsc` THERE rather
 * than here.
 *
 * `UnavailableConsentProvider` stays in the tree, unbound: it is the null
 * object this module was built and tested against, and rebinding it is the
 * hard kill-switch that takes video out of service at the DI level.
 *
 * *** UNLIKE M-13's NOTIFICATION PORT, THIS NULL OBJECT REFUSES. *** M-13 is
 * fully functional without push. M-14 is NOT functional without consent, and
 * must not pretend to be: FR-8.5 issues a token "after payment and consent
 * checks pass" and SRS 6.2 says "consent is captured before teleconsultation".
 * So *** EVERY JOIN REFUSES WITH `VIDEO_CONSENT_REQUIRED` UNTIL M-03 IS WIRED
 * UP ***, which is correct and intended rather than a broken build. Read
 * `unavailable-consent.provider.ts` before changing that binding.
 *
 * ---------------------------------------------------------------------------
 * *** NO ROOMS TABLE, NO TOKENS TABLE, NO MIGRATION. ***
 *
 * `docs/erd.sql` gives M-14 exactly one table and fixes the room as a function
 * of the consultation id ("parsed from the room name, which is a function of
 * this id"). A join token is a signed JWT the server can re-derive and never
 * needs to look up; storing one would be storing a credential. See
 * `video.constants.ts#VIDEO_ROOM_NAME_PREFIX` and `video-room.util.ts`.
 *
 * ---------------------------------------------------------------------------
 * *** NO SWEEP, AND THAT IS A DECISION. ***
 *
 * Every other stateful module here runs a `setInterval` sweep. This one does
 * not, because there is nothing for it to chase: a token expires by itself (the
 * `exp` claim, checked by LiveKit), a room disappears when it empties (LiveKit
 * owns its lifecycle), and a consultation left in `in_progress` because a
 * `room_finished` never arrived is a consultation whose DOCTOR is still looking
 * at it and can end it from the app.
 *
 * The one residual gap is honest and worth naming: a connection whose
 * `participant_left` was lost keeps `left_at` null forever, and
 * `video-session.util.ts` then reports that party's connected time as running
 * to now. It is visible on the session view rather than silent, and a sweep
 * that guessed an end time would be inventing session metadata — which is
 * exactly what FR-8.6 asks this module not to do.
 */
@Module({
  imports: [BookingModule, PaymentModule, PatientModule, InstantModule, ConsentModule],
  controllers: [VideoController, VideoAdminController, VideoWebhookController],
  providers: [
    VideoRepository,
    LivekitClient,
    // *** REFUSES. *** The coordinator swaps this line for
    // `{ provide: CONSENT_PORT, useExisting: ConsentFacade }` (and adds
    // `ConsentModule` to `imports`) once M-03 merges.
    { provide: CONSENT_PORT, useExisting: ConsentFacade },
    VideoConfigService,
    VideoService,
    VideoWebhookService,
    VideoFacade,
  ],
  exports: [VideoFacade],
})
export class VideoModule {}
