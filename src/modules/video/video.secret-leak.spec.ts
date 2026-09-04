import { randomUUID } from 'node:crypto';
import type { BookingView } from '../booking/booking.contract';
import type { AuthContext } from '../../shared/auth/auth.types';
import { getEnv, resetEnvCache } from '../../config/env/env.validation';
import { LivekitClient } from './livekit.client';
import { UnavailableConsentProvider } from './unavailable-consent.provider';
import { VideoAdminController } from './video-admin.controller';
import { VideoConfigService } from './video-config.service';
import { VideoController } from './video.controller';
import { VideoFacade } from './video.facade';
import { VideoService } from './video.service';
import { VideoWebhookService } from './video-webhook.service';

/**
 * *** `LIVEKIT_API_SECRET` MUST APPEAR IN NO RESPONSE, NO LOG LINE AND NO TOKEN
 * PAYLOAD. ***
 *
 * `env.validation.ts` states the rule and the reason: "It is the only thing
 * standing between the video routes and an attacker minting themselves a token
 * into any consultation's room, exactly as `RAZORPAY_WEBHOOK_SECRET` is for the
 * payment webhook."
 *
 * A rule like that decays quietly. Somebody adds a debugging field to a view, a
 * `catch` block interpolates an SDK error that happened to embed a credential,
 * or a client is asked to return "its configuration" and returns all of it. So
 * this spec does the crude, reliable thing:
 *
 *   1. It sets a DISTINCTIVE, LIVE-SHAPED secret into the environment and
 *      forces `getEnv()` to re-read it, so `LivekitClient` genuinely holds that
 *      exact string.
 *   2. It drives EVERY response this module can produce — the join ticket, the
 *      session view, the consultation room, both config views, the client
 *      config, the webhook result, and every error body — through
 *      `JSON.stringify` and greps the text.
 *   3. It does the same to every LOGGER call and to the MINTED JWT's own header
 *      and payload, because a token is signed WITH the secret and must never
 *      carry it.
 *
 * It also checks the negative control: the API KEY and the server URL are
 * expected to travel (the client needs both), so a test that simply asserted
 * "no env value appears anywhere" would be asserting the wrong thing and would
 * fail for the right reasons.
 */

const LIVE_SECRET = 'lk_secret_JQ4mZv8xR2pT7nWy0aB3cD6eF9gH1iK5';
const LIVE_KEY = 'APIlivekitkeyfortest';
const LIVE_URL = 'wss://livekit.secret-leak.invalid';

const PATIENT_ID = randomUUID();
const DOCTOR_ID = randomUUID();
const CONSULTATION_ID = randomUUID();

const asPatient: AuthContext = { accountType: 'patient', accountId: PATIENT_ID };
const asDoctor: AuthContext = { accountType: 'doctor', accountId: DOCTOR_ID };
const asAdmin: AuthContext = { accountType: 'admin', accountId: randomUUID() };

function bookingView(): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-LEAK-0001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: randomUUID(),
    concernId: null,
    mode: 'scheduled',
    status: 'scheduled',
    scheduledStartAt: new Date(Date.now() - 60_000),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

/**
 * Everything a caller could ever be handed, flattened to text.
 *
 * `JSON.stringify` drops `undefined` and functions, which is exactly what the
 * HTTP layer does too — so what this string contains is what a client can see.
 * A thrown Nest exception contributes its response BODY, which is the part the
 * error filter serialises.
 */
function serialise(value: unknown): string {
  if (value instanceof Error) {
    const body = (value as { getResponse?: () => unknown }).getResponse?.();
    return `${value.message}|${JSON.stringify(body ?? null)}|${value.stack ?? ''}`;
  }
  return JSON.stringify(value ?? null);
}

async function collect(promise: Promise<unknown>): Promise<string> {
  try {
    return serialise(await promise);
  } catch (error) {
    return serialise(error);
  }
}

