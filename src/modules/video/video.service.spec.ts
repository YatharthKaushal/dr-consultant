import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BookingView } from '../booking/booking.contract';
import type { AuthContext } from '../../shared/auth/auth.types';
import { VIDEO_ERROR_CODES } from './video.constants';
import { VideoService } from './video.service';

/**
 * *** M-14's DONE-WHEN, HALF OF IT: "only the two assigned participants can
 * join". ***
 *
 * `docs/MODULES.md` M-14. This spec is where that claim is proved for
 * everything a `jest.fn()` can answer — the gate's logic, its ORDER, and every
 * refusal. The other half (idempotency under redelivery) needs a real database
 * and lives in `video.webhook-idempotency.integration.spec.ts`.
 *
 * Hand-rolled `jest.fn()` dependencies and `new VideoService(...)`, never
 * `Test.createTestingModule` — this codebase's rule, and the reason every
 * refusal below is one line of setup rather than a module graph.
 */

const PATIENT_ID = randomUUID();
const DOCTOR_ID = randomUUID();
const CONSULTATION_ID = randomUUID();

/** *** THE THIRD PARTY. *** Neither the patient nor the doctor on the consultation. */
const INTRUDER_PATIENT_ID = randomUUID();
const INTRUDER_DOCTOR_ID = randomUUID();

const asPatient: AuthContext = { accountType: 'patient', accountId: PATIENT_ID };
const asDoctor: AuthContext = { accountType: 'doctor', accountId: DOCTOR_ID };

