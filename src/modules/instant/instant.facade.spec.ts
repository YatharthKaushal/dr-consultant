import { InstantEventBus, type InstantStreamEvent } from './instant-event.bus';
import { InstantFacade } from './instant.facade';
import { NOTIFICATION_PORT } from './instant.constants';
import { UnavailableNotificationProvider } from './unavailable-notification.provider';
import { toInstantPresenceView } from './instant.mapper';

/**
 * The public surface, the null object M-13 was built against, and the
 * one-method broadcast seam. `new Service(mockedDeps)` with hand-rolled
 * `jest.fn()`s, never `Test.createTestingModule`.
 */

const DOCTOR_ID = '11111111-1111-4111-8111-111111111111';
const CONSULTATION_ID = '22222222-2222-4222-8222-222222222222';

type Fn = jest.Mock;

function buildHarness() {
  const instant: Record<string, Fn> = {
    markInstantConsultEnded: jest.fn(async () => ({
      changed: true,
      doctorId: DOCTOR_ID,
      blockedByConsultationId: CONSULTATION_ID,
    })),
    clearCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null })),
    markConsultInProgress: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, presence: 'in_consultation' })),
    markConsultEnded: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, presence: 'available_now' })),
    getInstantConsult: jest.fn(async () => ({
      consultationId: CONSULTATION_ID,
      doctorId: DOCTOR_ID,
      status: 'pending_payment',
      attempts: [],
      pendingAttempt: null,
    })),
  };

  const presence: Record<string, Fn> = {
    getPresence: jest.fn(async () => ({
      doctorId: DOCTOR_ID,
      presence: 'available_now',
      allowInstantConsult: true,
      blockedByConsultationId: null,
      routable: true,
    })),
  };

  const facade = new InstantFacade(instant as never, presence as never);
  return { facade, instant, presence };
}

