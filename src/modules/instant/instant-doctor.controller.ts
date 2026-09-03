import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { InstantPresenceService } from './instant-presence.service';
import { SetPresenceDto } from './instant.dto';
import { InstantService } from './instant.service';

/**
 * The doctor's side of Available Now: presence, the realtime channel, and the
 * two answers a doctor can give an offer.
 *
 * Prefix is `doctors/me`, matching `availability.controller.ts`'s own
 * `@Controller('doctors/me')` self-service convention — the doctor id is never
 * a path param, always `@CurrentUser()`. The sub-paths (`presence`, `stream`,
 * `instant-requests/...`) share no segment with that controller's
 * (`availability/...`, `slots`) or with `booking-doctor.controller.ts`'s
 * (`doctors/me/bookings`), so there is no route ambiguity to resolve.
 *
 * ── THE STREAM IS SSE, AND THAT WAS A DECISION ─────────────────────────────
 *
 * See `instant-presence.service.ts`'s header for the full argument. The short
 * version: the traffic is one-directional, so a WebSocket would buy a second
 * transport and a second auth path to carry it. `GET /api/doctors/me/stream`
 * is an ordinary authenticated route that `JwtAuthGuard` and
 * `AccountTypeGuard` protect exactly like every other one, it reconnects on
 * its own, and `ResponseInterceptor` already knows to leave `@Sse()` handlers
 * alone (see that file — wrapping an SSE frame silently destroys event typing).
 */
@Controller('doctors/me')
@AccountType('doctor')
export class InstantDoctorController {
  constructor(
    private readonly instant: InstantService,
    private readonly presence: InstantPresenceService,
  ) {}

  /* ── Presence (FR-10.4) ────────────────────────────────────────────────── */

  @Get('presence')
  getPresence(@CurrentUser() auth: AuthContext) {
    return this.presence.getOwnPresence(auth.accountId);
  }

  /**
   * The doctor's own presence change — Available Now, Paused, Scheduled Only
   * or Offline.
   *
   * *** THIS IS THE ENDPOINT FR-10.5 MUST NOT BE BYPASSABLE FROM. *** A doctor
   * who owes documentation cannot reach `available_now` through it: the
   * completion gate is applied as a predicate inside the same atomic UPDATE
   * that moves the column (`doctor.repository.ts#updatePresenceIfIn`), so
   * there is no read-then-write window, and the routing candidate query
   * enforces it a second time regardless of what presence says.
   *
   * `PUT`, not `PATCH`: the body carries the complete new state of a
   * single-valued resource, which is what `availability.controller.ts` uses
   * `PUT` for too.
   */
  @Put('presence')
  setPresence(@CurrentUser() auth: AuthContext, @Body() dto: SetPresenceDto) {
    return this.presence.setOwnPresence(auth.accountId, dto.presence);
  }

  /**
   * *** THE REALTIME CHANNEL. *** Instant requests, withdrawals and presence
   * changes, pushed as they happen.
   *
   * Returns an `Observable<MessageEvent>` and nothing else — no `res`, no
   * manual writes. Nest's `SseStream` owns the wire format, which is why
   * `instant.mapper.ts#toMessageEvent` emits `{ type, data }` and why the
   * response interceptor must not wrap it.
   *
   * *** CLOSING THIS STREAM SETS `presence = 'offline'`, *** which is the
   * mechanism `docs/erd.sql` names when it explains why `doctors` carries no
   * `last_heartbeat_at`. Not for a doctor who is `in_consultation` or
   * `completing_notes` though — see `InstantPresenceService#releaseStream` for
   * why backgrounding the app must not clear the completion gate.
   */
  @Sse('stream')
  stream(@CurrentUser() auth: AuthContext): Observable<MessageEvent> {
    return this.presence.openStream(auth.accountId);
  }

  /* ── Instant requests (FR-10.2 / FR-10.6) ──────────────────────────────── */

  /**
   * The offers waiting for an answer right now.
   *
   * The RECONNECT path, and the reason the event bus deliberately has no
   * replay: a stream carries no history, so a doctor whose app was closed
   * reads the table instead — which can only ever return offers that are
   * genuinely still open, where a replayed event could show one whose window
   * closed minutes ago.
   */
  @Get('instant-requests')
  listRequests(@CurrentUser() auth: AuthContext) {
    return this.instant.listPendingForDoctor(auth.accountId);
  }

  /**
   * FR-10.2's acceptance. Everything after it — the gateway order, attaching
   * the doctor, the payment window — happens inside `InstantService#accept`;
   * see its doc comment for the compensation on each step.
   *
   * `@HttpCode(OK)` because answering an offer CREATES nothing: it transitions
   * a row that already exists. Same reasoning as `booking.controller.ts#cancel`.
   */
  @Post('instant-requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.instant.accept(id, auth.accountId);
  }

  /** FR-10.6's decline. The next doctor is offered the request with NO patient action. */
  @Post('instant-requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.instant.decline(id, auth.accountId);
  }

  /**
   * *** SETS THE COMPLETION GATE (FR-10.5). *** The consult is over: this
   * doctor takes no new instant request until the prescription-or-advice and
   * the case summary are done.
   *
   * M-14 will call this through `InstantFacade` when the call ends, and M-15
   * clears it when the clinical record is finalised. It is exposed to the
   * doctor as well so `completing_notes` — and therefore the gate — is
   * reachable end to end before either of those modules exists, which is M-13's
   * done-when bar ("every state is reachable"). There is deliberately no
   * doctor-facing route to CLEAR it: that is M-15's decision to make from a
   * finalised record, never a doctor's to make from a button.
   */
  @Post('instant-consults/:consultationId/end')
  @HttpCode(HttpStatus.OK)
  endConsult(
    @CurrentUser() auth: AuthContext,
    @Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string,
  ) {
    // Ownership is checked in the service, and a consultation that is not this
    // doctor's returns the same 404 a stranger gets — without it, any doctor
    // could gate any other doctor.
    return this.instant.markOwnInstantConsultEnded(consultationId, auth.accountId);
  }
}