describe('LIVEKIT_API_SECRET never escapes', () => {
  const previousEnv = { ...process.env };
  /** Every line any logger in this module wrote during the run. */
  let logged: string[] = [];

  beforeAll(() => {
    process.env.LIVEKIT_URL = LIVE_URL;
    process.env.LIVEKIT_API_KEY = LIVE_KEY;
    process.env.LIVEKIT_API_SECRET = LIVE_SECRET;
    // Force `getEnv()` to re-read, so `LivekitClient` really does hold the
    // secret above rather than whatever `.env.local` carries.
    resetEnvCache();
    expect(getEnv().LIVEKIT_API_SECRET).toBe(LIVE_SECRET);
  });

  afterAll(() => {
    process.env = previousEnv;
    resetEnvCache();
  });

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(require('@nestjs/common').Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map((arg) => serialise(arg)).join(' '));
        });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Builds the whole module around a real `LivekitClient` — the one object that
   * actually holds the secret — with everything else mocked.
   */
  function build() {
    const livekit = new LivekitClient();

    const booking = bookingView();
    const bookings = {
      getBooking: jest.fn().mockResolvedValue(booking),
      transitionConsultationStatus: jest.fn().mockResolvedValue({ changed: true, booking }),
      listConsultationIdsBetween: jest.fn().mockResolvedValue([]),
    };
    const payments = {
      getByConsultationId: jest.fn().mockResolvedValue({ paymentId: randomUUID(), status: 'paid', paidAt: new Date() }),
    };
    const patients = { getProfileSummary: jest.fn().mockResolvedValue({ id: PATIENT_ID, fullName: 'A Patient' }) };
    const instant = { markInstantConsultEnded: jest.fn().mockResolvedValue({ changed: true, doctorId: DOCTOR_ID }) };
    const repo = {
      listConnections: jest.fn().mockResolvedValue([
        {
          livekitParticipantSid: 'PA_leaktest',
          consultationId: CONSULTATION_ID,
          party: 'patient' as const,
          joinedAt: new Date('2026-09-04T10:00:00.000Z'),
          leftAt: new Date('2026-09-04T10:20:00.000Z'),
          disconnectReason: 'CLIENT_INITIATED',
        },
      ]),
      findConfigByKeys: jest.fn().mockResolvedValue(new Map()),
      upsertConfig: jest.fn().mockResolvedValue(undefined),
      insertConnectionIfNew: jest.fn().mockResolvedValue(true),
      closeConnection: jest.fn().mockResolvedValue(true),
    };
    const appConfig = { getNumber: jest.fn(async (_key: string, fallback: number) => fallback), invalidate: jest.fn() };
    const audit = { write: jest.fn().mockResolvedValue(undefined) };

    const config = new VideoConfigService(repo as never, appConfig as never, audit as never);
    const consent = new UnavailableConsentProvider();
    const service = new VideoService(
      repo as never,
      bookings as never,
      payments as never,
      patients as never,
      instant as never,
      livekit,
      config,
      // The real null object: its refusal path is one of the error bodies below.
      consent,
      audit as never,
    );
    const webhooks = new VideoWebhookService(livekit, repo as never, service as never, bookings as never, audit as never);

    return {
      livekit,
      service,
      config,
      webhooks,
      audit,
      facade: new VideoFacade(service),
      controller: new VideoController(service, livekit),
      adminController: new VideoAdminController(config, service),
    };
  }

  it('*** appears in NO response this module can produce ***', async () => {
    const { service, config, controller, adminController, facade, webhooks } = build();

    const responses = await Promise.all([
      // The join ticket. Refused by the consent null object, so this is the
      // error body — and the successful shape is covered separately below with
      // a consenting port.
      collect(controller.issueToken(asPatient, CONSULTATION_ID)),
      collect(controller.getSession(asPatient, CONSULTATION_ID)),
      collect(controller.getConsultationRoom(asDoctor, CONSULTATION_ID)),
      collect(Promise.resolve(controller.getClientConfig())),
      collect(controller.endSession(asDoctor, CONSULTATION_ID)),
      collect(Promise.resolve(adminController.getConfig())),
      collect(adminController.updateConfig(asAdmin, { joinTokenTtlSeconds: 600 })),
      collect(adminController.getSession(CONSULTATION_ID)),
      collect(facade.getSession(CONSULTATION_ID)),
      collect(service.getSession(CONSULTATION_ID)),
      collect(config.getResolved()),
      // Every error body the module raises.
      collect(service.issueJoinTicket(CONSULTATION_ID, { accountType: 'patient', accountId: randomUUID() })),
      collect(service.getConsultationRoom(CONSULTATION_ID, randomUUID())),
      collect(Promise.reject(tryRejectUnverified(webhooks))),
      collect(config.update(asAdmin.accountId, { joinTokenTtlSeconds: 1 })),
      // A verification failure against a body signed with the WRONG secret —
      // the path most likely to interpolate a credential into an error.
      collect(webhooks.verify(Buffer.from('{"event":"room_started"}'), 'Bearer not.a.real.token')),
    ]);

    for (const response of responses) {
      expect(response).not.toContain(LIVE_SECRET);
    }

    // Negative control: the module's responses DO carry the things that are
    // meant to travel, so an empty grep is not what made the assertions above
    // pass.
    expect(responses.join('|')).toContain(LIVE_URL);
  });

  it('*** appears in NO log line, including the webhook-rejection and mint-failure paths ***', async () => {
    const { livekit, service, webhooks } = build();

    await webhooks.verify(Buffer.from('{"event":"room_started"}'), 'Bearer not.a.real.token');
    await webhooks.verify(Buffer.from(''), undefined);
    await livekit.mintJoinToken({ roomName: '', identity: '', displayName: '', ttlSeconds: -1 });
    await service.issueJoinTicket(CONSULTATION_ID, asPatient).catch(() => undefined);

    // The logger really was exercised — otherwise this test proves nothing.
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(LIVE_SECRET);
    }
  });

  it('*** is NOT in the minted token: a JWT is signed WITH it, never carries it ***', async () => {
    const { livekit } = build();

    const token = await livekit.mintJoinToken({
      roomName: `consult-${CONSULTATION_ID}`,
      identity: `patient:${PATIENT_ID}`,
      displayName: 'Patient',
      ttlSeconds: 300,
    });

    expect(token).not.toBeNull();
    const [header, payload, signature] = (token as string).split('.');
    const decode = (segment: string) => Buffer.from(segment, 'base64url').toString('utf8');

    expect(decode(header)).not.toContain(LIVE_SECRET);
    expect(decode(payload)).not.toContain(LIVE_SECRET);
    // The signature is binary, but check the raw base64url too — a secret
    // accidentally concatenated in would survive as text.
    expect(signature).not.toContain(LIVE_SECRET);
    expect(token).not.toContain(LIVE_SECRET);

    // Negative control: the API KEY is the `iss` claim and IS expected to be
    // there. If this stopped being true the test above would be vacuous.
    expect(decode(payload)).toContain(LIVE_KEY);
  });

  it('*** is not reachable through the client at all — there is no getter for it ***', async () => {
    const { livekit } = build();

    // The class exposes the two public values and nothing else. A future
    // `getApiSecret()` added "just for a test" fails here.
    expect(livekit.getServerUrl()).toBe(LIVE_URL);
    expect(livekit.getApiKey()).toBe(LIVE_KEY);

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(livekit));
    expect(methods).not.toContain('getApiSecret');
    expect(methods).not.toContain('getWebhookSecret');

    // And the instance does not serialise it either — a client object
    // accidentally spread into a response body would not carry it.
    expect(JSON.stringify(livekit)).not.toContain(LIVE_SECRET);
  });

  it('*** is not in a SUCCESSFUL join ticket, once consent passes ***', async () => {
    // The consent null object refuses, so the happy-path ticket needs a
    // consenting port. This is the single most important response to grep: it
    // is the only one that carries a credential at all.
    const livekit = new LivekitClient();
    const booking = bookingView();
    const service = new VideoService(
      { listConnections: jest.fn().mockResolvedValue([]) } as never,
      { getBooking: jest.fn().mockResolvedValue(booking) } as never,
      { getByConsultationId: jest.fn().mockResolvedValue({ paymentId: randomUUID(), status: 'paid', paidAt: new Date() }) } as never,
      { getProfileSummary: jest.fn() } as never,
      { markInstantConsultEnded: jest.fn() } as never,
      livekit,
      { getJoinTokenTtlSeconds: jest.fn().mockResolvedValue(300), getJoinWindowMinutes: jest.fn().mockResolvedValue(15) } as never,
      {
        checkPatientConsent: jest.fn().mockResolvedValue({
          hasCurrentConsent: true,
          acceptedVersion: '1.0',
          acceptedAt: new Date(),
          currentVersion: '1.0',
        }),
      } as never,
      { write: jest.fn() } as never,
    );

    const ticket = await service.issueJoinTicket(CONSULTATION_ID, asPatient);

    expect(ticket.token.length).toBeGreaterThan(0);
    expect(JSON.stringify(ticket)).not.toContain(LIVE_SECRET);
    // Negative control: the ticket really does carry the URL and a token.
    expect(JSON.stringify(ticket)).toContain(LIVE_URL);
  });
});

/** `rejectUnverified` is `: never`, so its throw is captured rather than called inline. */
function tryRejectUnverified(webhooks: VideoWebhookService): unknown {
  try {
    webhooks.rejectUnverified();
  } catch (error) {
    return error;
  }
  return new Error('rejectUnverified did not throw.');
}
