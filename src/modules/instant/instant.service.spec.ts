import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BookingView } from '../booking/booking.contract';
import type { InstantConsultancyRow } from '../../schema/instant-consultancy.schema';
import {
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_ERROR_CODES,
  INSTANT_NOTIFICATION_TEMPLATES,
  MAX_ROUTING_ATTEMPTS,
  ROUTING_CANDIDATE_FETCH,
} from './instant.constants';
import { InstantService } from './instant.service';

/**
 * Unit tests for FR-10.2's flow — request -> accept -> PAY — and FR-10.6's
 * re-routing. `new Service(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 *
 * The two done-when bars proved here:
 *   "a declined request reaches the next doctor with no patient action"
 *   the accept saga's compensation on every step that can fail
 *
 * The other two ("every state reachable", "the gate cannot be bypassed") are
 * proved in `instant-presence.service.spec.ts` against the real transition
 * table; the payment-window release is in `instant-expiry.service.spec.ts`.
 */

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT_ID = '1a1a1a1a-1111-4111-8111-111111111111';
const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_DOCTOR_ID = '2b2b2b2b-2222-4222-8222-222222222222';
const SPECIALTY_ID = '33333333-3333-4333-8333-333333333333';
const CONSULTATION_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const PAYMENT_ID = '66666666-6666-4666-8666-666666666666';

/** The shape `node-postgres` throws for a unique-constraint violation — what `isUniqueConstraintViolation` duck-types on. */
function uniqueViolation(constraint = 'instant_consultancy_consultation_id_attempt_number_index') {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

function makeBooking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-INSTANT-01',
    patientId: PATIENT_ID,
    doctorId: null,
    specialtyId: SPECIALTY_ID,
    concernId: null,
    mode: 'instant',
    status: 'awaiting_doctor',
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

function makeAttempt(overrides: Partial<InstantConsultancyRow> = {}): InstantConsultancyRow {
  return {
    id: ATTEMPT_ID,
    consultationId: CONSULTATION_ID,
    doctorId: DOCTOR_ID,
    attemptNumber: 1,
    outcome: 'pending',
    offeredAt: new Date('2026-03-01T09:00:00.000Z'),
    // Comfortably in the future so the window guard passes by default.
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as InstantConsultancyRow;
}

/** Loose mock aliases: every `jest.fn()` here is deliberately untyped so a test can resolve `null`, an error, or a partial shape without fighting inference. */
type Fn = jest.Mock;

interface Harness {
  db: { transaction: Fn };
  repo: Record<string, Fn>;
  bookings: Record<string, Fn>;
  doctors: Record<string, Fn>;
  payments: Record<string, Fn>;
  presence: Record<string, Fn>;
  config: Record<string, Fn>;
  notifications: Record<string, Fn>;
  audit: Record<string, Fn>;
}

function buildHarness(overrides: Partial<Harness> = {}) {
  const db: { transaction: Fn } = { transaction: jest.fn() };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));

  const repo: Record<string, Fn> = {
    insertAttempt: jest.fn(async (values: Record<string, unknown>) => makeAttempt(values as Partial<InstantConsultancyRow>)),
    findAttemptById: jest.fn(async () => makeAttempt()),
    findAttemptByIdForUpdate: jest.fn(async () => makeAttempt()),
    updateOutcomeIfIn: jest.fn(async (_id: string, _from: unknown, to: string, patch: Record<string, unknown> = {}) =>
      makeAttempt({ outcome: to as InstantConsultancyRow['outcome'], ...(patch as Partial<InstantConsultancyRow>) }),
    ),
    supersedePendingAttempts: jest.fn(async () => 0),
    listAttemptsByConsultation: jest.fn(async () => []),
    listPendingAttemptsForDoctor: jest.fn(async () => []),
    findPendingAttempt: jest.fn(async () => null),
    findAcceptedAttempt: jest.fn(async () => null),
    findExpiredPendingAttempts: jest.fn(async () => []),
    getRoutingState: jest.fn(async () => ({ lastAttemptNumber: 0, triedDoctorIds: [], hasPending: false })),
    getRoutingMetrics: jest.fn(async () => ({ offered: 0, accepted: 0, declined: 0, timedOut: 0, superseded: 0 })),
  };

  const bookings: Record<string, Fn> = {
    createInstantBooking: jest.fn(async () => makeBooking({ status: 'pending_payment' })),
    getBooking: jest.fn(async () => makeBooking()),
    assignDoctor: jest.fn(async () => makeBooking({ doctorId: DOCTOR_ID })),
    transitionInstantConsultation: jest.fn(async (input: { to: string }) => ({
      changed: true,
      booking: makeBooking({ status: input.to as BookingView['status'] }),
    })),
    listExpiredInstantHolds: jest.fn(async () => []),
  };

  const doctors: Record<string, Fn> = {
    listInstantRoutingCandidates: jest.fn(async () => [
      { doctorId: DOCTOR_ID, fullName: 'Dr First', consultationFeeInr: '750.00', consultationDurationMinutes: 30 },
    ]),
    getPublicProfile: jest.fn(async () => ({
      id: DOCTOR_ID,
      fullName: 'Dr First',
      consultationFeeInr: '750.00',
      consultationDurationMinutes: 30,
      specialties: [{ id: SPECIALTY_ID, code: 'gen', name: 'General', isPrimary: true }],
    })),
    setCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: CONSULTATION_ID })),
    clearCompletionGate: jest.fn(async () => ({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null })),
  };

  const payments: Record<string, Fn> = {
    createOrderForConsultation: jest.fn(async () => ({
      paymentId: PAYMENT_ID,
      gatewayOrderId: 'order_test_1',
      gatewayKeyId: 'rzp_test_key',
      breakdown: { totalPayable: '885.00' },
    })),
    getByConsultationId: jest.fn(async () => ({ paymentId: PAYMENT_ID, status: 'created', paidAt: null })),
    getCheckoutHandles: jest.fn(async () => ({
      paymentId: PAYMENT_ID,
      gatewayOrderId: 'order_test_1',
      gatewayKeyId: 'rzp_test_key',
      breakdown: { totalPayable: '885.00' },
    })),
  };

  const presence: Record<string, Fn> = {
    // Default: every reservation and release succeeds.
    transition: jest.fn(async (input: { to: string }) => ({ changed: true, before: 'available_now', after: input.to })),
    publish: jest.fn(),
  };

  const config: Record<string, Fn> = {
    getAcceptanceWindowSeconds: jest.fn(async () => 60),
    getPaymentWindowSeconds: jest.fn(async () => 300),
  };

  const notifications: Record<string, Fn> = {
    notify: jest.fn(async () => ({ queued: true, notificationId: 1 })),
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const deps: Harness = { db, repo, bookings, doctors, payments, presence, config, notifications, audit, ...overrides };

  const service = new InstantService(
    deps.db as never,
    deps.repo as never,
    deps.bookings as never,
    deps.doctors as never,
    deps.payments as never,
    deps.presence as never,
    deps.config as never,
    deps.notifications as never,
    deps.audit as never,
  );

  return { service, ...deps };
}

