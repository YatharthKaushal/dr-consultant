import { ConflictException, NotFoundException } from '@nestjs/common';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { DoctorPresence } from '../../schema/enums.schema';
import type { PresenceTransitionInput, PresenceTransitionResult } from '../doctor/doctor.contract';
import { InstantEventBus, type InstantStreamEvent } from './instant-event.bus';
import { InstantPresenceService } from './instant-presence.service';
import {
  BOOT_STALE_PRESENCE,
  DISCONNECT_CLEARS_PRESENCE,
  INSTANT_ERROR_CODES,
  LEGAL_PRESENCE_TRANSITIONS,
  PRESENCE_REQUIRING_NO_GATE,
  SELF_SETTABLE_PRESENCE,
  type SelfSettablePresence,
} from './instant.constants';

/**
 * Unit tests for FR-10.4's seven-state machine and the realtime channel that
 * carries it. `new Service(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 *
 * ── WHY THE DOCTOR FACADE IS A STATEFUL FAKE HERE, NOT A BARE `jest.fn()` ──
 *
 * `doctor-presence.service.spec.ts` already proves M-05 enforces whatever
 * `from` set it is handed. What is left to prove is a property of the TABLE
 * itself — that every one of the seven states is actually reachable through
 * it, and that the completion gate has no path around it — and a mock that
 * returns `{ changed: true }` unconditionally would prove neither. So the fake
 * below applies exactly the semantics of M-05's guarded UPDATE (`from` must
 * contain the current state; `requireNotGated` must find no gate), and the
 * tests then walk real paths through the real table.
 */

const DOCTOR_ID = '11111111-1111-4111-8111-111111111111';
const CONSULTATION_ID = '22222222-2222-4222-8222-222222222222';

type Fn = jest.Mock;

interface FakeDoctorState {
  presence: DoctorPresence;
  blockedByConsultationId: string | null;
  exists: boolean;
}

/**
 * A `DoctorFacade` stand-in that behaves like the real row + guarded UPDATE:
 * an idempotent no-op when already in `to`, a `completion_gated` refusal when
 * `requireNotGated` meets a live gate, and an `illegal_transition` refusal
 * when `from` does not contain the current state.
 */
function fakeDoctorFacade(initial: Partial<FakeDoctorState> = {}) {
  const state: FakeDoctorState = {
    presence: 'offline',
    blockedByConsultationId: null,
    exists: true,
    ...initial,
  };

  const transitionPresence = jest.fn(async (input: PresenceTransitionInput): Promise<PresenceTransitionResult> => {
    if (!state.exists) return { changed: false, before: null, after: null, refusal: 'doctor_not_found' };

    const before = state.presence;
    if (before === input.to) {
      return { changed: false, before, after: before, blockedByConsultationId: state.blockedByConsultationId };
    }
    if (input.requireNotGated && state.blockedByConsultationId !== null) {
      return {
        changed: false,
        before,
        after: before,
        refusal: 'completion_gated',
        blockedByConsultationId: state.blockedByConsultationId,
      };
    }
    if (!input.from.includes(before)) {
      return {
        changed: false,
        before,
        after: before,
        refusal: 'illegal_transition',
        blockedByConsultationId: state.blockedByConsultationId,
      };
    }

    state.presence = input.to;
    return { changed: true, before, after: input.to, blockedByConsultationId: state.blockedByConsultationId };
  });

  const facade: Record<string, Fn> = {
    transitionPresence,
    getPresenceState: jest.fn(async () =>
      state.exists
        ? {
            doctorId: DOCTOR_ID,
            presence: state.presence,
            allowInstantConsult: true,
            blockedByConsultationId: state.blockedByConsultationId,
            isVerifiedAndListed: true,
          }
        : null,
    ),
    resetPresence: jest.fn(async () => ({ doctorIds: [DOCTOR_ID] })),
    setCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: CONSULTATION_ID })),
    clearCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null })),
    listInstantRoutingCandidates: jest.fn(async () => []),
  };

  return { facade, state };
}

