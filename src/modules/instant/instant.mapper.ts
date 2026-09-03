import type { MessageEvent } from '@nestjs/common';
import type { InstantConsultancyRow } from '../../schema/instant-consultancy.schema';
import type { DoctorPresenceState } from '../doctor/doctor.contract';
import type { InstantStreamEvent } from './instant-event.bus';
import type { InstantPresenceView, InstantRequestView } from './instant.contract';

/** `instant_consultancy` row -> the public view. A straight projection; the row has no internal-only column to strip. */
export function toInstantRequestView(row: InstantConsultancyRow): InstantRequestView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    doctorId: row.doctorId,
    attemptNumber: row.attemptNumber,
    outcome: row.outcome,
    offeredAt: row.offeredAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * M-05's `DoctorPresenceState` -> this module's view.
 *
 * `routable` is computed here, once, rather than left for each caller to
 * re-derive: it is the exact conjunction the routing candidate query applies
 * in SQL (`doctor.repository.ts#listInstantRoutingCandidates`), and two
 * copies of that predicate is how a listing badge ends up disagreeing with
 * what routing actually does.
 */
export function toInstantPresenceView(state: DoctorPresenceState): InstantPresenceView {
  return {
    doctorId: state.doctorId,
    presence: state.presence,
    allowInstantConsult: state.allowInstantConsult,
    blockedByConsultationId: state.blockedByConsultationId,
    routable:
      state.presence === 'available_now' &&
      state.allowInstantConsult &&
      state.blockedByConsultationId === null &&
      state.isVerifiedAndListed,
  };
}

/**
 * Stream event -> the `MessageEvent` shape Nest's `SseStream` reads.
 *
 * `type` becomes the SSE `event:` line, so a client subscribes per event type
 * rather than switching on a discriminator inside an opaque payload. `data`
 * carries the payload and NOTHING ELSE — this is why `ResponseInterceptor`
 * skips `@Sse()` routes: wrapping the whole object in `{ success, data }`
 * would turn `type` from a protocol field into a nested key and silently take
 * event typing away from every consumer (see that file's header).
 *
 * `doctorId` is deliberately NOT copied into the payload. The stream is
 * already scoped to one authenticated doctor, and echoing an account id into
 * a body is how one leaks.
 */
export function toMessageEvent(event: InstantStreamEvent): MessageEvent {
  return { type: event.type, data: event.data };
}
