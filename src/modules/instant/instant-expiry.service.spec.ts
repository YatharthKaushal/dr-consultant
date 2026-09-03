import type { InstantConsultancyRow } from '../../schema/instant-consultancy.schema';
import type { BookingView } from '../booking/booking.contract';
import { InstantExpiryService } from './instant-expiry.service';
import {
  ACCEPTANCE_SWEEP_INTERVAL_MS,
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_NOTIFICATION_TEMPLATES,
  PAYMENT_SWEEP_INTERVAL_MS,
  SWEEP_BATCH_SIZE,
} from './instant.constants';

/**
 * Unit tests for the two things that move an instant request without anyone
 * asking. `new Service(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 *
 * SWEEP 2 carries M-13's fourth done-when bar — "an accepted-but-unpaid
 * request releases the doctor and un-gates them" — and it is the one failure
 * mode with no precedent in the scheduled flow, so the ORDER of its two writes
 * is asserted rather than assumed. See `instant-expiry.service.ts`'s header
 * for why it deliberately inverts M-11's "never release under a live payment"
 * default.
 */

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const CONSULTATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONSULTATION_ID = '3b3b3b3b-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';

function makeAttempt(overrides: Partial<InstantConsultancyRow> = {}): InstantConsultancyRow {
  return {
    id: ATTEMPT_ID,
    consultationId: CONSULTATION_ID,
    doctorId: DOCTOR_ID,
    attemptNumber: 1,
    outcome: 'pending',
    offeredAt: new Date('2026-03-01T09:00:00.000Z'),
    expiresAt: new Date('2026-03-01T09:01:00.000Z'),
    ...overrides,
  } as InstantConsultancyRow;
}

function makeBooking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-INSTANT-01',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: 'spec',
    concernId: null,
    mode: 'instant',
    status: 'pending_payment',
    scheduledStartAt: null,
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-03-01T09:00:00.000Z'),
    ...overrides,
  } as BookingView;
}

type Fn = jest.Mock;

function buildHarness() {
  const repo: Record<string, Fn> = {
    findExpiredPendingAttempts: jest.fn(async () => []),
  };

  const instant: Record<string, Fn> = {
    timeOutAttempt: jest.fn(async () => true),
    routeNext: jest.fn(async () => ({ routed: true, attempt: makeAttempt() })),
    releaseRequest: jest.fn(async () => undefined),
  };

  const bookings: Record<string, Fn> = {
    listExpiredInstantHolds: jest.fn(async () => []),
    getBooking: jest.fn(async () => makeBooking()),
  };

  const doctors: Record<string, Fn> = {
    clearCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null })),
  };

  const presence: Record<string, Fn> = {
    transition: jest.fn(async (input: { to: string }) => ({ changed: true, before: 'in_consultation', after: input.to })),
    publish: jest.fn(),
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const service = new InstantExpiryService(
    repo as never,
    instant as never,
    bookings as never,
    doctors as never,
    presence as never,
    audit as never,
  );

  return { service, repo, instant, bookings, doctors, presence, audit };
}

