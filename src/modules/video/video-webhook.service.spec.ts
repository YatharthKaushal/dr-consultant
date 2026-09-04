import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { BookingView } from '../booking/booking.contract';
import type { LivekitWebhookDelivery } from './livekit.client';
import { VIDEO_ERROR_CODES } from './video.constants';
import { VideoWebhookService } from './video-webhook.service';

/**
 * The LiveKit webhook's own rules, with the SDK and the database mocked out:
 * what gets written, what gets ignored, and what still answers 2xx.
 *
 * *** THE IDEMPOTENCY CLAIM ITSELF IS NOT PROVED HERE. *** "A redelivery writes
 * nothing" is a claim about `ON CONFLICT DO NOTHING` and about a `left_at IS
 * NULL` guard on a `DO UPDATE`, and a `jest.fn()` that returns `false` proves
 * only that this file believes what the repository told it.
 * `video.webhook-idempotency.integration.spec.ts` proves it against a real
 * Postgres. What IS proved here is the half that lives in this file: that a
 * `false` from either write is treated as a replay rather than a failure, and
 * that a replay never re-audits and never re-gates.
 */

const PATIENT_ID = randomUUID();
const DOCTOR_ID = randomUUID();
const CONSULTATION_ID = randomUUID();
const ROOM = `consult-${CONSULTATION_ID}`;

const OTHER_PATIENT_ID = randomUUID();