function bookingView(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-0001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: randomUUID(),
    concernId: null,
    mode: 'scheduled',
    status: 'scheduled',
    // In the past, so the join window is open unless a test says otherwise.
    scheduledStartAt: new Date(Date.now() - 60_000),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function build(overrides: {
  booking?: BookingView | null;
  paymentStatus?: string | null;
  paymentThrows?: boolean;
  hasConsent?: boolean;
  consentThrows?: boolean;
  tokenMintFails?: boolean;
  joinWindowMinutes?: number;
} = {}) {
  const booking = overrides.booking === undefined ? bookingView() : overrides.booking;

  const bookings = {
    getBooking: jest.fn().mockResolvedValue(booking),
    transitionConsultationStatus: jest.fn().mockResolvedValue({ changed: true, booking }),
    listConsultationIdsBetween: jest.fn().mockResolvedValue([]),
  };

  const payments = {
    getByConsultationId: overrides.paymentThrows
      ? jest.fn().mockRejectedValue(new Error('payment module unreachable'))
      : jest.fn().mockResolvedValue(
          overrides.paymentStatus === null
            ? null
            : { paymentId: randomUUID(), status: overrides.paymentStatus ?? 'paid', paidAt: new Date() },
        ),
  };

  const patients = { getProfileSummary: jest.fn().mockResolvedValue({ id: PATIENT_ID, fullName: 'A Patient' }) };
  const instant = {
    markInstantConsultEnded: jest.fn().mockResolvedValue({ changed: true, doctorId: DOCTOR_ID }),
    markConsultInProgress: jest
      .fn()
      .mockResolvedValue({ changed: true, doctorId: DOCTOR_ID, presence: 'in_consultation' }),
  };

  const consent = {
    checkPatientConsent: overrides.consentThrows
      ? jest.fn().mockRejectedValue(new Error('consent module unreachable'))
      : jest.fn().mockResolvedValue({
          hasCurrentConsent: overrides.hasConsent ?? true,
          acceptedVersion: (overrides.hasConsent ?? true) ? '1.0' : null,
          acceptedAt: (overrides.hasConsent ?? true) ? new Date() : null,
          currentVersion: '1.0',
        }),
  };

  const livekit = {
    mintJoinToken: jest.fn().mockResolvedValue(overrides.tokenMintFails ? null : 'a.signed.jwt'),
    getServerUrl: jest.fn().mockReturnValue('wss://livekit.test.invalid'),
    getApiKey: jest.fn().mockReturnValue('devkey'),
  };

  const config = {
    getJoinTokenTtlSeconds: jest.fn().mockResolvedValue(300),
    getJoinWindowMinutes: jest.fn().mockResolvedValue(overrides.joinWindowMinutes ?? 15),
  };

  const repo = { listConnections: jest.fn().mockResolvedValue([]) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new VideoService(
    repo as never,
    bookings as never,
    payments as never,
    patients as never,
    instant as never,
    livekit as never,
    config as never,
    consent as never,
    audit as never,
  );

  return { service, bookings, payments, patients, instant, consent, livekit, config, repo, audit };
}

/** Reads the `code` off a thrown Nest exception's response body. */
function codeOf(error: unknown): string | undefined {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  return (response as { code?: string } | undefined)?.code;
}

async function captureThrow(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, and it did not.');
}

describe('VideoService', () => {
  describe('GATE 1 — only the two assigned participants can join', () => {
    it('mints for the assigned PATIENT', async () => {
      const { service, livekit } = build();

      const ticket = await service.issueJoinTicket(CONSULTATION_ID, asPatient);

      expect(ticket.party).toBe('patient');
      expect(ticket.identity).toBe(`patient:${PATIENT_ID}`);
      expect(ticket.roomName).toBe(`consult-${CONSULTATION_ID}`);
      expect(ticket.token).toBe('a.signed.jwt');
      expect(ticket.serverUrl).toBe('wss://livekit.test.invalid');
      expect(livekit.mintJoinToken).toHaveBeenCalledTimes(1);
    });

    it('mints for the assigned DOCTOR', async () => {
      const { service } = build();

      const ticket = await service.issueJoinTicket(CONSULTATION_ID, asDoctor);

      expect(ticket.party).toBe('doctor');
      expect(ticket.identity).toBe(`doctor:${DOCTOR_ID}`);
    });

    it('*** REFUSES A THIRD-PARTY PATIENT, AND MINTS NOTHING ***', async () => {
      const { service, livekit, payments, consent } = build();

      const error = await captureThrow(
        service.issueJoinTicket(CONSULTATION_ID, { accountType: 'patient', accountId: INTRUDER_PATIENT_ID }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
      // *** ORDERING. *** Ownership is checked FIRST, so a stranger learns
      // nothing about the consultation's payment or consent state either.
      expect(payments.getByConsultationId).not.toHaveBeenCalled();
      expect(consent.checkPatientConsent).not.toHaveBeenCalled();
    });

    it('*** REFUSES A THIRD-PARTY DOCTOR, AND MINTS NOTHING ***', async () => {
      const { service, livekit } = build();

      const error = await captureThrow(
        service.issueJoinTicket(CONSULTATION_ID, { accountType: 'doctor', accountId: INTRUDER_DOCTOR_ID }),
      );

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('refuses an ADMIN, who is on no side of the consultation', async () => {
      const { service, livekit } = build();

      const error = await captureThrow(
        service.issueJoinTicket(CONSULTATION_ID, { accountType: 'admin', accountId: randomUUID() }),
      );

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('refuses a caller whose id matches the OTHER side of the consultation', async () => {
      // A doctor account presenting the patient's id, or vice versa. The party
      // is derived from the booking AND the account type together, so neither
      // half alone opens the door.
      const { service } = build();

      const asWrongType: AuthContext = { accountType: 'doctor', accountId: PATIENT_ID };
      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asWrongType)))).toBe(
        VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND,
      );
    });

    it('*** ANSWERS 404 AND NOT 403, SO NOBODY CAN PROBE FOR A CONSULTATION ***', async () => {
      // The consultation that does not exist and the consultation that is not
      // yours must be indistinguishable — otherwise the pair of responses is an
      // oracle for enumerating consultations by id.
      const missing = build({ booking: null });
      const notMine = build();

      const onMissing = await captureThrow(missing.service.issueJoinTicket(CONSULTATION_ID, asPatient));
      const onNotMine = await captureThrow(
        notMine.service.issueJoinTicket(CONSULTATION_ID, { accountType: 'patient', accountId: INTRUDER_PATIENT_ID }),
      );

      expect(onMissing).toBeInstanceOf(NotFoundException);
      expect(onNotMine).toBeInstanceOf(NotFoundException);
      expect(codeOf(onMissing)).toBe(codeOf(onNotMine));
      expect((onMissing as NotFoundException).message).toBe((onNotMine as NotFoundException).message);
    });
  });

  describe('GATE 2 — payment', () => {
    it.each([
      ['created', 'created'],
      ['pending', 'pending'],
      ['failed', 'failed'],
      ['refunded', 'refunded'],
    ])('refuses a %s payment', async (_label, status) => {
      const { service, livekit } = build({ paymentStatus: status });

      const error = await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(error).toBeInstanceOf(ConflictException);
      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.PAYMENT_NOT_COMPLETED);
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('refuses when there is no payment row at all', async () => {
      const { service } = build({ paymentStatus: null });
      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient)))).toBe(
        VIDEO_ERROR_CODES.PAYMENT_NOT_COMPLETED,
      );
    });

    it('*** FAILS CLOSED when the payment module THROWS ***', async () => {
      // An unreachable payment module means we do not know whether this was
      // paid for, and "do not know" must never open the door.
      const { service, livekit, consent } = build({ paymentThrows: true });

      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient)))).toBe(
        VIDEO_ERROR_CODES.PAYMENT_NOT_COMPLETED,
      );
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
      expect(consent.checkPatientConsent).not.toHaveBeenCalled();
    });
  });

  describe('GATE 3 — consent', () => {
    it('refuses when the patient has not accepted the current version, and says which version', async () => {
      const { service, livekit } = build({ hasConsent: false });

      const error = await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSENT_REQUIRED);
      expect((error as ConflictException).getResponse()).toMatchObject({ currentVersion: '1.0' });
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('*** CHECKS THE PATIENT\'S CONSENT EVEN WHEN THE DOCTOR IS ASKING ***', async () => {
      // Consent is a precondition of the CONSULTATION, not of the caller. A
      // doctor sitting alone in a room the patient cannot enter helps nobody.
      const { service, consent, livekit } = build({ hasConsent: false });

      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asDoctor)))).toBe(
        VIDEO_ERROR_CODES.CONSENT_REQUIRED,
      );
      expect(consent.checkPatientConsent).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        documentType: 'teleconsultation_consent',
      });
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('*** FAILS CLOSED when the consent port THROWS, despite the contract saying it never does ***', async () => {
      // The port is documented as never throwing — but it will be rebound to a
      // real module, and this module's guarantee must not depend on another
      // one keeping its promise.
      const { service, livekit } = build({ consentThrows: true });

      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient)))).toBe(
        VIDEO_ERROR_CODES.CONSENT_REQUIRED,
      );
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });
  });

  describe('status and the join window', () => {
    it.each([
      'pending_payment',
      'awaiting_doctor',
      'awaiting_documentation',
      'completed',
      'cancelled',
      'no_show',
      'expired',
    ] as const)('refuses to mint while the consultation is %s', async (status) => {
      const { service, livekit } = build({ booking: bookingView({ status }) });

      const error = await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_JOINABLE);
      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
    });

    it('mints while `in_progress`, because a RECONNECT has to work', async () => {
      const { service } = build({ booking: bookingView({ status: 'in_progress' }) });
      await expect(service.issueJoinTicket(CONSULTATION_ID, asPatient)).resolves.toMatchObject({ party: 'patient' });
    });

    it('refuses an instant consult that has no doctor yet, with its own code', async () => {
      const { service } = build({
        booking: bookingView({ mode: 'instant', doctorId: null, scheduledStartAt: null, status: 'scheduled' }),
      });

      expect(codeOf(await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient)))).toBe(
        VIDEO_ERROR_CODES.DOCTOR_NOT_ASSIGNED,
      );
    });

    it('refuses before the join window opens, and says when it does', async () => {
      const { service } = build({
        booking: bookingView({ scheduledStartAt: new Date(Date.now() + 60 * 60_000) }),
        joinWindowMinutes: 15,
      });

      const error = await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.JOIN_WINDOW_NOT_OPEN);
      expect((error as ConflictException).getResponse()).toMatchObject({ joinWindowMinutes: 15 });
    });

    it('mints once inside the window', async () => {
      const { service } = build({
        booking: bookingView({ scheduledStartAt: new Date(Date.now() + 10 * 60_000) }),
        joinWindowMinutes: 15,
      });
      await expect(service.issueJoinTicket(CONSULTATION_ID, asPatient)).resolves.toBeDefined();
    });

    it('*** APPLIES NO WINDOW TO AN INSTANT CONSULT, WHICH HAS NO SCHEDULED TIME ***', async () => {
      const { service, config } = build({
        booking: bookingView({ mode: 'instant', scheduledStartAt: null }),
      });

      await expect(service.issueJoinTicket(CONSULTATION_ID, asPatient)).resolves.toBeDefined();
      expect(config.getJoinWindowMinutes).not.toHaveBeenCalled();
    });

    it('applies no window to a call already `in_progress`, so an overrun cannot cut a reconnect off', async () => {
      const { service, config } = build({
        booking: bookingView({ status: 'in_progress', scheduledStartAt: new Date(Date.now() + 60 * 60_000) }),
      });

      await expect(service.issueJoinTicket(CONSULTATION_ID, asPatient)).resolves.toBeDefined();
      expect(config.getJoinWindowMinutes).not.toHaveBeenCalled();
    });

    it('has NO late bound — the status machine is what closes the gate', async () => {
      const { service } = build({
        booking: bookingView({ scheduledStartAt: new Date(Date.now() - 5 * 60 * 60_000) }),
      });
      await expect(service.issueJoinTicket(CONSULTATION_ID, asPatient)).resolves.toBeDefined();
    });
  });

  describe('the token itself', () => {
    it('carries a role label and never a person\'s name', async () => {
      const { service, livekit } = build();

      await service.issueJoinTicket(CONSULTATION_ID, asPatient);

      expect(livekit.mintJoinToken).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Patient', identity: `patient:${PATIENT_ID}` }),
      );
    });

    it('uses the configured TTL and reports the matching expiry', async () => {
      const { service, config } = build();
      config.getJoinTokenTtlSeconds.mockResolvedValue(600);

      const before = Date.now();
      const ticket = await service.issueJoinTicket(CONSULTATION_ID, asPatient);

      expect(ticket.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
      expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    });

    it('turns a mint failure into a clean code, repeating nothing about the cause', async () => {
      const { service } = build({ tokenMintFails: true });

      const error = await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.TOKEN_MINT_FAILED);
    });

    it('audits the mint with the party and the TTL, and NEVER the token', async () => {
      const { service, audit } = build();

      await service.issueJoinTicket(CONSULTATION_ID, asPatient);

      expect(audit.write).toHaveBeenCalledTimes(1);
      const entry = audit.write.mock.calls[0][0];
      expect(entry).toMatchObject({
        actorType: 'patient',
        actorId: PATIENT_ID,
        action: 'create',
        entityType: 'video_join_token',
        consultationId: CONSULTATION_ID,
      });
      expect(JSON.stringify(entry)).not.toContain('a.signed.jwt');
    });

    it('does not audit a refused join', async () => {
      const { service, audit } = build({ hasConsent: false });

      await captureThrow(service.issueJoinTicket(CONSULTATION_ID, asPatient));

      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('the two status moves', () => {
    it('markCallStarted asks for `in_progress` FROM `scheduled` only', async () => {
      const { service, bookings } = build();

      await service.markCallStarted(CONSULTATION_ID);

      expect(bookings.transitionConsultationStatus).toHaveBeenCalledWith({
        consultationId: CONSULTATION_ID,
        to: 'in_progress',
        from: ['scheduled'],
        reason: 'video_participant_joined',
      });
    });

    /**
     * *** THE HOLE THIS CLOSES. *** An INSTANT consult reaches
     * `in_consultation` at accept, but nothing did that for a SCHEDULED one —
     * so a doctor sitting `available_now` could be handed an instant request
     * in the middle of a booked video call.
     */
    it('takes the doctor OUT OF THE ROUTING POOL when the call starts', async () => {
      const { service, instant } = build();

      await service.markCallStarted(CONSULTATION_ID);

      expect(instant.markConsultInProgress).toHaveBeenCalledWith(CONSULTATION_ID);
    });

    /** The status is the fact FR-8.6 hangs off; a presence write must not cost us it. */
    it('moves the status FIRST, then the presence', async () => {
      const { service, bookings, instant } = build();
      const order: string[] = [];
      bookings.transitionConsultationStatus.mockImplementation(async () => {
        order.push('status');
        return { changed: true, booking: null };
      });
      instant.markConsultInProgress.mockImplementation(async () => {
        order.push('presence');
        return { changed: true, doctorId: DOCTOR_ID, presence: 'in_consultation' };
      });

      await service.markCallStarted(CONSULTATION_ID);

      expect(order).toEqual(['status', 'presence']);
    });

    it('does not touch presence when the status move was refused', async () => {
      const { service, bookings, instant } = build();
      bookings.transitionConsultationStatus.mockResolvedValue({
        changed: false,
        booking: null,
        refusal: 'illegal_transition',
      });

      await service.markCallStarted(CONSULTATION_ID);

      expect(instant.markConsultInProgress).not.toHaveBeenCalled();
    });

    /** Bounded failure: the doctor is offered one request they must decline, and M-13 re-routes it. */
    it('still succeeds when the presence move throws — the caller is a webhook', async () => {
      const { service, instant } = build();
      instant.markConsultInProgress.mockRejectedValue(new Error('doctor module is down'));

      await expect(service.markCallStarted(CONSULTATION_ID)).resolves.toBeUndefined();
    });

    it('markCallStarted never throws on a refused move — its caller is a webhook', async () => {
      const { service, bookings } = build();
      bookings.transitionConsultationStatus.mockResolvedValue({
        changed: false,
        booking: bookingView({ status: 'completed' }),
        refusal: 'illegal_transition',
      });

      await expect(service.markCallStarted(CONSULTATION_ID)).resolves.toBeUndefined();
    });

    it('endSession asks for `awaiting_documentation` FROM `in_progress` only', async () => {
      const { service, bookings } = build();

      await service.endSession(CONSULTATION_ID, 'video_room_finished');

      expect(bookings.transitionConsultationStatus).toHaveBeenCalledWith({
        consultationId: CONSULTATION_ID,
        to: 'awaiting_documentation',
        from: ['in_progress'],
        reason: 'video_room_finished',
      });
    });

    it('*** SETS THE COMPLETION GATE FOR AN INSTANT CONSULT ***', async () => {
      const { service, bookings, instant } = build();
      bookings.transitionConsultationStatus.mockResolvedValue({
        changed: true,
        booking: bookingView({ mode: 'instant', status: 'awaiting_documentation' }),
      });

      const result = await service.endSession(CONSULTATION_ID, 'video_room_finished');

      expect(instant.markInstantConsultEnded).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(result.completionGateSet).toBe(true);
    });

    it('does NOT touch the completion gate for a SCHEDULED consult', async () => {
      const { service, instant } = build();

      await service.endSession(CONSULTATION_ID, 'video_room_finished');

      expect(instant.markInstantConsultEnded).not.toHaveBeenCalled();
    });

    it('does NOT re-gate when the status did not actually move — a redelivered room_finished', async () => {
      const { service, bookings, instant } = build();
      bookings.transitionConsultationStatus.mockResolvedValue({
        changed: false,
        booking: bookingView({ mode: 'instant', status: 'awaiting_documentation' }),
      });

      const result = await service.endSession(CONSULTATION_ID, 'video_room_finished');

      expect(result.changed).toBe(false);
      expect(instant.markInstantConsultEnded).not.toHaveBeenCalled();
    });

    it('*** SURVIVES A THROWING COMPLETION GATE: the call already ended ***', async () => {
      const { service, bookings, instant } = build();
      bookings.transitionConsultationStatus.mockResolvedValue({
        changed: true,
        booking: bookingView({ mode: 'instant', status: 'awaiting_documentation' }),
      });
      instant.markInstantConsultEnded.mockRejectedValue(new Error('instant module unreachable'));

      const result = await service.endSession(CONSULTATION_ID, 'video_room_finished');

      expect(result.changed).toBe(true);
      expect(result.completionGateSet).toBeUndefined();
    });

    it('endSessionAsDoctor refuses a doctor who is not on the consultation', async () => {
      const { service, bookings } = build();

      const error = await captureThrow(
        service.endSessionAsDoctor(CONSULTATION_ID, { accountType: 'doctor', accountId: INTRUDER_DOCTOR_ID }),
      );

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(bookings.transitionConsultationStatus).not.toHaveBeenCalled();
    });
  });

  describe('FR-8.4 — the consultation room', () => {
    it('composes patient, consent, prior history and session, and stores nothing', async () => {
      const priorId = randomUUID();
      const { service, bookings, repo } = build();
      bookings.listConsultationIdsBetween.mockResolvedValue([CONSULTATION_ID, priorId]);
      bookings.getBooking.mockImplementation(async (id: string) =>
        id === priorId ? bookingView({ id: priorId, status: 'completed' }) : bookingView(),
      );

      const room = await service.getConsultationRoom(CONSULTATION_ID, DOCTOR_ID);

      expect(room.patient).toMatchObject({ id: PATIENT_ID });
      expect(room.consent.hasCurrentConsent).toBe(true);
      // The consultation in hand is excluded — it is the subject of the screen.
      expect(room.priorConsultations.map((prior) => prior.id)).toEqual([priorId]);
      expect(room.session.noShowParties).toEqual(['patient', 'doctor']);
      expect(room.documentsEndpoint).toBe(`/api/consultations/${CONSULTATION_ID}/documents`);
      expect(repo.listConnections).toHaveBeenCalledWith(CONSULTATION_ID);
    });

    it('*** REFUSES A DOCTOR WHO IS NOT THIS CONSULTATION\'S DOCTOR, with a 404 ***', async () => {
      const { service, patients } = build();

      const error = await captureThrow(service.getConsultationRoom(CONSULTATION_ID, INTRUDER_DOCTOR_ID));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      // No patient profile is read for a doctor with no relationship to them.
      expect(patients.getProfileSummary).not.toHaveBeenCalled();
    });

    it('caps prior history rather than reading an unbounded number of bookings', async () => {
      const { service, bookings } = build();
      const priorIds = Array.from({ length: 25 }, () => randomUUID());
      bookings.listConsultationIdsBetween.mockResolvedValue(priorIds);
      bookings.getBooking.mockImplementation(async (id: string) => bookingView({ id }));

      const room = await service.getConsultationRoom(CONSULTATION_ID, DOCTOR_ID);

      expect(room.priorConsultations).toHaveLength(10);
    });

    it('still shows the call when the history read fails — the call is the point of the screen', async () => {
      const { service, bookings } = build();
      bookings.listConsultationIdsBetween.mockRejectedValue(new Error('booking unreachable'));

      const room = await service.getConsultationRoom(CONSULTATION_ID, DOCTOR_ID);

      expect(room.priorConsultations).toEqual([]);
      expect(room.booking.id).toBe(CONSULTATION_ID);
    });

    it('shows a REFUSED consent rather than throwing — the doctor needs to see why they cannot start', async () => {
      const { service } = build({ hasConsent: false });

      const room = await service.getConsultationRoom(CONSULTATION_ID, DOCTOR_ID);

      expect(room.consent.hasCurrentConsent).toBe(false);
      expect(room.consent.currentVersion).toBe('1.0');
    });
  });

  describe('getSessionForCaller', () => {
    it('serves both sides of the consultation', async () => {
      const { service } = build();
      await expect(service.getSessionForCaller(CONSULTATION_ID, asPatient)).resolves.toMatchObject({
        consultationId: CONSULTATION_ID,
      });
      await expect(service.getSessionForCaller(CONSULTATION_ID, asDoctor)).resolves.toBeDefined();
    });

    it('refuses a third party with the same 404 the token gate uses', async () => {
      const { service, repo } = build();

      const error = await captureThrow(
        service.getSessionForCaller(CONSULTATION_ID, { accountType: 'patient', accountId: INTRUDER_PATIENT_ID }),
      );

      expect(codeOf(error)).toBe(VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(repo.listConnections).not.toHaveBeenCalled();
    });
  });
});
