import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';

/** The event types pushed down a doctor's realtime channel. */
export type InstantStreamEventType =
  /** The stream is open. Sent once on connect so a client can distinguish "connected" from "connected but silent". */
  | 'stream_ready'
  /** A new instant request has been offered to this doctor, with the seconds left to answer. */
  | 'instant_request'
  /** An outstanding offer is no longer answerable — it timed out, or the request was released or cancelled. */
  | 'instant_request_withdrawn'
  /** This doctor's own accept/decline landed. Sent so a doctor's OTHER devices stop showing the request. */
  | 'instant_request_settled'
  /** This doctor's `presence` changed, including changes the system made (routing, accepting, the completion gate). */
  | 'presence'
  /** Keep-alive. Carries no meaning; it exists so an idle stream is not closed by a proxy. */
  | 'keepalive';

/** One event on one doctor's channel. `data` is JSON-safe and NEVER carries clinical content (FR-16.2) — see `InstantEventPublisher`. */
export interface InstantStreamEvent {
  doctorId: string;
  type: InstantStreamEventType;
  data: Record<string, unknown>;
}

/**
 * *** THE ONE-METHOD BROADCAST SEAM. ***
 *
 * Everything that pushes to a doctor in this module goes through `publish`,
 * and nothing else. That is the whole reason this interface exists: the
 * in-process implementation below is correct for ONE process and only one, and
 * when a second is added the replacement is a Postgres `LISTEN`/`NOTIFY`
 * implementation of this single method plus the matching subscribe — not an
 * edit to the router, the sweeps, the presence service or the controller.
 *
 * See `instant.module.ts` for why one process is the right answer at launch
 * scale, and for what has to change before it is not.
 */
export interface InstantEventPublisher {
  /**
   * Fire-and-forget. MUST NOT throw and MUST NOT be awaited into a caller's
   * flow: a consult that fails because a UI event could not be delivered is a
   * worse outcome than a doctor whose screen is a few seconds stale, and the
   * doctor's polling endpoints (`GET /doctors/me/instant-requests`) are the
   * durable answer either way.
   */
  publish(event: InstantStreamEvent): void;
}

/**
 * The in-process implementation: one RxJS `Subject`, fanned out to each
 * doctor's stream by a `filter` on `doctorId`.
 *
 * *** SINGLE INSTANCE ONLY, AND DELIBERATELY SO. *** A doctor connected to
 * process A does not receive an event published by process B. At launch scale
 * — `docs/SRS.md` §6.4, "the system handles launch-scale traffic ... and can
 * scale by adding resources" — the backend is one process, so this is correct
 * rather than merely convenient, and it costs no infrastructure, no
 * reconnection logic and no message broker to run.
 *
 * WHAT MUST CHANGE BEFORE A SECOND INSTANCE IS ADDED: replace this class with
 * one that publishes through Postgres `NOTIFY` on a channel per doctor (or one
 * channel with a doctor id in the payload) and feeds `streamFor` from a
 * dedicated `LISTEN` connection. Postgres is already a hard dependency, so
 * that needs no new service. Nothing else in this module changes, because
 * nothing else in this module knows how an event travels.
 *
 * The failure mode if that is forgotten is quiet, which is why it is written
 * down here and in `instant.module.ts` rather than left implicit: a doctor on
 * the wrong instance simply never sees the request appear, the acceptance
 * window runs out, and the sweep re-routes it to somebody else. Nothing errors.
 */
@Injectable()
export class InstantEventBus implements InstantEventPublisher {
  private readonly events = new Subject<InstantStreamEvent>();

  publish(event: InstantStreamEvent): void {
    this.events.next(event);
  }

  /**
   * One doctor's slice of the stream. Hot and multicast: a doctor with two
   * devices open gets two independent subscriptions to the same `Subject`, and
   * an event published while nobody is listening is simply not delivered —
   * there is no replay, on purpose. A stale offer replayed on reconnect would
   * show a doctor a request whose window closed minutes ago; the reconnect
   * path is `GET /doctors/me/instant-requests`, which reads the table and can
   * only ever return offers that are genuinely still open.
   */
  streamFor(doctorId: string): Observable<InstantStreamEvent> {
    return this.events.asObservable().pipe(filter((event) => event.doctorId === doctorId));
  }
}
