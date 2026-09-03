import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable, interval, merge, of } from 'rxjs';
import { map } from 'rxjs/operators';
import type { DoctorPresence } from '../../schema/enums.schema';
import { DoctorFacade } from '../doctor/doctor.facade';
import type { PresenceActor, PresenceTransitionResult } from '../doctor/doctor.contract';
import { InstantEventBus, type InstantStreamEvent } from './instant-event.bus';
import {
  BOOT_STALE_PRESENCE,
  DISCONNECT_CLEARS_PRESENCE,
  INSTANT_ERROR_CODES,
  LEGAL_PRESENCE_TRANSITIONS,
  PRESENCE_REQUIRING_NO_GATE,
  SELF_SETTABLE_PRESENCE,
  STREAM_KEEPALIVE_MS,
  type SelfSettablePresence,
} from './instant.constants';
import type { InstantPresenceView } from './instant.contract';
import { toInstantPresenceView, toMessageEvent } from './instant.mapper';

/**
 * *** FR-10.4's SEVEN-STATE MACHINE, AND THE REALTIME CHANNEL THAT CARRIES
 * IT. ***
 *
 * This service owns the RULES: which transitions are legal
 * (`LEGAL_PRESENCE_TRANSITIONS`), which a doctor may ask for themselves
 * (`SELF_SETTABLE_PRESENCE`), which require the completion gate to be clear
 * (`PRESENCE_REQUIRING_NO_GATE`), and what happens when a stream opens or
 * closes. It owns none of the WRITES — every one goes through
 * `DoctorFacade.transitionPresence`, which takes the row lock and enforces the
 * `from` set this service hands it. See `doctor-presence.service.ts`'s header
 * for the whole boundary argument.
 *
 * ── WHY SSE AND NOT WEBSOCKETS ─────────────────────────────────────────────
 *
 * The traffic is one-directional: the server pushes offers and presence
 * changes, and the doctor answers over ordinary authenticated `POST`s. A
 * WebSocket would add a second transport, a second auth path (a bearer token
 * cannot travel in a browser WebSocket header, so it would have to move into a
 * query string or a post-connect handshake) and a second set of proxy
 * concerns, to carry traffic that flows one way. SSE is a plain `GET` that
 * `JwtAuthGuard` and `AccountTypeGuard` already protect exactly like every
 * other route, and it reconnects on its own.
 *
 * `@Sse()` works on the Fastify adapter: `@nestjs/core`'s
 * `router-execution-context.js` unwraps `res.raw`/`req.raw` before handing
 * them to `SseStream`. The one thing that had to be fixed for it is
 * `ResponseInterceptor`, which now skips `SSE_METADATA` handlers — see that
 * file's header for what wrapping an SSE frame would have corrupted.
 *
 * ── PRESENCE IS THE CHANNEL'S FACT, NOT A HEARTBEAT COLUMN ─────────────────
 *
 * `docs/erd.sql` on `doctors`: "No `last_heartbeat_at`: presence is carried on
 * the realtime channel (M-13), so the socket already knows who is live — its
 * disconnect handler, and a sweep at boot, write `presence = offline`. A
 * heartbeat column is a row write per online doctor every few seconds for a
 * fact the channel holds already." Both halves of that are implemented here:
 * `openStream`'s teardown, and `onModuleInit`'s boot sweep.
 */
@Injectable()
export class InstantPresenceService implements OnModuleInit {
  private readonly logger = new Logger(InstantPresenceService.name);

  /**
   * Open streams per doctor. A doctor with a phone and a tablet holds two, and
   * only the LAST one closing means they have actually gone — going offline
   * because one of two devices locked its screen would drop them out of the
   * routing pool while they are still sitting there watching.
   *
   * In-process, like the event bus, and stale after a restart for the same
   * reason — which is exactly what the boot sweep exists to correct.
   */
  private readonly openStreams = new Map<string, number>();

  constructor(
    private readonly doctors: DoctorFacade,
    private readonly events: InstantEventBus,
  ) {}

  /**
   * THE BOOT SWEEP. After a restart no stream exists, so every doctor the
   * previous process left in a live state is a lie the next routing decision
   * would act on. See `BOOT_STALE_PRESENCE` for exactly which states are reset
   * and — more importantly — which two are deliberately not.
   *
   * Never throws into boot: a database that is not ready yet must not stop the
   * process from starting, and the only cost of a failed sweep is that some
   * doctors look available until their next transition. Routing still refuses
   * to hand a request to a doctor who is not really there — the offer simply
   * times out and re-routes, which is FR-10.6 doing its job.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { doctorIds } = await this.doctors.resetPresence({
        from: BOOT_STALE_PRESENCE,
        to: 'offline',
        actor: SYSTEM_ACTOR,
        reason: 'boot_sweep_no_live_stream',
      });
      if (doctorIds.length > 0) {
        this.logger.log(`Boot presence sweep: ${doctorIds.length} doctor(s) reset to offline.`);
      }
    } catch (error) {
      this.logger.error(`Boot presence sweep failed; stale presence will clear on next transition. ${describeError(error)}`);
    }
  }

  /* ── Reads ─────────────────────────────────────────────────────────────── */