describe('InstantFacade', () => {
  it('*** M-15 CLEARS THE COMPLETION GATE THROUGH HERE *** — by consultation, which is what M-15 holds', async () => {
    const { facade, instant } = buildHarness();

    await expect(facade.clearCompletionGate(CONSULTATION_ID)).resolves.toEqual({
      changed: true,
      doctorId: DOCTOR_ID,
      blockedByConsultationId: null,
    });
    expect(instant.clearCompletionGate).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('M-14 gates the doctor through here when the call ends', async () => {
    const { facade, instant } = buildHarness();

    await expect(facade.markInstantConsultEnded(CONSULTATION_ID)).resolves.toMatchObject({ changed: true });
    expect(instant.markInstantConsultEnded).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  /**
   * The pair. `markConsultInProgress` had no inverse on this surface, and
   * because `in_consultation` is a state the boot sweep, the disconnect handler
   * and `LEGAL_PRESENCE_TRANSITIONS.offline` all deliberately refuse to leave,
   * that made it a one-way door for every SCHEDULED consultation.
   */
  it('*** M-14 TAKES THE DOCTOR OUT OF THE POOL AND PUTS THEM BACK, BOTH THROUGH HERE ***', async () => {
    const { facade, instant } = buildHarness();

    await expect(facade.markConsultInProgress(CONSULTATION_ID)).resolves.toMatchObject({ presence: 'in_consultation' });
    await expect(facade.markConsultEnded(CONSULTATION_ID)).resolves.toMatchObject({ presence: 'available_now' });

    expect(instant.markConsultInProgress).toHaveBeenCalledWith(CONSULTATION_ID);
    expect(instant.markConsultEnded).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('this form applies NO ownership check — a trusted module-to-module call, the caller authorizes', async () => {
    const { facade, instant } = buildHarness();

    await facade.markInstantConsultEnded(CONSULTATION_ID);

    // One argument. The doctor-facing route goes through
    // `markOwnInstantConsultEnded`, which takes the caller's id and checks it.
    expect(instant.markInstantConsultEnded).toHaveBeenCalledWith(CONSULTATION_ID);
    expect(instant.markInstantConsultEnded.mock.calls[0]).toHaveLength(1);
  });

  it('exposes presence for FR-4.2s live-availability badge', async () => {
    const { facade, presence } = buildHarness();

    await expect(facade.getPresence(DOCTOR_ID)).resolves.toMatchObject({ routable: true });
    expect(presence.getPresence).toHaveBeenCalledWith(DOCTOR_ID);
  });

  it('returns one requests full routing history', async () => {
    const { facade } = buildHarness();
    await expect(facade.getInstantConsult(CONSULTATION_ID)).resolves.toMatchObject({ consultationId: CONSULTATION_ID });
  });

  it('is deliberately narrow — routing, accepting and timing out are NOT on the public surface', () => {
    const surface = Object.getOwnPropertyNames(InstantFacade.prototype).filter((name) => name !== 'constructor');

    // Five, and every one is a TRUSTED module-to-module call another module
    // genuinely needs: M-15 clears the gate, M-14 marks a call started and
    // ended, M-09/M-04 read presence, the admin panel reads a consult. Routing,
    // accepting and timing out stay off the surface — they are this module's
    // own decisions and nothing outside it may reach them.
    expect(surface.sort()).toEqual([
      'clearCompletionGate',
      'getInstantConsult',
      'getPresence',
      // The pair M-14 needs: the call started, and — the half that was missing
      // — the call ended. `in_consultation` is a state nothing else ever
      // leaves, so the way in is only safe while the way out is on the surface
      // beside it.
      'markConsultEnded',
      'markConsultInProgress',
      'markInstantConsultEnded',
    ]);
  });
});

describe('UnavailableNotificationProvider', () => {
  it('*** DOES NOT THROW *** — unlike every other null object here, because M-13 works without M-08', async () => {
    const provider = new UnavailableNotificationProvider();

    await expect(
      provider.notify({ templateCode: 'instant_request', audience: { kind: 'doctor', id: DOCTOR_ID } }),
    ).resolves.toEqual({ queued: false, notificationId: null, reason: 'provider_unavailable' });
  });

  it('reports a reason an operator can act on — "M-08 is not wired up" is not "that doctor has no device token"', async () => {
    const provider = new UnavailableNotificationProvider();
    const result = await provider.notify({ templateCode: 'x', audience: { kind: 'patient', id: 'p' } });

    expect(result.reason).toBe('provider_unavailable');
    expect(result.notificationId).toBeNull();
  });
});

describe('InstantEventBus', () => {
  it('delivers only the addressed doctors events', () => {
    const bus = new InstantEventBus();
    const mine: InstantStreamEvent[] = [];
    const theirs: InstantStreamEvent[] = [];

    bus.streamFor(DOCTOR_ID).subscribe((event) => mine.push(event));
    bus.streamFor('other-doctor').subscribe((event) => theirs.push(event));

    bus.publish({ doctorId: DOCTOR_ID, type: 'instant_request', data: { requestId: 'r1' } });

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('fans one event out to every device the doctor has open', () => {
    const bus = new InstantEventBus();
    const phone: InstantStreamEvent[] = [];
    const tablet: InstantStreamEvent[] = [];

    bus.streamFor(DOCTOR_ID).subscribe((event) => phone.push(event));
    bus.streamFor(DOCTOR_ID).subscribe((event) => tablet.push(event));

    bus.publish({ doctorId: DOCTOR_ID, type: 'presence', data: { presence: 'available_now' } });

    expect(phone).toHaveLength(1);
    expect(tablet).toHaveLength(1);
  });

  it('has NO REPLAY, on purpose — a reconnect must not be shown an offer whose window closed', () => {
    const bus = new InstantEventBus();
    bus.publish({ doctorId: DOCTOR_ID, type: 'instant_request', data: { requestId: 'stale' } });

    const received: InstantStreamEvent[] = [];
    bus.streamFor(DOCTOR_ID).subscribe((event) => received.push(event));

    // The reconnect path is `GET /doctors/me/instant-requests`, which reads
    // the table and can only return offers that are genuinely still open.
    expect(received).toHaveLength(0);
  });

  it('stops delivering once a stream is unsubscribed', () => {
    const bus = new InstantEventBus();
    const received: InstantStreamEvent[] = [];
    const subscription = bus.streamFor(DOCTOR_ID).subscribe((event) => received.push(event));

    subscription.unsubscribe();
    bus.publish({ doctorId: DOCTOR_ID, type: 'keepalive', data: {} });

    expect(received).toHaveLength(0);
  });

  it('publishing to nobody is not an error', () => {
    const bus = new InstantEventBus();
    expect(() => bus.publish({ doctorId: DOCTOR_ID, type: 'keepalive', data: {} })).not.toThrow();
  });
});

describe('the notification port token', () => {
  it('is a Symbol, like every other DI token in this codebase', () => {
    expect(typeof NOTIFICATION_PORT).toBe('symbol');
    expect(NOTIFICATION_PORT.toString()).toContain('NOTIFICATION_PORT');
  });
});

describe('toInstantPresenceView', () => {
  it('computes `routable` as the exact conjunction the routing SQL applies', () => {
    const base = {
      doctorId: DOCTOR_ID,
      presence: 'available_now' as const,
      allowInstantConsult: true,
      blockedByConsultationId: null,
      isVerifiedAndListed: true,
    };

    expect(toInstantPresenceView(base).routable).toBe(true);
    // Each predicate, alone, is enough to make a doctor unroutable.
    expect(toInstantPresenceView({ ...base, presence: 'scheduled_only' }).routable).toBe(false);
    expect(toInstantPresenceView({ ...base, presence: 'paused' }).routable).toBe(false);
    expect(toInstantPresenceView({ ...base, allowInstantConsult: false }).routable).toBe(false);
    expect(toInstantPresenceView({ ...base, blockedByConsultationId: CONSULTATION_ID }).routable).toBe(false);
    expect(toInstantPresenceView({ ...base, isVerifiedAndListed: false }).routable).toBe(false);
  });

  it('*** scheduled_only IS NEVER ROUTABLE, BUT IS NOT OFFLINE EITHER *** (FR-10.3)', () => {
    const view = toInstantPresenceView({
      doctorId: DOCTOR_ID,
      presence: 'scheduled_only',
      allowInstantConsult: true,
      blockedByConsultationId: null,
      isVerifiedAndListed: true,
    });

    // "The doctor stays bookable by slot but receives no instant requests."
    // Bookability is M-07/M-11's question and depends on verified+listed,
    // which is untouched here; routability is this module's, and it is false.
    expect(view.routable).toBe(false);
    expect(view.presence).toBe('scheduled_only');
  });
});