function bookingView(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-0001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: randomUUID(),
    concernId: null,
    mode: 'scheduled',
    status: 'in_progress',
    scheduledStartAt: new Date('2026-09-04T10:00:00.000Z'),
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

function delivery(overrides: Partial<LivekitWebhookDelivery> = {}): LivekitWebhookDelivery {
  return {
    event: 'participant_joined',
    id: randomUUID(),
    roomName: ROOM,
    participant: {
      sid: 'PA_abcdef',
      identity: `patient:${PATIENT_ID}`,
      joinedAt: new Date('2026-09-04T10:00:05.000Z'),
      disconnectReason: null,
    },
    ...overrides,
  };
}

function build(
  overrides: {
    inserted?: boolean;
    closed?: boolean;
    booking?: BookingView | null;
    /** What `findConnection` answers — an existing row means this leave is closing a join we already recorded. */
    known?: { livekitParticipantSid: string } | undefined;
  } = {},
) {
  const livekit = { verifyWebhook: jest.fn() };
  const repo = {
    insertConnectionIfNew: jest.fn().mockResolvedValue(overrides.inserted ?? true),
    closeConnection: jest.fn().mockResolvedValue(overrides.closed ?? true),
    findConnection: jest.fn().mockResolvedValue(overrides.known ?? undefined),
  };
  const video = {
    markCallStarted: jest.fn().mockResolvedValue(undefined),
    endSession: jest.fn().mockResolvedValue({ consultationId: CONSULTATION_ID, changed: true, status: 'awaiting_documentation' }),
  };
  const bookings = {
    getBooking: jest
      .fn()
      .mockResolvedValue(overrides.booking === undefined ? bookingView() : overrides.booking),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new VideoWebhookService(
    livekit as never,
    repo as never,
    video as never,
    bookings as never,
    audit as never,
  );

  return { service, livekit, repo, video, bookings, audit };
}

describe('VideoWebhookService', () => {
  describe('the auth boundary', () => {
    it('delegates verification to the client, which runs the SDK over the raw bytes', async () => {
      const { service, livekit } = build();
      const verified = delivery();
      livekit.verifyWebhook.mockResolvedValue(verified);

      const body = Buffer.from('{"event":"participant_joined"}');
      await expect(service.verify(body, 'Bearer jwt')).resolves.toBe(verified);
      expect(livekit.verifyWebhook).toHaveBeenCalledWith(body, 'Bearer jwt');
    });

    it('rejectUnverified throws a 401 with the module\'s own code, and nothing else', async () => {
      const { service } = build();
      expect(() => service.rejectUnverified()).toThrow(UnauthorizedException);
      try {
        service.rejectUnverified();
      } catch (error) {
        expect((error as UnauthorizedException).getResponse()).toMatchObject({
          code: VIDEO_ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
        });
      }
    });
  });

  describe('the room is the only link to a consultation', () => {
    it.each([
      ['a room from another application', 'standup-2026'],
      ['a room name that is not ours at all', 'consult-not-a-uuid'],
      ['no room at all', null],
    ])('ignores %s, and answers 2xx', async (_label, roomName) => {
      const { service, repo, video } = build();

      const result = await service.handle(delivery({ roomName }));

      expect(result).toEqual({ received: true, handled: false, outcome: 'ignored' });
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
      expect(video.markCallStarted).not.toHaveBeenCalled();
    });
  });

  describe('participant_joined', () => {
    it('records the connection with LiveKit\'s own join time, then starts the call', async () => {
      const { service, repo, video, audit } = build();

      const result = await service.handle(delivery());

      expect(result.outcome).toBe('processed');
      expect(repo.insertConnectionIfNew).toHaveBeenCalledWith({
        livekitParticipantSid: 'PA_abcdef',
        consultationId: CONSULTATION_ID,
        party: 'patient',
        joinedAt: new Date('2026-09-04T10:00:05.000Z'),
      });
      expect(video.markCallStarted).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(audit.write).toHaveBeenCalledTimes(1);
    });

    it('falls back to the receipt time when LiveKit sent no join time', async () => {
      const { service, repo } = build();
      const receivedAt = new Date('2026-09-04T10:01:00.000Z');

      await service.handle(
        delivery({ participant: { sid: 'PA_x', identity: `doctor:${DOCTOR_ID}`, joinedAt: null, disconnectReason: null } }),
        receivedAt,
      );

      expect(repo.insertConnectionIfNew).toHaveBeenCalledWith(expect.objectContaining({ joinedAt: receivedAt }));
    });

    it('*** TREATS A REDELIVERY AS A DUPLICATE: no audit row, no second status move ***', async () => {
      const { service, video, audit } = build({ inserted: false });

      const result = await service.handle(delivery());

      expect(result).toEqual({ received: true, handled: false, outcome: 'duplicate' });
      expect(audit.write).not.toHaveBeenCalled();
      expect(video.markCallStarted).not.toHaveBeenCalled();
    });

    it('records a DOCTOR joining as `party: doctor`', async () => {
      const { service, repo } = build();

      await service.handle(delivery({ participant: { sid: 'PA_d', identity: `doctor:${DOCTOR_ID}`, joinedAt: null, disconnectReason: null } }));

      expect(repo.insertConnectionIfNew).toHaveBeenCalledWith(expect.objectContaining({ party: 'doctor' }));
    });
  });

  describe('*** THE IDENTITY IS RE-CHECKED AGAINST THE BOOKING ***', () => {
    it('records NOTHING for an identity naming an account that is not on the consultation', async () => {
      // The signature proves LiveKit sent it. It does NOT prove this platform
      // minted the token: one LiveKit project can serve more than one
      // application, and a room name is guessable from a consultation id.
      const { service, repo, video } = build();

      const result = await service.handle(
        delivery({ participant: { sid: 'PA_evil', identity: `patient:${OTHER_PATIENT_ID}`, joinedAt: null, disconnectReason: null } }),
      );

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
      expect(video.markCallStarted).not.toHaveBeenCalled();
    });

    it('records NOTHING when the claimed side and the booking\'s side are swapped', async () => {
      // `doctor:<the patient's id>` — a well-formed identity that is a lie.
      const { service, repo } = build();

      const result = await service.handle(
        delivery({ participant: { sid: 'PA_swap', identity: `doctor:${PATIENT_ID}`, joinedAt: null, disconnectReason: null } }),
      );

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
    });

    it('records NOTHING for a doctor identity on a consultation with no doctor assigned', async () => {
      const { service, repo } = build({ booking: bookingView({ doctorId: null }) });

      const result = await service.handle(
        delivery({ participant: { sid: 'PA_none', identity: `doctor:${DOCTOR_ID}`, joinedAt: null, disconnectReason: null } }),
      );

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
    });

    it.each([
      ['an unparseable identity', 'not-an-identity'],
      ['a party the CHECK constraint forbids', `admin:${PATIENT_ID}`],
    ])('records NOTHING for %s', async (_label, identity) => {
      const { service, repo } = build();

      const result = await service.handle(
        delivery({ participant: { sid: 'PA_bad', identity, joinedAt: null, disconnectReason: null } }),
      );

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
    });

    it('records NOTHING when the named consultation does not exist', async () => {
      const { service, repo } = build({ booking: null });

      const result = await service.handle(delivery());

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
    });

    it('records NOTHING when the event carried no participant', async () => {
      const { service, repo } = build();

      const result = await service.handle(delivery({ participant: null }));

      expect(result.outcome).toBe('ignored');
      expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
    });
  });

  describe('participant_left', () => {
    it('closes the connection with the receipt time and the reason VERBATIM', async () => {
      const { service, repo } = build();
      const receivedAt = new Date('2026-09-04T10:30:00.000Z');

      const result = await service.handle(
        delivery({
          event: 'participant_left',
          participant: {
            sid: 'PA_abcdef',
            identity: `patient:${PATIENT_ID}`,
            joinedAt: new Date('2026-09-04T10:00:05.000Z'),
            disconnectReason: 'CLIENT_INITIATED',
          },
        }),
        receivedAt,
      );

      expect(result.outcome).toBe('processed');
      expect(repo.closeConnection).toHaveBeenCalledWith({
        livekitParticipantSid: 'PA_abcdef',
        consultationId: CONSULTATION_ID,
        party: 'patient',
        joinedAt: new Date('2026-09-04T10:00:05.000Z'),
        leftAt: receivedAt,
        disconnectReason: 'CLIENT_INITIATED',
      });
    });

    it('*** DOES NOT END THE CONSULTATION — one participant leaving is a reconnect as often as a goodbye ***', async () => {
      const { service, video } = build();

      await service.handle(delivery({ event: 'participant_left' }));

      expect(video.endSession).not.toHaveBeenCalled();
    });

    /**
     * *** A LEAVE THAT OVERTOOK ITS OWN JOIN ALSO HAS TO START THE CALL. ***
     *
     * `closeConnection` is an upsert precisely so this delivery is not lost —
     * but the row was only half the job. The status move lived exclusively on
     * the `participant_joined` path, and that path then saw its own late
     * redelivery as a `duplicate` and did nothing. So a consultation whose
     * join deliveries lost the race stayed `scheduled` for ever: never
     * `in_progress`, the doctor never taken out of the routing pool, and the
     * `room_finished` that followed refused (`awaiting_documentation` is legal
     * only from `in_progress`) — a call with connection rows to prove it
     * happened and a status machine that never noticed.
     */
    it('*** STARTS THE CALL when the leave had to CREATE the row — the join was never seen ***', async () => {
      const { service, video } = build({ known: undefined });

      await service.handle(
        delivery({ event: 'participant_left', participant: { ...delivery().participant!, sid: 'PA_ooo' } }),
      );

      expect(video.markCallStarted).toHaveBeenCalledWith(CONSULTATION_ID);
    });

    it('does NOT re-start the call when the leave is closing a join we already recorded', async () => {
      const { service, video } = build({ known: { livekitParticipantSid: 'PA_abcdef' } });

      await service.handle(delivery({ event: 'participant_left' }));

      expect(video.markCallStarted).not.toHaveBeenCalled();
    });

    it('treats a redelivery as a duplicate and does not re-audit', async () => {
      const { service, audit } = build({ closed: false });

      const result = await service.handle(delivery({ event: 'participant_left' }));

      expect(result).toEqual({ received: true, handled: false, outcome: 'duplicate' });
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('room_finished', () => {
    it('*** ENDS THE CONSULTATION *** through the same path the doctor\'s End button uses', async () => {
      const { service, video } = build();

      const result = await service.handle(delivery({ event: 'room_finished', participant: null }));

      expect(video.endSession).toHaveBeenCalledWith(CONSULTATION_ID, 'video_room_finished');
      expect(result).toEqual({ received: true, handled: true, outcome: 'processed' });
    });

    it('reports a refused end as a duplicate and still answers 2xx — an empty room is a NO-SHOW, not this webhook\'s call', async () => {
      const { service, video } = build();
      video.endSession.mockResolvedValue({
        consultationId: CONSULTATION_ID,
        changed: false,
        status: 'scheduled',
        refusal: 'illegal_transition',
      });

      const result = await service.handle(delivery({ event: 'room_finished', participant: null }));

      expect(result).toEqual({ received: true, handled: false, outcome: 'duplicate' });
    });
  });

  describe('always 2xx once verified', () => {
    it.each(['room_started', 'track_published', 'egress_ended', ''])(
      'records and ignores the unhandled event %p',
      async (event) => {
        const { service, repo, video } = build();

        const result = await service.handle(delivery({ event }));

        expect(result.outcome).toBe('ignored');
        expect(repo.insertConnectionIfNew).not.toHaveBeenCalled();
        expect(video.endSession).not.toHaveBeenCalled();
      },
    );

    it('*** ANSWERS 2xx EVEN WHEN THE HANDLER THROWS *** — a retry storm helps nobody', async () => {
      const { service, repo } = build();
      repo.insertConnectionIfNew.mockRejectedValue(new Error('the database is down'));

      await expect(service.handle(delivery())).resolves.toEqual({
        received: true,
        handled: false,
        outcome: 'failed',
      });
    });

    it('answers 2xx when the status move throws after the row was written', async () => {
      const { service, video } = build();
      video.markCallStarted.mockRejectedValue(new Error('booking unreachable'));

      await expect(service.handle(delivery())).resolves.toMatchObject({ outcome: 'failed' });
    });
  });
});