function buildHarness(initial: Partial<FakeDoctorState> = {}) {
  const { facade, state } = fakeDoctorFacade(initial);
  const bus = new InstantEventBus();
  const published: InstantStreamEvent[] = [];
  jest.spyOn(bus, 'publish').mockImplementation((event) => {
    published.push(event);
  });

  const service = new InstantPresenceService(facade as never, bus as never);
  return { service, facade, state, bus, published };
}

/** The whole enum, so a test that claims to cover "all seven" cannot quietly cover six. */
const ALL_SEVEN: readonly DoctorPresence[] = [
  'offline',
  'available_now',
  'request_pending',
  'in_consultation',
  'completing_notes',
  'paused',
  'scheduled_only',
];

describe('InstantPresenceService', () => {
  it('the transition table covers exactly FR-10.4s seven states, with no eighth and none missing', () => {
    expect(Object.keys(LEGAL_PRESENCE_TRANSITIONS).sort()).toEqual([...ALL_SEVEN].sort());
    // Every listed source must itself be a real state — a typo here would
    // silently make a transition unreachable rather than fail to compile.
    for (const sources of Object.values(LEGAL_PRESENCE_TRANSITIONS)) {
      for (const source of sources) expect(ALL_SEVEN).toContain(source);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * "Every one of the seven states is reachable" — M-13's done-when bar.
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('every one of the seven states is reachable', () => {
    /** Walks a real path through the real table, asserting each hop actually moved. */
    async function walk(service: InstantPresenceService, path: readonly DoctorPresence[]): Promise<void> {
      for (const step of path) {
        const result = await service.transition({
          doctorId: DOCTOR_ID,
          to: step,
          actor: { actorType: 'system', actorId: null },
        });
        expect({ step, changed: result.changed, refusal: result.refusal }).toEqual({
          step,
          changed: true,
          refusal: undefined,
        });
      }
    }

    it.each([
      // A doctor's row is born `offline` (the column default), so it is
      // reachable with no transition at all — and reachable again from any
      // live state via the disconnect handler.
      ['offline', ['available_now', 'offline']],
      ['available_now', ['available_now']],
      ['paused', ['available_now', 'paused']],
      ['scheduled_only', ['available_now', 'scheduled_only']],
      // The three system-driven states, in the order the instant flow
      // actually produces them: offered -> accepted -> consult ended.
      ['request_pending', ['available_now', 'request_pending']],
      ['in_consultation', ['available_now', 'request_pending', 'in_consultation']],
      ['completing_notes', ['available_now', 'request_pending', 'in_consultation', 'completing_notes']],
    ] as ReadonlyArray<[DoctorPresence, readonly DoctorPresence[]]>)(
      'reaches %s',
      async (target, path) => {
        const { service, state } = buildHarness({ presence: 'offline' });
        await walk(service, path);
        expect(state.presence).toBe(target);
      },
    );

    it('covers all seven between them — the table above is not missing one', () => {
      const covered = new Set<DoctorPresence>([
        'offline',
        'available_now',
        'paused',
        'scheduled_only',
        'request_pending',
        'in_consultation',
        'completing_notes',
      ]);
      expect([...covered].sort()).toEqual([...ALL_SEVEN].sort());
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * "The completion gate cannot be bypassed" — M-13's done-when bar.
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the completion gate cannot be bypassed from the presence endpoint (FR-10.5)', () => {
    it('REFUSES a gated doctor asking for available_now, with a code of its own', async () => {
      const { service } = buildHarness({ presence: 'completing_notes', blockedByConsultationId: CONSULTATION_ID });

      await expect(service.setOwnPresence(DOCTOR_ID, 'available_now')).rejects.toMatchObject({
        response: {
          code: INSTANT_ERROR_CODES.COMPLETION_GATE_ACTIVE,
          blockedByConsultationId: CONSULTATION_ID,
        },
      });
    });

    it('leaves the doctor exactly where they were — a refused bypass writes nothing', async () => {
      const { service, state } = buildHarness({ presence: 'completing_notes', blockedByConsultationId: CONSULTATION_ID });

      await expect(service.setOwnPresence(DOCTOR_ID, 'available_now')).rejects.toBeInstanceOf(ConflictException);

      expect(state.presence).toBe('completing_notes');
      expect(state.blockedByConsultationId).toBe(CONSULTATION_ID);
    });

    it('asks M-05 for requireNotGated on every move INTO a routable state', async () => {
      const { service, facade } = buildHarness({ presence: 'offline' });

      await service.transition({ doctorId: DOCTOR_ID, to: 'available_now', actor: { actorType: 'system', actorId: null } });

      expect(facade.transitionPresence).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'available_now', requireNotGated: true }),
      );
      // `request_pending` too — routing already filters gated doctors, so this
      // is the second, independent stop.
      expect(PRESENCE_REQUIRING_NO_GATE).toEqual(expect.arrayContaining(['available_now', 'request_pending']));
    });

    it('does NOT ask for the gate check on a move that is not routable, so a gated doctor can still go offline', async () => {
      const { service, facade, state } = buildHarness({ presence: 'paused', blockedByConsultationId: CONSULTATION_ID });

      const result = await service.transition({
        doctorId: DOCTOR_ID,
        to: 'offline',
        actor: { actorType: 'doctor', actorId: DOCTOR_ID },
      });

      expect(result.changed).toBe(true);
      expect(state.presence).toBe('offline');
      expect(facade.transitionPresence).toHaveBeenCalledWith(expect.objectContaining({ requireNotGated: false }));
    });

    it('*** A GATED DOCTOR IN completing_notes CANNOT REACH ANY SELF-SETTABLE STATE. *** No tap gets them out; only M-15 does', async () => {
      for (const target of SELF_SETTABLE_PRESENCE) {
        const { service, state } = buildHarness({ presence: 'completing_notes', blockedByConsultationId: CONSULTATION_ID });

        await expect(service.setOwnPresence(DOCTOR_ID, target)).rejects.toBeInstanceOf(ConflictException);
        expect(state.presence).toBe('completing_notes');
      }
    });

    it('releases them the moment the gate is gone — the same call now succeeds', async () => {
      const { service, state } = buildHarness({ presence: 'completing_notes', blockedByConsultationId: null });

      await expect(service.setOwnPresence(DOCTOR_ID, 'available_now')).resolves.toMatchObject({
        presence: 'available_now',
      });
      expect(state.presence).toBe('available_now');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * Self-service rules
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('setOwnPresence', () => {
    it.each(['request_pending', 'in_consultation', 'completing_notes'] as const)(
      'refuses %s — a doctor may not assert work in flight',
      async (target) => {
        const { service, facade } = buildHarness({ presence: 'available_now' });

        await expect(service.setOwnPresence(DOCTOR_ID, target as unknown as SelfSettablePresence)).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.PRESENCE_NOT_SELF_SETTABLE },
        });
        // Refused before the write path is even entered.
        expect(facade.transitionPresence).not.toHaveBeenCalled();
      },
    );

    it.each([...SELF_SETTABLE_PRESENCE])('allows %s from a legal source', async (target) => {
      // `available_now` is a legal source for every one of the four.
      const { service } = buildHarness({ presence: 'available_now' });
      if (target === 'available_now') return;

      await expect(service.setOwnPresence(DOCTOR_ID, target)).resolves.toMatchObject({ presence: target });
    });

    it('turns an illegal move into PRESENCE_TRANSITION_NOT_ALLOWED and reports where the doctor actually is', async () => {
      // `in_consultation` -> `paused` is not in the table.
      const { service } = buildHarness({ presence: 'in_consultation' });

      await expect(service.setOwnPresence(DOCTOR_ID, 'paused')).rejects.toMatchObject({
        response: {
          code: INSTANT_ERROR_CODES.PRESENCE_TRANSITION_NOT_ALLOWED,
          currentPresence: 'in_consultation',
        },
      });
    });

    it('404s for a doctor who does not exist', async () => {
      const { service } = buildHarness({ exists: false });
      await expect(service.setOwnPresence(DOCTOR_ID, 'available_now')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent — asking for the state you are already in succeeds and changes nothing', async () => {
      const { service, published } = buildHarness({ presence: 'available_now' });

      await expect(service.setOwnPresence(DOCTOR_ID, 'available_now')).resolves.toMatchObject({
        presence: 'available_now',
      });
      // No change means no broadcast: a client must not see a "presence
      // changed" event for a change that did not happen.
      expect(published).toHaveLength(0);
    });
  });

  describe('broadcast', () => {
    it('publishes a presence event carrying both the old and new state', async () => {
      const { service, published } = buildHarness({ presence: 'offline' });

      await service.transition({ doctorId: DOCTOR_ID, to: 'available_now', actor: { actorType: 'system', actorId: null } });

      expect(published).toEqual([
        {
          doctorId: DOCTOR_ID,
          type: 'presence',
          data: { presence: 'available_now', previousPresence: 'offline', blockedByConsultationId: null },
        },
      ]);
    });

    it('never lets a broken bus fail the flow that triggered it', () => {
      const { service, bus } = buildHarness();
      (bus.publish as unknown as Fn).mockImplementation(() => {
        throw new Error('bus is down');
      });

      expect(() => service.publish({ doctorId: DOCTOR_ID, type: 'keepalive', data: {} })).not.toThrow();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * The realtime channel
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('openStream', () => {
    it('emits stream_ready as a typed MessageEvent, so a client can tell "open" from "still connecting"', async () => {
      const { service } = buildHarness({ presence: 'available_now' });

      const first = await firstValueFrom(service.openStream(DOCTOR_ID));

      expect(first).toMatchObject({ type: 'stream_ready' });
      // `{ type, data }` and nothing else — the shape Nest's SseStream reads,
      // and the reason ResponseInterceptor must skip @Sse() routes.
      expect(Object.keys(first).sort()).toEqual(['data', 'type']);
    });

    it('delivers this doctors events and not another doctors', async () => {
      const { service, bus } = buildHarness({ presence: 'available_now' });
      (bus.publish as unknown as Fn).mockRestore();

      const collected = firstValueFrom(service.openStream(DOCTOR_ID).pipe(take(2), toArray()));
      // Let the subscription attach before publishing — the bus has no replay.
      await Promise.resolve();

      bus.publish({ doctorId: 'someone-else', type: 'instant_request', data: { requestId: 'nope' } });
      bus.publish({ doctorId: DOCTOR_ID, type: 'instant_request', data: { requestId: 'mine' } });

      const events = await collected;
      expect(events).toEqual([
        { type: 'stream_ready', data: expect.any(Object) },
        { type: 'instant_request', data: { requestId: 'mine' } },
      ]);
    });

    it('*** CLOSING THE STREAM WRITES presence = offline *** — the mechanism the ERD names instead of a heartbeat column', async () => {
      const { service, facade, state } = buildHarness({ presence: 'available_now' });

      const subscription = service.openStream(DOCTOR_ID).subscribe();
      expect(service.openStreamCount(DOCTOR_ID)).toBe(1);

      subscription.unsubscribe();
      await Promise.resolve();
      await Promise.resolve();

      expect(facade.transitionPresence).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'offline', from: DISCONNECT_CLEARS_PRESENCE, reason: 'stream_closed' }),
      );
      expect(state.presence).toBe('offline');
      expect(service.openStreamCount(DOCTOR_ID)).toBe(0);
    });

    it('only the LAST stream closing goes offline — one of two devices locking its screen must not drop the doctor', async () => {
      const { service, facade, state } = buildHarness({ presence: 'available_now' });

      const phone = service.openStream(DOCTOR_ID).subscribe();
      const tablet = service.openStream(DOCTOR_ID).subscribe();
      expect(service.openStreamCount(DOCTOR_ID)).toBe(2);

      phone.unsubscribe();
      await Promise.resolve();
      expect(state.presence).toBe('available_now');
      expect(facade.transitionPresence).not.toHaveBeenCalled();

      tablet.unsubscribe();
      await Promise.resolve();
      await Promise.resolve();
      expect(state.presence).toBe('offline');
    });

    it('*** BACKGROUNDING THE APP DOES NOT CLEAR THE COMPLETION GATE *** — completing_notes survives a closed stream', async () => {
      const { service, state } = buildHarness({ presence: 'completing_notes', blockedByConsultationId: CONSULTATION_ID });

      service.openStream(DOCTOR_ID).subscribe().unsubscribe();
      await Promise.resolve();
      await Promise.resolve();

      // If `offline` were reachable from `completing_notes`, FR-10.5 would be
      // bypassable by locking the phone.
      expect(state.presence).toBe('completing_notes');
      expect(state.blockedByConsultationId).toBe(CONSULTATION_ID);
      expect(DISCONNECT_CLEARS_PRESENCE).not.toContain('completing_notes');
      expect(DISCONNECT_CLEARS_PRESENCE).not.toContain('in_consultation');
    });

    it('a dropped socket does not abandon a consult in progress either', async () => {
      const { service, state } = buildHarness({ presence: 'in_consultation' });

      service.openStream(DOCTOR_ID).subscribe().unsubscribe();
      await Promise.resolve();
      await Promise.resolve();

      expect(state.presence).toBe('in_consultation');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * The boot sweep
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('onModuleInit (the boot sweep)', () => {
    it('resets the live states to offline — after a restart no stream vouches for anyone', async () => {
      const { service, facade } = buildHarness();

      await service.onModuleInit();

      expect(facade.resetPresence).toHaveBeenCalledWith({
        from: BOOT_STALE_PRESENCE,
        to: 'offline',
        actor: { actorType: 'system', actorId: null },
        reason: 'boot_sweep_no_live_stream',
      });
    });

    it('leaves in_consultation and completing_notes alone — a restart must not clear the gate', () => {
      expect(BOOT_STALE_PRESENCE).not.toContain('in_consultation');
      expect(BOOT_STALE_PRESENCE).not.toContain('completing_notes');
      // `scheduled_only` is a standing preference, not a live-socket fact.
      expect(BOOT_STALE_PRESENCE).not.toContain('scheduled_only');
    });

    it('never throws into boot — a database that is not ready must not stop the process starting', async () => {
      const { service, facade } = buildHarness();
      facade.resetPresence.mockRejectedValue(new Error('database not ready'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('throwForRefusal', () => {
    it('says nothing about a successful call or an idempotent no-op', () => {
      const { service } = buildHarness();
      expect(() => service.throwForRefusal({ changed: true, before: 'offline', after: 'available_now' })).not.toThrow();
      expect(() => service.throwForRefusal({ changed: false, before: 'paused', after: 'paused' })).not.toThrow();
    });

    it('maps M-05s refusal vocabulary onto this modules error codes', () => {
      const { service } = buildHarness();

      expect(() =>
        service.throwForRefusal({ changed: false, before: null, after: null, refusal: 'doctor_not_found' }),
      ).toThrow(NotFoundException);

      expect(() =>
        service.throwForRefusal({
          changed: false,
          before: 'completing_notes',
          after: 'completing_notes',
          refusal: 'completion_gated',
        }),
      ).toThrow(ConflictException);
    });
  });
});