describe('InstantService', () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * 1. The patient's request
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('requestInstantConsult', () => {
    it('creates the consultation through M-11, moves it to awaiting_doctor, and routes it', async () => {
      const h = buildHarness();

      await h.service.requestInstantConsult({ patientId: PATIENT_ID, specialtyId: SPECIALTY_ID });

      expect(h.bookings.createInstantBooking).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        specialtyId: SPECIALTY_ID,
        concernId: null,
        intakeAnswers: undefined,
      });
      expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
        expect.objectContaining({
          consultationId: CONSULTATION_ID,
          to: 'awaiting_doctor',
          from: ['pending_payment'],
          // Nothing to pay for while routing, so M-11's sweep must not see a
          // live hold on it.
          holdExpiresAt: null,
        }),
      );
      expect(h.repo.insertAttempt).toHaveBeenCalledTimes(1);
    });

    it('never writes `consultations` itself — every status move goes through the booking facade', async () => {
      const h = buildHarness();
      await h.service.requestInstantConsult({ patientId: PATIENT_ID, specialtyId: SPECIALTY_ID });

      // The repository this module owns touches exactly one table.
      expect(Object.keys(h.repo).every((method) => !method.toLowerCase().includes('consultationstatus'))).toBe(true);
      expect(h.bookings.transitionInstantConsultation).toHaveBeenCalled();
    });

    it('releases the request rather than leaving a patient on a spinner when routing throws', async () => {
      const h = buildHarness();
      h.doctors.listInstantRoutingCandidates.mockRejectedValue(new Error('doctor module is down'));

      await h.service.requestInstantConsult({ patientId: PATIENT_ID, specialtyId: SPECIALTY_ID });

      expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'expired', reason: 'initial_routing_failed' }),
      );
    });

    it('refuses when the consultation cannot be moved out of pending_payment', async () => {
      const h = buildHarness();
      h.bookings.transitionInstantConsultation.mockResolvedValue({ changed: false, booking: null, refusal: 'illegal_transition' });

      await expect(h.service.requestInstantConsult({ patientId: PATIENT_ID, specialtyId: SPECIALTY_ID })).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION },
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. Routing
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('routeNext', () => {
    it('*** RESERVES THE DOCTOR BEFORE INSERTING THE ATTEMPT *** — a lost race must cost nothing', async () => {
      const h = buildHarness();
      const order: string[] = [];
      h.presence.transition.mockImplementation(async (input: { to: string }) => {
        order.push(`presence:${input.to}`);
        return { changed: true, before: 'available_now', after: input.to };
      });
      h.repo.insertAttempt.mockImplementation(async (values: Record<string, unknown>) => {
        order.push('insert');
        return makeAttempt(values as Partial<InstantConsultancyRow>);
      });

      await h.service.routeNext(CONSULTATION_ID, 'test');

      expect(order).toEqual(['presence:request_pending', 'insert']);
    });

    it('offers attempt 1 with expires_at = now + the configured acceptance window', async () => {
      const h = buildHarness();
      h.config.getAcceptanceWindowSeconds.mockResolvedValue(45);
      const before = Date.now();

      const result = await h.service.routeNext(CONSULTATION_ID, 'initial_request');

      expect(result).toMatchObject({ routed: true });
      const values = h.repo.insertAttempt.mock.calls[0][0] as { attemptNumber: number; expiresAt: Date };
      expect(values.attemptNumber).toBe(1);
      expect(values.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 45_000);
      expect(values.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 45_000);
    });

    it('numbers attempts ASCENDING and never re-offers a doctor already tried', async () => {
      const h = buildHarness();
      h.repo.getRoutingState.mockResolvedValue({ lastAttemptNumber: 2, triedDoctorIds: [DOCTOR_ID], hasPending: false });
      h.doctors.listInstantRoutingCandidates.mockResolvedValue([
        { doctorId: NEXT_DOCTOR_ID, fullName: 'Dr Next', consultationFeeInr: '900.00', consultationDurationMinutes: 20 },
      ]);

      await h.service.routeNext(CONSULTATION_ID, 'declined');

      expect(h.doctors.listInstantRoutingCandidates).toHaveBeenCalledWith({
        specialtyId: SPECIALTY_ID,
        excludeDoctorIds: [DOCTOR_ID],
        limit: ROUTING_CANDIDATE_FETCH,
      });
      expect(h.repo.insertAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ attemptNumber: 3, doctorId: NEXT_DOCTOR_ID }),
        expect.anything(),
      );
    });

    it('tries the NEXT candidate when a doctor is lost between the query and the reserve', async () => {
      const h = buildHarness();
      h.doctors.listInstantRoutingCandidates.mockResolvedValue([
        { doctorId: DOCTOR_ID, fullName: 'Dr Gone', consultationFeeInr: '750.00', consultationDurationMinutes: 30 },
        { doctorId: NEXT_DOCTOR_ID, fullName: 'Dr Next', consultationFeeInr: '900.00', consultationDurationMinutes: 20 },
      ]);
      h.presence.transition.mockImplementation(async (input: { doctorId: string; to: string }) =>
        input.doctorId === DOCTOR_ID
          ? { changed: false, before: 'offline', after: 'offline', refusal: 'illegal_transition' }
          : { changed: true, before: 'available_now', after: input.to },
      );

      const result = await h.service.routeNext(CONSULTATION_ID, 'test');

      expect(result).toMatchObject({ routed: true });
      // No attempt number was spent on the doctor who was gone.
      expect(h.repo.insertAttempt).toHaveBeenCalledTimes(1);
      expect(h.repo.insertAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ attemptNumber: 1, doctorId: NEXT_DOCTOR_ID }),
        expect.anything(),
      );
    });

    it('gives a reserved doctor straight back when the unique index refuses the attempt (a concurrent router won)', async () => {
      const h = buildHarness();
      h.repo.insertAttempt.mockRejectedValue(uniqueViolation());

      const result = await h.service.routeNext(CONSULTATION_ID, 'test');

      expect(result).toEqual({ routed: false, reason: 'already_pending' });
      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'routing_lost_race' }),
      );
    });

    it('rethrows a non-unique insert failure, but still frees the doctor first', async () => {
      const h = buildHarness();
      h.repo.insertAttempt.mockRejectedValue(new Error('connection reset'));

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).rejects.toThrow('connection reset');
      expect(h.presence.transition).toHaveBeenCalledWith(expect.objectContaining({ to: 'available_now' }));
    });

    it('pushes the offer down the doctors stream AND notifies — SSE first, push as the fallback', async () => {
      const h = buildHarness();

      await h.service.routeNext(CONSULTATION_ID, 'test');

      expect(h.presence.publish).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, type: 'instant_request' }),
      );
      expect(h.notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: INSTANT_NOTIFICATION_TEMPLATES.INSTANT_REQUEST,
          audience: { kind: 'doctor', id: DOCTOR_ID },
          consultationId: CONSULTATION_ID,
        }),
      );
    });

    it('carries NO clinical content into the notification (FR-16.2)', async () => {
      const h = buildHarness();
      await h.service.routeNext(CONSULTATION_ID, 'test');

      const request = h.notifications.notify.mock.calls[0][0] as { variables?: Record<string, unknown> };
      expect(Object.keys(request.variables ?? {}).sort()).toEqual(['referenceCode', 'secondsToAnswer']);
    });

    it('routes fine when the notification port is unavailable — M-13 does not need M-08', async () => {
      const h = buildHarness();
      h.notifications.notify.mockResolvedValue({ queued: false, notificationId: null, reason: 'provider_unavailable' });

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toMatchObject({ routed: true });
    });

    it('routes fine even when the notification port THROWS, contract or no contract', async () => {
      const h = buildHarness();
      h.notifications.notify.mockRejectedValue(new Error('M-08 exploded'));

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toMatchObject({ routed: true });
    });

    it('refuses to route a consultation that has left awaiting_doctor', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toEqual({ routed: false, reason: 'not_routable' });
      expect(h.repo.insertAttempt).not.toHaveBeenCalled();
    });

    it('refuses to route a SCHEDULED consultation', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled' }));

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toEqual({ routed: false, reason: 'not_routable' });
    });

    it('never opens a second offer while one is still pending', async () => {
      const h = buildHarness();
      h.repo.getRoutingState.mockResolvedValue({ lastAttemptNumber: 1, triedDoctorIds: [DOCTOR_ID], hasPending: true });

      await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toEqual({ routed: false, reason: 'already_pending' });
      expect(h.repo.insertAttempt).not.toHaveBeenCalled();
    });

    describe('exhaustion (FR-10.6)', () => {
      it('releases the consultation and tells the patient when nobody is available', async () => {
        const h = buildHarness();
        h.doctors.listInstantRoutingCandidates.mockResolvedValue([]);

        const result = await h.service.routeNext(CONSULTATION_ID, 'test');

        expect(result).toEqual({ routed: false, reason: 'exhausted' });
        expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'expired',
            from: ['awaiting_doctor', 'pending_payment'],
            reason: 'no_available_doctor',
          }),
        );
        expect(h.notifications.notify).toHaveBeenCalledWith(
          expect.objectContaining({
            templateCode: INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE,
            audience: { kind: 'patient', id: PATIENT_ID },
          }),
        );
      });

      it('releases as `expired`, never `cancelled` — a system release must not put words in a patients mouth', async () => {
        const h = buildHarness();
        h.doctors.listInstantRoutingCandidates.mockResolvedValue([]);

        await h.service.routeNext(CONSULTATION_ID, 'test');

        const move = h.bookings.transitionInstantConsultation.mock.calls.at(-1)?.[0] as { to: string };
        expect(move.to).toBe('expired');
      });

      it('stops at MAX_ROUTING_ATTEMPTS rather than walking the whole roster', async () => {
        const h = buildHarness();
        h.repo.getRoutingState.mockResolvedValue({
          lastAttemptNumber: MAX_ROUTING_ATTEMPTS,
          triedDoctorIds: [DOCTOR_ID],
          hasPending: false,
        });

        await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toEqual({ routed: false, reason: 'exhausted' });
        expect(h.doctors.listInstantRoutingCandidates).not.toHaveBeenCalled();
      });

      it('exhausts when every candidate is lost to a race', async () => {
        const h = buildHarness();
        h.presence.transition.mockResolvedValue({ changed: false, before: 'offline', after: 'offline', refusal: 'illegal_transition' });

        await expect(h.service.routeNext(CONSULTATION_ID, 'test')).resolves.toEqual({ routed: false, reason: 'exhausted' });
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. Accept
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('accept', () => {
    // *** REVERSED BY THE ADVERSARIAL REVIEW. *** The doctor is attached
    // BEFORE the order is minted, so that the `assignDoctor`-failed
    // compensation (which re-routes) does not leave a `payments` row that
    // makes the next doctor's accept impossible. See the "accept saga,
    // re-ordered" block at the bottom of this file.
    it('runs FR-10.2s inverted order: the doctor first, then the order, then pending_payment', async () => {
      const h = buildHarness();
      const order: string[] = [];
      h.payments.createOrderForConsultation.mockImplementation(async () => {
        order.push('order');
        return { paymentId: PAYMENT_ID, gatewayOrderId: 'o', gatewayKeyId: 'k', breakdown: {} };
      });
      h.bookings.assignDoctor.mockImplementation(async () => {
        order.push('assign');
        return makeBooking({ doctorId: DOCTOR_ID });
      });
      h.bookings.transitionInstantConsultation.mockImplementation(async (input: { to: string }) => {
        order.push(`status:${input.to}`);
        return { changed: true, booking: makeBooking({ status: input.to as BookingView['status'] }) };
      });

      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      expect(order).toEqual(['assign', 'order', 'status:pending_payment']);
    });

    it('prices the order off the doctors own fee and stamps the payment window on the hold', async () => {
      const h = buildHarness();
      h.config.getPaymentWindowSeconds.mockResolvedValue(300);
      const before = Date.now();

      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      expect(h.payments.createOrderForConsultation).toHaveBeenCalledWith({
        consultationId: CONSULTATION_ID,
        consultationFeeInr: '750.00',
      });
      const move = h.bookings.transitionInstantConsultation.mock.calls[0][0] as { holdExpiresAt: Date; from: string[] };
      expect(move.from).toEqual(['awaiting_doctor']);
      expect(move.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    });

    it('REPURPOSES expires_at from the acceptance window to the payment window', async () => {
      const h = buildHarness();
      h.config.getPaymentWindowSeconds.mockResolvedValue(300);
      const before = Date.now();

      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      const patch = h.repo.updateOutcomeIfIn.mock.calls[0][3] as { expiresAt: Date };
      expect(patch.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    });

    it('takes the attempt row lock and moves the doctor to in_consultation', async () => {
      const h = buildHarness();

      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      expect(h.repo.findAttemptByIdForUpdate).toHaveBeenCalledWith(ATTEMPT_ID, expect.anything());
      expect(h.repo.updateOutcomeIfIn).toHaveBeenCalledWith(ATTEMPT_ID, ['pending'], 'accepted', expect.anything(), expect.anything());
      expect(h.presence.transition).toHaveBeenCalledWith(expect.objectContaining({ doctorId: DOCTOR_ID, to: 'in_consultation' }));
    });

    it('adds NO payment machinery — it mints an order and stops; the capture path is M-12s existing one', async () => {
      const h = buildHarness();
      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      // Three entries, and only ONE of them writes. `getCheckoutHandles` is a
      // read added so a polling patient can reach checkout at all; it mints
      // nothing and captures nothing.
      expect(Object.keys(h.payments).sort()).toEqual([
        'createOrderForConsultation',
        'getByConsultationId',
        'getCheckoutHandles',
      ]);
      // No status is driven past `pending_payment` here — `confirmPayment` is
      // reached through M-12's `payment.captured` -> BookingPaymentListener.
      const targets = h.bookings.transitionInstantConsultation.mock.calls.map((call: unknown[]) => (call[0] as { to: string }).to);
      expect(targets).toEqual(['pending_payment']);
    });

    it('404s for an attempt that is not this doctors — the same code a missing one gets, so a doctor cannot probe', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ doctorId: NEXT_DOCTOR_ID }));

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.REQUEST_NOT_FOUND },
      });
    });

    it('409s on a second answer', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ outcome: 'declined' }));

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.REQUEST_NOT_PENDING, outcome: 'declined' },
      });
    });

    it('gives the window closing its own code — the doctor did nothing wrong', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.REQUEST_WINDOW_CLOSED },
      });
    });

    it('loses the race to the timeout sweep cleanly when the guarded UPDATE matches nothing', async () => {
      const h = buildHarness();
      h.repo.updateOutcomeIfIn.mockResolvedValue(null);

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.REQUEST_NOT_PENDING },
      });
    });

    describe('the patient cancelled while the offer was outstanding', () => {
      /**
       * A real window, not an exotic one: M-11's `POST /bookings/:id/cancel`
       * accepts `awaiting_doctor`, and this module deliberately has no cancel
       * path of its own, so a patient CAN cancel between the offer landing
       * and the doctor tapping accept.
       */
      it('*** MINTS NO GATEWAY ORDER *** — the status is re-read before the first irreversible call', async () => {
        const h = buildHarness();
        h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'cancelled' }));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION, currentStatus: 'cancelled' },
        });

        // A `payments` row against a consultation nobody is going to hold is
        // a money-shaped mess to unpick, and one the patient never asked for.
        expect(h.payments.createOrderForConsultation).not.toHaveBeenCalled();
        expect(h.bookings.assignDoctor).not.toHaveBeenCalled();
      });

      it('hands the doctor straight back to the pool', async () => {
        const h = buildHarness();
        h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'cancelled' }));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);

        expect(h.presence.transition).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'available_now', reason: 'accept_rolled_back_consultation_status_cancelled' }),
        );
      });

      it('refuses the same way for a request a sweep already released', async () => {
        const h = buildHarness();
        h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'expired' }));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { currentStatus: 'expired' },
        });
        expect(h.payments.createOrderForConsultation).not.toHaveBeenCalled();
      });
    });

    describe('compensation', () => {
      it('payment setup fails -> the doctor is freed, the request is RELEASED, and the error is rewrapped', async () => {
        const h = buildHarness();
        h.payments.createOrderForConsultation.mockRejectedValue(new Error('gateway 503 body that must never reach a client'));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.PAYMENT_SETUP_FAILED },
        });

        expect(h.presence.transition).toHaveBeenCalledWith(
          expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'accept_rolled_back_payment_setup_failed' }),
        );
        // Not re-routed: a gateway that just failed will fail for the next
        // doctor too.
        expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'expired', reason: 'payment_setup_failed' }),
        );
      });

      it('never lets a raw gateway message reach the caller', async () => {
        const h = buildHarness();
        h.payments.createOrderForConsultation.mockRejectedValue(new Error('CARD_DECLINED: insufficient funds'));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { message: expect.not.stringContaining('CARD_DECLINED') },
        });
      });

      it('leaves the attempt as `accepted` on a rollback — the doctor DID accept, and FR-18.6 counts these rows', async () => {
        const h = buildHarness();
        h.payments.createOrderForConsultation.mockRejectedValue(new Error('nope'));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);

        const outcomes = h.repo.updateOutcomeIfIn.mock.calls.map((call: unknown[]) => call[2]);
        expect(outcomes).toEqual(['accepted']);
        expect(h.audit.write).toHaveBeenCalledWith(
          expect.objectContaining({
            entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_REQUEST,
            metadata: expect.objectContaining({ change: 'accept_rolled_back' }),
          }),
        );
      });

      it('assigning the doctor fails -> the doctor is freed and the request goes to the NEXT one', async () => {
        const h = buildHarness();
        h.bookings.assignDoctor.mockRejectedValue(new Error('doctor is no longer listed'));

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION },
        });

        expect(h.presence.transition).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'available_now', reason: 'accept_rolled_back_assign_doctor_failed' }),
        );
        // Re-routed, not released: this failure IS the doctor's, so FR-10.6's
        // "next available doctor" is exactly right.
        expect(h.bookings.getBooking).toHaveBeenCalled();
      });

      it('the consultation left awaiting_doctor mid-accept -> the doctor is freed and the accept is refused', async () => {
        const h = buildHarness();
        h.bookings.transitionInstantConsultation.mockResolvedValue({ changed: false, booking: null, refusal: 'illegal_transition' });

        await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION },
        });
        expect(h.presence.transition).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'available_now', reason: 'accept_rolled_back_consultation_left_awaiting_doctor' }),
        );
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * "A declined request reaches the next doctor with no patient action."
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('decline (FR-10.6)', () => {
    it('*** REACHES THE NEXT DOCTOR WITH NO PATIENT ACTION *** — one doctor call, and attempt 2 is offered', async () => {
      const h = buildHarness();
      h.repo.getRoutingState
        .mockResolvedValueOnce({ lastAttemptNumber: 1, triedDoctorIds: [DOCTOR_ID], hasPending: false });
      h.doctors.listInstantRoutingCandidates.mockResolvedValue([
        { doctorId: NEXT_DOCTOR_ID, fullName: 'Dr Next', consultationFeeInr: '900.00', consultationDurationMinutes: 20 },
      ]);

      await h.service.decline(ATTEMPT_ID, DOCTOR_ID);

      expect(h.repo.updateOutcomeIfIn).toHaveBeenCalledWith(ATTEMPT_ID, ['pending'], 'declined', {}, expect.anything());
      // The declining doctor goes back into the pool...
      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'instant_request_declined' }),
      );
      // ...and attempt 2 lands on somebody else, triggered by nothing the
      // patient did.
      expect(h.repo.insertAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ attemptNumber: 2, doctorId: NEXT_DOCTOR_ID }),
        expect.anything(),
      );
    });

    it('tells the declining doctors other devices to stop showing the request', async () => {
      const h = buildHarness();
      await h.service.decline(ATTEMPT_ID, DOCTOR_ID);

      expect(h.presence.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          doctorId: DOCTOR_ID,
          type: 'instant_request_settled',
          data: expect.objectContaining({ outcome: 'declined' }),
        }),
      );
    });

    it('is still a valid decline even when the re-route fails', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValueOnce(makeBooking()).mockRejectedValue(new Error('booking module is down'));

      await expect(h.service.decline(ATTEMPT_ID, DOCTOR_ID)).resolves.toMatchObject({ outcome: 'declined' });
    });

    it('404s for another doctors request', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ doctorId: NEXT_DOCTOR_ID }));

      await expect(h.service.decline(ATTEMPT_ID, DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * Timeout
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('timeOutAttempt', () => {
    it('times a lapsed offer out, frees the doctor, and withdraws it from their stream', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.updateOutcomeIfIn.mockResolvedValue(makeAttempt({ outcome: 'timed_out' }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(true);

      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'instant_request_timed_out' }),
      );
      expect(h.presence.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'instant_request_withdrawn' }),
      );
    });

    it('returns the doctor to available_now, not offline — the disconnect handler owns offline', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.updateOutcomeIfIn.mockResolvedValue(makeAttempt({ outcome: 'timed_out' }));

      await h.service.timeOutAttempt(ATTEMPT_ID);

      const targets = h.presence.transition.mock.calls.map((call: unknown[]) => (call[0] as { to: string }).to);
      expect(targets).toEqual(['available_now']);
    });

    it('does nothing to an offer the doctor answered first', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ outcome: 'accepted' }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(false);
      expect(h.repo.updateOutcomeIfIn).not.toHaveBeenCalled();
      expect(h.presence.transition).not.toHaveBeenCalled();
    });

    it('does nothing to an offer whose window has not closed yet', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() + 30_000) }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(false);
    });

    it('is safe to call twice — the second caller reports false and re-routes nothing', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.updateOutcomeIfIn.mockResolvedValue(null);

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(false);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * The completion gate
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * *** THE HOLE M-14 FOUND AND COULD NOT CLOSE FROM ITS SIDE. ***
   *
   * An INSTANT consult reaches `in_consultation` at accept. Nothing did that
   * for a SCHEDULED one, so a doctor sitting `available_now` could be offered
   * an instant request in the middle of a booked video call. The legal
   * from-states live in this module's constants, so the fix had to live here.
   */
  describe('markConsultInProgress', () => {
    it('*** TAKES THE DOCTOR OUT OF THE ROUTING POOL *** for a SCHEDULED consult', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled', doctorId: DOCTOR_ID, status: 'scheduled' }));

      const result = await h.service.markConsultInProgress(CONSULTATION_ID);

      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'in_consultation' }),
      );
      expect(result).toMatchObject({ changed: true, doctorId: DOCTOR_ID });
    });

    /** Mode-agnostic on purpose, so M-14 calls it for every call without asking which kind it is. */
    it('is an idempotent no-op for an INSTANT consult, which is already there', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'instant', doctorId: DOCTOR_ID, status: 'pending_payment' }));
      h.presence.transition.mockResolvedValue({ changed: false, before: 'in_consultation', after: 'in_consultation' });

      const result = await h.service.markConsultInProgress(CONSULTATION_ID);

      expect(result).toMatchObject({ changed: false, presence: 'in_consultation' });
      expect(result.refusal).toBeUndefined();
    });

    /**
     * A doctor who owes documentation may not be ROUTED a new instant request,
     * but they may certainly take the scheduled call already in their diary —
     * which is why `in_consultation` is absent from PRESENCE_REQUIRING_NO_GATE.
     */
    it('does not demand an ungated doctor', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled', doctorId: DOCTOR_ID, status: 'scheduled' }));

      await h.service.markConsultInProgress(CONSULTATION_ID);

      const passed = h.presence.transition.mock.calls[0][0] as Record<string, unknown>;
      expect(passed.requireNotGated).toBeUndefined();
    });

    /* Never throws — the caller is a webhook handler that must answer 2xx. */

    it('reports not_found rather than throwing', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(null);

      await expect(h.service.markConsultInProgress(CONSULTATION_ID)).resolves.toEqual({
        changed: false,
        doctorId: null,
        presence: null,
        refusal: 'not_found',
      });
    });

    it('reports no_doctor for a consultation still searching for one', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: null, status: 'awaiting_doctor' }));

      const result = await h.service.markConsultInProgress(CONSULTATION_ID);

      expect(result.refusal).toBe('no_doctor');
      expect(h.presence.transition).not.toHaveBeenCalled();
    });

    it('surfaces a refused presence move without throwing', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled', doctorId: DOCTOR_ID, status: 'scheduled' }));
      h.presence.transition.mockResolvedValue({ changed: false, before: 'completing_notes', after: 'completing_notes', refusal: 'illegal_transition' });

      await expect(h.service.markConsultInProgress(CONSULTATION_ID)).resolves.toMatchObject({
        changed: false,
        refusal: 'illegal_transition',
      });
    });
  });

  describe('markInstantConsultEnded', () => {
    it('*** SETS THE GATE BEFORE MOVING PRESENCE *** — a crash between the two must fail safe', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: DOCTOR_ID, status: 'in_progress' }));
      const order: string[] = [];
      h.doctors.setCompletionGate.mockImplementation(async () => {
        order.push('gate');
        return { changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: CONSULTATION_ID };
      });
      h.presence.transition.mockImplementation(async (input: { to: string }) => {
        order.push(`presence:${input.to}`);
        return { changed: true, before: 'in_consultation', after: input.to };
      });

      await h.service.markInstantConsultEnded(CONSULTATION_ID);

      expect(order).toEqual(['gate', 'presence:completing_notes']);
      expect(h.doctors.setCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, consultationId: CONSULTATION_ID }),
      );
    });

    it('refuses when the doctor still owes documentation for an EARLIER consultation', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: DOCTOR_ID }));
      h.doctors.setCompletionGate.mockResolvedValue({
        changed: false,
        doctorId: DOCTOR_ID,
        blockedByConsultationId: 'older-consultation',
        refusal: 'already_gated',
      });

      await expect(h.service.markInstantConsultEnded(CONSULTATION_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.COMPLETION_GATE_ACTIVE, blockedByConsultationId: 'older-consultation' },
      });
    });

    it('refuses a consultation with no doctor to gate', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: null }));

      await expect(h.service.markInstantConsultEnded(CONSULTATION_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION },
      });
    });

    it('refuses a scheduled consultation', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled', doctorId: DOCTOR_ID }));

      await expect(h.service.markInstantConsultEnded(CONSULTATION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markOwnInstantConsultEnded (the doctor-facing form)', () => {
    it('404s when the consultation is not the calling doctors — no doctor may gate another', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: NEXT_DOCTOR_ID }));

      await expect(h.service.markOwnInstantConsultEnded(CONSULTATION_ID, DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.doctors.setCompletionGate).not.toHaveBeenCalled();
    });

    it('proceeds for the doctors own consultation', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ doctorId: DOCTOR_ID }));

      await expect(h.service.markOwnInstantConsultEnded(CONSULTATION_ID, DOCTOR_ID)).resolves.toMatchObject({ changed: true });
    });
  });

  describe('clearCompletionGate', () => {
    it('clears by consultation and puts the doctor back in the pool', async () => {
      const h = buildHarness();

      await expect(h.service.clearCompletionGate(CONSULTATION_ID)).resolves.toMatchObject({ changed: true });

      expect(h.doctors.clearCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: CONSULTATION_ID }),
      );
      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ doctorId: DOCTOR_ID, to: 'available_now', reason: 'completion_gate_cleared' }),
      );
    });

    it('is IDEMPOTENT — clearing a gate nobody holds does nothing and moves nobody', async () => {
      const h = buildHarness();
      h.doctors.clearCompletionGate.mockResolvedValue({ changed: false, doctorId: null, blockedByConsultationId: null });

      await expect(h.service.clearCompletionGate(CONSULTATION_ID)).resolves.toEqual({
        changed: false,
        doctorId: null,
        blockedByConsultationId: null,
      });
      expect(h.presence.transition).not.toHaveBeenCalled();
    });

    it('does not drag an offline doctor back online — the presence move is best-effort', async () => {
      const h = buildHarness();
      h.presence.transition.mockResolvedValue({
        changed: false,
        before: 'offline',
        after: 'offline',
        refusal: 'illegal_transition',
      });

      await expect(h.service.clearCompletionGate(CONSULTATION_ID)).resolves.toMatchObject({ changed: true });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * Reads
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('getStatus', () => {
    it('refuses another patients consultation with the same 404 a stranger gets', async () => {
      const h = buildHarness();

      await expect(h.service.getStatus(CONSULTATION_ID, OTHER_PATIENT_ID)).rejects.toMatchObject({
        response: { code: INSTANT_ERROR_CODES.INSTANT_CONSULT_NOT_FOUND },
      });
    });

    it('reports the pending offers deadline while routing', async () => {
      const h = buildHarness();
      const expiresAt = new Date(Date.now() + 45_000);
      h.repo.listAttemptsByConsultation.mockResolvedValue([makeAttempt({ expiresAt })]);

      await expect(h.service.getStatus(CONSULTATION_ID, PATIENT_ID)).resolves.toMatchObject({
        status: 'awaiting_doctor',
        attemptCount: 1,
        offerExpiresAt: expiresAt,
      });
    });

    it('reports the PAYMENT deadline once accepted — one column, two consecutive meanings', async () => {
      const h = buildHarness();
      const payBy = new Date(Date.now() + 300_000);
      h.repo.listAttemptsByConsultation.mockResolvedValue([makeAttempt({ outcome: 'accepted', expiresAt: payBy })]);
      h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'pending_payment', doctorId: DOCTOR_ID }));

      await expect(h.service.getStatus(CONSULTATION_ID, PATIENT_ID)).resolves.toMatchObject({
        status: 'pending_payment',
        offerExpiresAt: payBy,
        payment: { paymentId: PAYMENT_ID, status: 'created' },
      });
    });

    it('survives a payment-module failure rather than breaking the poll', async () => {
      const h = buildHarness();
      h.payments.getByConsultationId.mockRejectedValue(new Error('payment module is down'));

      await expect(h.service.getStatus(CONSULTATION_ID, PATIENT_ID)).resolves.toMatchObject({ payment: null });
    });

    /**
     * *** THE GAP THIS CLOSED. *** The order is minted on the DOCTOR's accept,
     * so the patient never sees `createOrderForConsultation`'s return value.
     * Before this, the handles travelled only on a push notification — which
     * carried just `paymentId`, and which has no credentials configured and so
     * has never been delivered. A flow whose only route to payment is an
     * undelivered notification has no route to payment.
     */
    it('carries the checkout handles, so a POLLING patient can open the gateway', async () => {
      const h = buildHarness();
      h.repo.listAttemptsByConsultation.mockResolvedValue([makeAttempt({ outcome: 'accepted' })]);
      h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'pending_payment', doctorId: DOCTOR_ID }));

      const view = await h.service.getStatus(CONSULTATION_ID, PATIENT_ID);

      expect(view.payment?.handles).toEqual({ gatewayOrderId: 'order_test_1', gatewayKeyId: 'rzp_test_key' });
    });

    /** Degrades on its own: a poll is also how the patient learns they were DECLINED. */
    it('still reports the payment when only the handles read fails', async () => {
      const h = buildHarness();
      h.payments.getCheckoutHandles.mockRejectedValue(new Error('gateway config missing'));

      const view = await h.service.getStatus(CONSULTATION_ID, PATIENT_ID);

      expect(view.payment).toMatchObject({ paymentId: PAYMENT_ID, status: 'created', handles: null });
    });

    /** Nothing left to pay -> no handles, so a captured payment cannot be charged twice. */
    it('reports null handles once there is nothing left to pay', async () => {
      const h = buildHarness();
      h.payments.getCheckoutHandles.mockResolvedValue(null);

      const view = await h.service.getStatus(CONSULTATION_ID, PATIENT_ID);

      expect(view.payment?.handles).toBeNull();
    });
  });

  describe('getInstantConsult', () => {
    it('returns the whole routing history with the outstanding offer picked out', async () => {
      const h = buildHarness();
      h.repo.listAttemptsByConsultation.mockResolvedValue([
        makeAttempt({ id: 'a1', attemptNumber: 1, outcome: 'declined' }),
        makeAttempt({ id: 'a2', attemptNumber: 2, outcome: 'timed_out' }),
        makeAttempt({ id: 'a3', attemptNumber: 3, outcome: 'pending' }),
      ]);

      const view = await h.service.getInstantConsult(CONSULTATION_ID);

      expect(view?.attempts).toHaveLength(3);
      expect(view?.pendingAttempt?.id).toBe('a3');
    });

    it('returns null for a scheduled consultation rather than pretending it has a history', async () => {
      const h = buildHarness();
      h.bookings.getBooking.mockResolvedValue(makeBooking({ mode: 'scheduled' }));

      await expect(h.service.getInstantConsult(CONSULTATION_ID)).resolves.toBeNull();
    });
  });

  describe('releaseRequest', () => {
    it('supersedes any pending offer, releases the consultation, and tells the patient', async () => {
      const h = buildHarness();
      h.repo.supersedePendingAttempts.mockResolvedValue(1);

      await h.service.releaseRequest(CONSULTATION_ID, 'test_reason', INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE);

      // `superseded`, not `declined` or `timed_out`: the doctor did neither.
      expect(h.repo.supersedePendingAttempts).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(h.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_ROUTING,
          metadata: expect.objectContaining({ change: 'instant_request_released', supersededAttempts: 1 }),
        }),
      );
      expect(h.notifications.notify).toHaveBeenCalled();
    });

    it('stays quiet when the consultation had already moved on', async () => {
      const h = buildHarness();
      h.bookings.transitionInstantConsultation.mockResolvedValue({ changed: false, booking: null, refusal: 'illegal_transition' });

      await h.service.releaseRequest(CONSULTATION_ID, 'test', 'tmpl');

      expect(h.audit.write).not.toHaveBeenCalled();
      expect(h.notifications.notify).not.toHaveBeenCalled();
    });
  });
  /* ═══════════════════════════════════════════════════════════════════════
   * ADVERSARIAL REVIEW — the defects found by attacking this file.
   * Every test below fails without its fix; the comment on each says how.
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('*** a system release must never override a doctor own choice ***', () => {
    /**
     * DEFECT. `InstantPresenceService#transition` computed its `from` set as
     * `LEGAL_PRESENCE_TRANSITIONS[to]`, which for `available_now` includes
     * `offline`, `paused` and `scheduled_only`. So the acceptance sweep giving
     * back a doctor whose offer had lapsed did not release THIS offer's
     * reservation — it force-wrote `available_now` over whatever the doctor
     * had chosen since.
     *
     * Reachable with two ordinary API calls: the doctor is offered a request
     * (`request_pending`), taps Paused (legal, and self-settable, FROM
     * `request_pending`), and 60 seconds later the sweep drags them back into
     * the routing pool and the router hands them the next request.
     */
    it('a timed-out offer releases the reservation ONLY out of request_pending — a doctor who tapped Paused stays paused', async () => {
      const h = buildHarness();
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.updateOutcomeIfIn.mockResolvedValue(makeAttempt({ outcome: 'timed_out' }));

      await h.service.timeOutAttempt(ATTEMPT_ID);

      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'available_now', onlyFrom: ['request_pending'] }),
      );
    });

    it('a decline releases the reservation ONLY out of request_pending', async () => {
      const h = buildHarness();

      await h.service.decline(ATTEMPT_ID, DOCTOR_ID);

      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'available_now', onlyFrom: ['request_pending'] }),
      );
    });

    /**
     * DEFECT. `clearCompletionGate`'s own doc comment says "a doctor who
     * finished their notes at midnight and closed the app is `offline`, and
     * dragging them back into the routing pool because they filed some
     * paperwork would be exactly wrong". The code did exactly that: `offline`,
     * `paused` and `scheduled_only` are all in `available_now`'s legal `from`
     * set.
     */
    it('clearing the completion gate moves a doctor ONLY out of completing_notes — never out of offline or paused', async () => {
      const h = buildHarness();

      await h.service.clearCompletionGate(CONSULTATION_ID);

      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'available_now', onlyFrom: ['completing_notes'] }),
      );
    });
  });

  describe('*** the accept saga, re-ordered ***', () => {
    /**
     * DEFECT. The order was: mint the gateway order, THEN assign the doctor.
     * `assignDoctor` throws whenever the doctor stopped being listable between
     * the offer and the answer (an admin unlisting them mid-window is enough),
     * and the compensation re-routed to the next doctor — leaving the
     * `payments` row behind. `payments.consultation_id` is UNIQUE and
     * `PaymentService#createOrderForConsultation` refuses outright when a row
     * already exists, so the NEXT doctor's accept died on
     * `PAYMENT_ALREADY_EXISTS` and the patient's request was released as "no
     * doctor available" — with a live gateway order and a pinned quote
     * stranded behind it.
     */
    it('assigns the doctor BEFORE minting the order', async () => {
      const h = buildHarness();
      const order: string[] = [];
      h.bookings.assignDoctor.mockImplementation(async () => {
        order.push('assignDoctor');
        return makeBooking({ doctorId: DOCTOR_ID });
      });
      h.payments.createOrderForConsultation.mockImplementation(async () => {
        order.push('createOrder');
        return { paymentId: PAYMENT_ID, gatewayOrderId: 'order_test_1', gatewayKeyId: 'rzp_test_key', breakdown: {} };
      });

      await h.service.accept(ATTEMPT_ID, DOCTOR_ID);

      expect(order).toEqual(['assignDoctor', 'createOrder']);
    });

    it('a doctor who stopped being listable mid-offer leaves NO payments row behind for the next doctor to trip over', async () => {
      const h = buildHarness();
      h.bookings.assignDoctor.mockRejectedValue(new Error('doctor is not bookable'));

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toThrow(ConflictException);

      // The whole point: nothing was minted, so the re-route the compensation
      // just fired is genuinely free for the next doctor.
      expect(h.payments.createOrderForConsultation).not.toHaveBeenCalled();
      expect(h.presence.transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'available_now', reason: 'accept_rolled_back_assign_doctor_failed' }),
      );
    });

    /**
     * DEFECT. Step (e)'s presence write was fire-and-forget, and
     * `in_consultation` was reachable ONLY from `request_pending`. A doctor
     * whose stream dropped (the disconnect handler writes `offline`) or who
     * tapped Paused while the offer was open answered from a state the table
     * refused; the refusal was discarded, and the doctor stayed ROUTABLE while
     * holding a consultation — free to be offered a second one.
     */
    it('refuses to leave a doctor ROUTABLE after they accepted — a refused presence commit releases the request', async () => {
      const h = buildHarness();
      h.presence.transition.mockImplementation(async (input: { to: string }) =>
        input.to === 'in_consultation'
          ? { changed: false, before: 'completing_notes', after: 'completing_notes', refusal: 'illegal_transition' }
          : { changed: true, before: 'available_now', after: input.to },
      );

      await expect(h.service.accept(ATTEMPT_ID, DOCTOR_ID)).rejects.toThrow(ConflictException);

      expect(h.repo.supersedePendingAttempts).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'expired', reason: 'presence_commit_failed' }),
      );
    });
  });

  describe('*** an offer that lapsed because the REQUEST went away is not the doctor fault ***', () => {
    /**
     * DEFECT. A patient cancelling through M-11's `POST /bookings/:id/cancel`
     * — which accepts `awaiting_doctor` and, correctly, knows nothing about
     * this module — leaves the pending offer on a doctor's screen until the
     * acceptance sweep reaches it. That wrote `timed_out` against the doctor,
     * and FR-18.6's acceptance rate is computed straight off these rows.
     * `superseded` is the outcome that already means exactly this; nothing was
     * using it for the case where the patient acted first.
     */
    it('records superseded, not timed_out, when the consultation has left awaiting_doctor', async () => {
      const h = buildHarness();
      h.repo.findAttemptById.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.bookings.getBooking.mockResolvedValue(makeBooking({ status: 'cancelled' }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(true);

      expect(h.repo.updateOutcomeIfIn).toHaveBeenCalledWith(ATTEMPT_ID, ['pending'], 'superseded', {}, expect.anything());
    });

    it('POSITIVE CONTROL: still records timed_out when the request really was still looking for a doctor', async () => {
      const h = buildHarness();
      h.repo.findAttemptById.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));
      h.repo.findAttemptByIdForUpdate.mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1_000) }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(true);

      expect(h.repo.updateOutcomeIfIn).toHaveBeenCalledWith(ATTEMPT_ID, ['pending'], 'timed_out', {}, expect.anything());
    });

    it('does not read the consultation at all for an offer that is no longer pending', async () => {
      const h = buildHarness();
      h.repo.findAttemptById.mockResolvedValue(makeAttempt({ outcome: 'accepted' }));

      await expect(h.service.timeOutAttempt(ATTEMPT_ID)).resolves.toBe(false);
      expect(h.bookings.getBooking).not.toHaveBeenCalled();
    });
  });

  describe('*** a failed re-route must not strand the request ***', () => {
    /**
     * DEFECT. `routeNextQuietly` swallowed the throw and its comment claimed
     * "the acceptance sweep will try again". It cannot:
     * `findExpiredPendingAttempts` only ever returns offers whose outcome is
     * still `pending`, and the attempt that triggered the re-route is
     * `declined` by then. `awaiting_doctor` carries no `hold_expires_at`, so
     * M-11's hold sweep and this module's payment sweep cannot see it either.
     * The consultation sat in `awaiting_doctor` forever, alive on the
     * patient's screen and dead in the database.
     */
    it('releases the consultation when the re-route after a decline throws', async () => {
      const h = buildHarness();
      // The decline itself succeeds; the NEXT routing pass blows up.
      h.doctors.listInstantRoutingCandidates.mockRejectedValue(new Error('candidate query failed'));

      await h.service.decline(ATTEMPT_ID, DOCTOR_ID);

      expect(h.bookings.transitionInstantConsultation).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'expired', from: ['awaiting_doctor', 'pending_payment'] }),
      );
      expect(h.notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE }),
      );
    });

    it('still does not throw at the caller when even the release fails', async () => {
      const h = buildHarness();
      h.doctors.listInstantRoutingCandidates.mockRejectedValue(new Error('candidate query failed'));
      h.repo.supersedePendingAttempts.mockRejectedValue(new Error('database is gone'));

      await expect(h.service.decline(ATTEMPT_ID, DOCTOR_ID)).resolves.toMatchObject({ outcome: 'declined' });
    });
  });
});