describe('InstantExpiryService', () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * Scheduling — copied from booking-slot-hold.service.ts
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('scheduling', () => {
    afterEach(() => jest.restoreAllMocks());

    it('starts TWO unref-ed interval timers in onModuleInit, one per sweep', () => {
      const { service } = buildHarness();
      const unref = jest.fn();
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), ACCEPTANCE_SWEEP_INTERVAL_MS);
      expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), PAYMENT_SWEEP_INTERVAL_MS);
      // Without this, Jest and CLI processes would not exit.
      expect(unref).toHaveBeenCalledTimes(2);
    });

    it('the acceptance window is swept far more often than the payment window — it chases a 60s deadline, not a 5-minute one', () => {
      expect(ACCEPTANCE_SWEEP_INTERVAL_MS).toBeLessThan(PAYMENT_SWEEP_INTERVAL_MS);
    });

    it('is idempotent — a second onModuleInit does not start four timers', () => {
      const { service } = buildHarness();
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);

      service.onModuleInit();
      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });

    it('clears both timers on shutdown, and tolerates a shutdown with none started', () => {
      const { service } = buildHarness();
      jest.spyOn(global, 'setInterval').mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

      service.onModuleInit();
      service.onApplicationShutdown();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

      // A second shutdown must not double-clear.
      service.onApplicationShutdown();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * SWEEP 1 — the acceptance window (FR-10.6)
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('sweepExpiredOffers', () => {
    it('bounds one pass so a backlog drains steadily instead of in one spike', async () => {
      const { service, repo } = buildHarness();
      const now = new Date('2026-03-01T10:00:00.000Z');

      await service.sweepExpiredOffers(now);

      expect(repo.findExpiredPendingAttempts).toHaveBeenCalledWith(now, SWEEP_BATCH_SIZE);
    });

    it('*** TIMES OUT AND RE-ROUTES WITH NO PATIENT ACTION *** (FR-10.6)', async () => {
      const { service, repo, instant } = buildHarness();
      repo.findExpiredPendingAttempts.mockResolvedValue([makeAttempt()]);

      const result = await service.sweepExpiredOffers();

      expect(instant.timeOutAttempt).toHaveBeenCalledWith(ATTEMPT_ID);
      expect(instant.routeNext).toHaveBeenCalledWith(CONSULTATION_ID, 'acceptance_window_expired');
      expect(result).toMatchObject({ examined: 1, timedOut: 1, rerouted: 1, exhausted: 0, failed: 0 });
    });

    it('does NOT re-route when the doctor answered between the candidate query and the lock', async () => {
      const { service, repo, instant } = buildHarness();
      repo.findExpiredPendingAttempts.mockResolvedValue([makeAttempt()]);
      // `timeOutAttempt` re-checks under the row lock and reports it lost.
      instant.timeOutAttempt.mockResolvedValue(false);

      const result = await service.sweepExpiredOffers();

      expect(instant.routeNext).not.toHaveBeenCalled();
      expect(result).toMatchObject({ examined: 1, timedOut: 0, rerouted: 0 });
    });

    it('counts an exhausted request separately from a re-routed one', async () => {
      const { service, repo, instant } = buildHarness();
      repo.findExpiredPendingAttempts.mockResolvedValue([makeAttempt()]);
      instant.routeNext.mockResolvedValue({ routed: false, reason: 'exhausted' });

      await expect(service.sweepExpiredOffers()).resolves.toMatchObject({ timedOut: 1, rerouted: 0, exhausted: 1 });
    });

    it('one bad candidate does not abandon the rest of the batch', async () => {
      const { service, repo, instant } = buildHarness();
      repo.findExpiredPendingAttempts.mockResolvedValue([
        makeAttempt({ id: 'a1' }),
        makeAttempt({ id: 'a2' }),
        makeAttempt({ id: 'a3' }),
      ]);
      instant.timeOutAttempt.mockImplementation(async (id: string) => {
        if (id === 'a2') throw new Error('row lock timeout');
        return true;
      });

      const result = await service.sweepExpiredOffers();

      expect(result).toMatchObject({ examined: 3, timedOut: 2, failed: 1 });
    });

    it('reports an empty pass without touching anything', async () => {
      const { service, instant } = buildHarness();

      await expect(service.sweepExpiredOffers()).resolves.toEqual({
        examined: 0,
        timedOut: 0,
        rerouted: 0,
        exhausted: 0,
        failed: 0,
      });
      expect(instant.timeOutAttempt).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * SWEEP 2 — the payment window. M-13's fourth done-when bar.
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('sweepUnpaidAcceptedRequests', () => {
    it('bounds one pass, and takes its candidates from M-11 rather than from an outcome marker', async () => {
      const { service, bookings } = buildHarness();
      const now = new Date('2026-03-01T10:00:00.000Z');

      await service.sweepUnpaidAcceptedRequests(now);

      // Driven off `consultations.status = 'pending_payment'`, which is what
      // makes the pass self-limiting: releasing or paying takes a candidate
      // out of the set, so there is no marker to maintain.
      expect(bookings.listExpiredInstantHolds).toHaveBeenCalledWith(now, SWEEP_BATCH_SIZE);
    });

    it('*** RELEASES THE DOCTOR AND UN-GATES THEM, THEN RELEASES THE REQUEST *** — in that order', async () => {
      const { service, bookings, doctors, presence, instant } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);

      const order: string[] = [];
      doctors.clearCompletionGate.mockImplementation(async () => {
        order.push('ungate');
        return { changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null };
      });
      presence.transition.mockImplementation(async (input: { to: string }) => {
        order.push(`presence:${input.to}`);
        return { changed: true, before: 'in_consultation', after: input.to };
      });
      instant.releaseRequest.mockImplementation(async () => {
        order.push('release');
      });

      const result = await service.sweepUnpaidAcceptedRequests();

      // The doctor comes first: releasing the consultation is idempotent and
      // self-healing, un-gating is not. A crash the other way round leaves a
      // doctor blocked by a consultation that no longer exists.
      expect(order).toEqual(['ungate', 'presence:available_now', 'release']);
      expect(doctors.clearCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: CONSULTATION_ID }),
      );
      expect(presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'instant_payment_window_expired' }),
      );
      expect(instant.releaseRequest).toHaveBeenCalledWith(
        CONSULTATION_ID,
        'instant_payment_window_expired',
        INSTANT_NOTIFICATION_TEMPLATES.INSTANT_PAYMENT_WINDOW_EXPIRED,
      );
      expect(result).toMatchObject({ examined: 1, released: 1, skipped: 0, failed: 0 });
    });

    it('audits the release, naming the M-11 mechanism that catches a payment landing afterwards', async () => {
      const { service, bookings, audit } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);

      await service.sweepUnpaidAcceptedRequests();

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'system',
          entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_ROUTING,
          entityId: CONSULTATION_ID,
          consultationId: CONSULTATION_ID,
          metadata: expect.objectContaining({ change: 'doctor_released_unpaid', doctorId: DOCTOR_ID }),
        }),
      );
    });

    it('does NOT release a consultation the payment reached first — the capture wins the race', async () => {
      const { service, bookings, instant, audit } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);
      // `payment.captured` -> BookingPaymentListener -> confirmPayment got
      // there first and took it to `scheduled`.
      bookings.getBooking.mockResolvedValue(makeBooking({ status: 'scheduled' }));

      const result = await service.sweepUnpaidAcceptedRequests();

      expect(instant.releaseRequest).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
      expect(result).toMatchObject({ examined: 1, released: 0, skipped: 1 });
    });

    it('un-gates a doctor even when the consultation itself turns out to be settled — a stuck gate is what they cannot escape', async () => {
      const { service, bookings, doctors } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);
      bookings.getBooking.mockResolvedValue(makeBooking({ status: 'scheduled' }));

      await service.sweepUnpaidAcceptedRequests();

      expect(doctors.clearCompletionGate).toHaveBeenCalled();
    });

    it('handles the crash window: an instant hold with no doctor attached yet', async () => {
      const { service, bookings, doctors, presence, instant } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: null, holdExpiresAt: new Date() },
      ]);
      bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: null }));

      const result = await service.sweepUnpaidAcceptedRequests();

      // Nothing to un-gate or free, but the request is still released.
      expect(doctors.clearCompletionGate).not.toHaveBeenCalled();
      expect(presence.transition).not.toHaveBeenCalled();
      expect(instant.releaseRequest).toHaveBeenCalled();
      expect(result).toMatchObject({ released: 1 });
    });

    it('leaves an offline doctor where they put themselves rather than dragging them back into the pool', async () => {
      const { service, bookings, presence, instant } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);
      // The presence move is best-effort: a refusal is logged, not retried,
      // and must not stop the consultation being released.
      presence.transition.mockResolvedValue({
        changed: false,
        before: 'offline',
        after: 'offline',
        refusal: 'illegal_transition',
      });

      await expect(service.sweepUnpaidAcceptedRequests()).resolves.toMatchObject({ released: 1 });
      expect(instant.releaseRequest).toHaveBeenCalled();
    });

    it('one bad candidate does not abandon the rest of the batch', async () => {
      const { service, bookings, doctors } = buildHarness();
      bookings.listExpiredInstantHolds.mockResolvedValue([
        { consultationId: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
        { consultationId: OTHER_CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, holdExpiresAt: new Date() },
      ]);
      doctors.clearCompletionGate.mockImplementation(async (input: { consultationId: string }) => {
        if (input.consultationId === CONSULTATION_ID) throw new Error('deadlock');
        return { changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null };
      });

      const result = await service.sweepUnpaidAcceptedRequests();

      expect(result).toMatchObject({ examined: 2, released: 1, failed: 1 });
    });

    it('reports an empty pass without touching anything', async () => {
      const { service, instant } = buildHarness();

      await expect(service.sweepUnpaidAcceptedRequests()).resolves.toEqual({
        examined: 0,
        released: 0,
        skipped: 0,
        failed: 0,
      });
      expect(instant.releaseRequest).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * The two sweeps do not interfere
   * ═══════════════════════════════════════════════════════════════════════ */

  it('the two sweeps read disjoint candidate sets — pending offers vs unpaid holds', async () => {
    const { service, repo, bookings } = buildHarness();

    await service.sweepExpiredOffers();
    await service.sweepUnpaidAcceptedRequests();

    expect(repo.findExpiredPendingAttempts).toHaveBeenCalledTimes(1);
    expect(bookings.listExpiredInstantHolds).toHaveBeenCalledTimes(1);
    // Neither sweep reads the other's source, so they cannot fight over a row.
    expect(repo.findExpiredPendingAttempts).not.toBe(bookings.listExpiredInstantHolds);
  });
});