  async getPresence(doctorId: string): Promise<InstantPresenceView | null> {
    const state = await this.doctors.getPresenceState(doctorId);
    return state ? toInstantPresenceView(state) : null;
  }

  /** The doctor's own presence screen. 404 rather than a null body — the caller is the doctor, so a missing row is a broken account, not an empty answer. */
  async getOwnPresence(doctorId: string): Promise<InstantPresenceView> {
    const view = await this.getPresence(doctorId);
    if (!view) throw doctorNotFound();
    return view;
  }

  /* ── The doctor's own transitions ──────────────────────────────────────── */

  /**
   * `PUT /doctors/me/presence`. The only presence write a doctor can ask for
   * directly, and the one place FR-10.5 has to be unbypassable.
   *
   * THREE GUARDS, IN THIS ORDER, AND THE ORDER MATTERS:
   *
   *   1. `SELF_SETTABLE_PRESENCE` — `request_pending`, `in_consultation` and
   *      `completing_notes` are facts about work in flight, not preferences.
   *      A doctor asserting `completing_notes` by hand, or asserting
   *      `available_now` FROM it, would be writing their own documentation
   *      sign-off.
   *   2. `LEGAL_PRESENCE_TRANSITIONS[to]` — the state machine, passed to M-05
   *      and enforced by it inside the row lock, never checked here against a
   *      value read a moment ago.
   *   3. *** THE COMPLETION GATE. *** `requireNotGated` on any move INTO a
   *      routable state, applied as one predicate in the same atomic UPDATE
   *      (`doctor.repository.ts#updatePresenceIfIn`). It is not a read-then-
   *      write and there is no window between checking it and acting on it.
   *
   * The gate is enforced a SECOND time, independently, in the routing
   * candidate query: a gated doctor is not a candidate whatever their presence
   * says. Either one alone would close the hole; both are here because this
   * is the requirement `docs/MODULES.md` names in M-13's done-when bar ("the
   * completion gate cannot be bypassed"), and one mechanism is one edit away
   * from being none.
   */
  async setOwnPresence(doctorId: string, to: SelfSettablePresence): Promise<InstantPresenceView> {
    if (!(SELF_SETTABLE_PRESENCE as readonly DoctorPresence[]).includes(to)) {
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.PRESENCE_NOT_SELF_SETTABLE,
        message: 'That status is set by the system, not by you.',
      });
    }

    const result = await this.transition({
      doctorId,
      to,
      actor: { actorType: 'doctor', actorId: doctorId },
      reason: 'doctor_self_service',
    });

    this.throwForRefusal(result);
    return this.getOwnPresence(doctorId);
  }

  /* ── System transitions (routing, accepting, the sweeps) ───────────────── */

  /**
   * The shared write path for every presence change in this module, doctor-
   * driven or system-driven.
   *
   * Computes the legal `from` set from the transition table, adds
   * `requireNotGated` where the table says the target is routable, delegates
   * the write to M-05, and — only on a real change — broadcasts it. Returns
   * M-05's result unchanged, including its `refusal`, because the two classes
   * of caller want opposite things from a refusal: a controller turns it into
   * an error, and a sweep ignores it and moves to the next candidate.
   */
  async transition(input: {
    doctorId: string;
    to: DoctorPresence;
    actor: PresenceActor;
    reason?: string;
  }): Promise<PresenceTransitionResult> {
    const result = await this.doctors.transitionPresence({
      doctorId: input.doctorId,
      to: input.to,
      from: LEGAL_PRESENCE_TRANSITIONS[input.to],
      requireNotGated: (PRESENCE_REQUIRING_NO_GATE as readonly DoctorPresence[]).includes(input.to),
      actor: input.actor,
      reason: input.reason,
    });

    if (result.changed) {
      this.publish({
        doctorId: input.doctorId,
        type: 'presence',
        data: {
          presence: result.after,
          previousPresence: result.before,
          blockedByConsultationId: result.blockedByConsultationId ?? null,
        },
      });
    }

    return result;
  }

  /** Turns M-05's refusal vocabulary into this module's error codes. A no-op (`changed: false` with no refusal) is a success and returns silently. */
  throwForRefusal(result: PresenceTransitionResult): void {
    if (!result.refusal) return;

    if (result.refusal === 'doctor_not_found') throw doctorNotFound();

    if (result.refusal === 'completion_gated') {
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.COMPLETION_GATE_ACTIVE,
        message: 'Finish the notes and case summary for your last instant consultation first.',
        blockedByConsultationId: result.blockedByConsultationId ?? null,
      });
    }

    throw new ConflictException({
      code: INSTANT_ERROR_CODES.PRESENCE_TRANSITION_NOT_ALLOWED,
      message: 'You cannot move to that status from where you are.',
      currentPresence: result.before,
    });
  }

  /* ── Broadcast ─────────────────────────────────────────────────────────── */

  /**
   * Fire-and-forget onto the doctor's channel. Wrapped so a broken stream can
   * never fail the flow that triggered it: a doctor whose screen is a few
   * seconds stale is a far better outcome than a routing attempt that throws,
   * and `GET /doctors/me/instant-requests` is the durable answer either way.
   */
  publish(event: InstantStreamEvent): void {
    try {
      this.events.publish(event);
    } catch (error) {
      this.logger.warn(`Could not publish "${event.type}" to doctor ${event.doctorId}: ${describeError(error)}`);
    }
  }

  /* ── The stream itself ─────────────────────────────────────────────────── */

  /**
   * One doctor's SSE stream.
   *
   * Built with an explicit `new Observable` rather than a bare pipe so the
   * SUBSCRIBE and TEARDOWN sides are both ours: Nest subscribes when the
   * request arrives and unsubscribes when the response closes, so the teardown
   * function below is the disconnect handler `docs/erd.sql` describes.
   *
   * Three sources are merged:
   *   `stream_ready`  once, immediately — a client must be able to tell "open
   *                   and quiet" from "still connecting".
   *   the doctor's events from the bus.
   *   a keep-alive every `STREAM_KEEPALIVE_MS`, because an idle response body
   *   is what proxies and mobile networks close first.
   */
  openStream(doctorId: string): Observable<MessageEvent> {
    return new Observable<InstantStreamEvent>((subscriber) => {
      this.registerStream(doctorId);

      const subscription = merge(
        of<InstantStreamEvent>({ doctorId, type: 'stream_ready', data: { at: new Date().toISOString() } }),
        this.events.streamFor(doctorId),
        interval(STREAM_KEEPALIVE_MS).pipe(
          map<number, InstantStreamEvent>(() => ({ doctorId, type: 'keepalive', data: {} })),
        ),
      ).subscribe(subscriber);

      return () => {
        subscription.unsubscribe();
        // `void`: teardown is synchronous and cannot be awaited, and a failure
        // to write `offline` must not become an unhandled rejection. The boot
        // sweep and the next transition both correct a missed write.
        void this.releaseStream(doctorId);
      };
    }).pipe(map(toMessageEvent));
  }

  private registerStream(doctorId: string): void {
    this.openStreams.set(doctorId, (this.openStreams.get(doctorId) ?? 0) + 1);
  }

  /**
   * *** THE DISCONNECT HANDLER. *** The last stream for this doctor closed, so
   * nothing is carrying their presence any more: write `offline`.
   *
   * `DISCONNECT_CLEARS_PRESENCE` is the same list as
   * `LEGAL_PRESENCE_TRANSITIONS.offline`, and its two exclusions are the whole
   * point — `in_consultation` and `completing_notes` are NOT reset by a
   * dropped socket. A doctor on a train who loses signal mid-consult must not
   * come back to find the consult abandoned, and — the one that matters —
   * *** BACKGROUNDING THE APP MUST NOT CLEAR THE COMPLETION GATE. *** If
   * `completing_notes` were reset here, FR-10.5 would be bypassable by
   * locking the phone.
   */
  private async releaseStream(doctorId: string): Promise<void> {
    const remaining = (this.openStreams.get(doctorId) ?? 1) - 1;
    if (remaining > 0) {
      this.openStreams.set(doctorId, remaining);
      return;
    }
    this.openStreams.delete(doctorId);

    try {
      await this.doctors.transitionPresence({
        doctorId,
        to: 'offline',
        from: DISCONNECT_CLEARS_PRESENCE,
        actor: SYSTEM_ACTOR,
        reason: 'stream_closed',
      });
    } catch (error) {
      this.logger.error(`Could not set doctor ${doctorId} offline after their stream closed: ${describeError(error)}`);
    }
  }

  /** Test/diagnostic read: how many streams this process is holding for a doctor. */
  openStreamCount(doctorId: string): number {
    return this.openStreams.get(doctorId) ?? 0;
  }
}

/** The actor on every presence write this module makes on its own initiative — routing, the sweeps, the boot reset, a closed stream. */
export const SYSTEM_ACTOR: PresenceActor = { actorType: 'system', actorId: null };

export function doctorNotFound(): NotFoundException {
  return new NotFoundException({ code: INSTANT_ERROR_CODES.DOCTOR_NOT_FOUND, message: 'Doctor not found.' });
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
