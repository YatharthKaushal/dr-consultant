import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { LivekitClient } from './livekit.client';
import { VideoService } from './video.service';

/**
 * The two participants' side of the call (FR-8.1 to FR-8.6).
 *
 * *** ROUTE PREFIX: `/video/consultations/:id/...`, NOT `/consultations/:id/
 * video/...`. *** `/consultations` is already a SHARED prefix —
 * `document-consultation.controller.ts` owns `:id/report-requests` and
 * `:id/documents` under it, and its own header warns that M-11 will eventually
 * take routes there too. A third module reaching into that prefix makes the
 * route table something you have to read three files to understand, for no
 * gain. `/video` is this module's, entirely, and it is also where the webhook
 * lives (`VIDEO_WEBHOOK_PATH`), so one prefix covers the module.
 *
 * Every route derives the caller from `@CurrentUser()`, never a path or body
 * param, and *** OWNERSHIP FAILURES RETURN 404 RATHER THAN 403 *** so nobody
 * can probe for another patient's or another doctor's consultation. The
 * convention is stated in `instant.controller.ts`; the reasoning is in
 * `video.service.ts#resolveParticipant`.
 *
 * *** THIS MODULE ADDS NO PERMISSION. *** These four routes are
 * `@AccountType`-gated and then ownership-gated against the consultation
 * itself, which is stricter than any permission could be: `appointments.read`
 * would let any admin holding it mint a join token, and no admin should ever
 * hold one. The admin surface is `video-admin.controller.ts`, and it reuses
 * `appointments.read`/`appointments.manage`.
 */
@Controller('video')
@AccountType('patient', 'doctor')
export class VideoController {
  constructor(
    private readonly video: VideoService,
    private readonly livekit: LivekitClient,
  ) {}

  /**
   * FR-8.2's pre-call check needs a server URL before it needs a token: the
   * app can exercise camera and microphone permissions, and confirm it can
   * reach the LiveKit host at all, without holding a credential to a
   * consultation.
   *
   * *** DELIBERATELY CARRIES NO CONSULTATION ID AND NO TOKEN. *** Separating
   * the two is what lets the app run its device check while the patient is
   * still in the waiting room — before the join window opens, before the
   * doctor has accepted an instant request — and it means a failed pre-call
   * check never burns a short-lived token. `LIVEKIT_URL` is per deployment and
   * is not a secret (`docs/erd.sql` on `app_config`); the API SECRET is not
   * here and is not derivable from anything that is.
   */
  @Get('config')
  getClientConfig() {
    return { serverUrl: this.livekit.getServerUrl() };
  }

  /**
   * *** FR-8.5's GATE. *** Mints one short-lived join token, but only for the
   * assigned patient or doctor, and only after the payment and consent checks
   * pass. Every one of those checks is in `video.service.ts`, server side.
   *
   * `@HttpCode(200)`, not Nest's default 201 for a `@Post`: this creates no
   * row and no room — the room is a function of the consultation id
   * (`video-room.util.ts`) and LiveKit materialises it on the first join. It is
   * a POST rather than a GET because it is not safe to repeat blindly: each
   * call mints a fresh credential and writes an audit row.
   */
  @Post('consultations/:id/token')
  @HttpCode(HttpStatus.OK)
  issueToken(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.video.issueJoinTicket(id, auth);
  }

  /**
   * FR-8.6's session metadata for one consultation: every connection, per-party
   * totals, the derived duration and the no-show fact.
   *
   * Readable by BOTH sides. A patient is entitled to know how long their own
   * consultation ran — it is the thing they paid for, and it is the evidence
   * behind any complaint they raise about it.
   */
  @Get('consultations/:id/session')
  getSession(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.video.getSessionForCaller(id, auth);
  }

  /**
   * *** FR-8.4's CONSULTATION ROOM. *** Patient details, consent status, prior
   * history and the live session, composed from each owning facade and stored
   * nowhere.
   *
   * Doctor only, and it is the one route on this controller that narrows the
   * class-level `@AccountType`. `Reflector.getAllAndOverride` means a
   * method-level decorator REPLACES the class-level one rather than
   * intersecting with it (`document.controller.ts` documents the same trap), so
   * this reads as the whole allowed set and not as an addition.
   *
   * A patient has no business here: the screen exists to put a clinician's
   * working context beside the call, and it carries another party's profile.
   */
  @Get('consultations/:id/room')
  @AccountType('doctor')
  getConsultationRoom(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.video.getConsultationRoom(id, auth.accountId);
  }

  /**
   * The doctor's explicit End Consultation: `in_progress` ->
   * `awaiting_documentation`, and — for an instant consult — M-13's completion
   * gate.
   *
   * *** THE DOCTOR'S, AND NOT THE PATIENT'S. *** Ending a consultation puts
   * documentation on the doctor's list and, for an instant consult, takes them
   * out of the routing pool until it is written (FR-10.5). That is a clinical
   * act. A patient who hangs up simply leaves the room; LiveKit notices, the
   * room empties, and `room_finished` reaches the same code path — so nothing
   * is stuck if the doctor never taps the button.
   *
   * Idempotent: calling it twice, or calling it and then receiving
   * `room_finished`, moves the status once. See `VideoService#endSession`.
   */
  @Post('consultations/:id/end')
  @AccountType('doctor')
  @HttpCode(HttpStatus.OK)
  endSession(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.video.endSessionAsDoctor(id, auth);
  }
}
