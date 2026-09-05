import { NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getEnv, resetEnvCache } from '../../config/env/env.validation';
import { LivekitClient } from './livekit.client';
import { VideoTestKitController } from './video-test-kit.controller';

/** `getPage` sends via `@Res()` directly (see the controller's own header) rather than returning a value, so it needs a reply double to call. */
function mockReply(): FastifyReply & { body: unknown; contentType: unknown } {
  const reply = {
    body: undefined as unknown,
    contentType: undefined as unknown,
    header(name: string, value: unknown) {
      if (name.toLowerCase() === 'content-type') reply.contentType = value;
      return reply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { body: unknown; contentType: unknown };
}

/**
 * Same construction style as `video.secret-leak.spec.ts`: a real
 * `LivekitClient` (so a real token gets minted) built directly, no
 * `Test.createTestingModule`.
 *
 * Two things this file exists to prove:
 *   1. `VIDEO_TEST_KIT_ENABLED=false` (the default) makes every route on
 *      this controller behave as if it does not exist — a 404, not a 403.
 *   2. When the flag is on, the token route mints a real, narrowly-scoped
 *      token for a room that `video-room.util.ts#consultationIdFromRoomName`
 *      cannot parse back to a consultation id — so a webhook for it is inert.
 */
describe('VideoTestKitController', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    resetEnvCache();
  });

  function build(): VideoTestKitController {
    return new VideoTestKitController(new LivekitClient());
  }

  describe('flag off (the default)', () => {
    beforeEach(() => {
      delete process.env.VIDEO_TEST_KIT_ENABLED;
      resetEnvCache();
      expect(getEnv().VIDEO_TEST_KIT_ENABLED).toBe(false);
    });

    it('404s the page', () => {
      expect(() => build().getPage(mockReply())).toThrow(NotFoundException);
    });

    it('404s the token route', async () => {
      await expect(build().issueTestToken({ role: 'patient' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('flag on', () => {
    beforeEach(() => {
      process.env.VIDEO_TEST_KIT_ENABLED = 'true';
      resetEnvCache();
      expect(getEnv().VIDEO_TEST_KIT_ENABLED).toBe(true);
    });

    it('serves the html page', () => {
      const reply = mockReply();
      build().getPage(reply);
      expect(reply.contentType).toBe('text/html; charset=utf-8');
      expect(reply.body).toContain('<title>LiveKit Test Kit</title>');
      expect(reply.body).toContain('/api/video/test-kit/token');
    });

    it('mints a token for each role, in a room a real webhook cannot resolve to a consultation', async () => {
      const controller = build();

      const patient = await controller.issueTestToken({ role: 'patient', room: 'demo' });
      expect(patient.room).toBe('testkit-demo');
      expect(patient.identity.startsWith('patient-')).toBe(true);
      expect(patient.serverUrl).toBe(getEnv().LIVEKIT_URL);
      expect(patient.token.length).toBeGreaterThan(0);

      const doctor = await controller.issueTestToken({ role: 'doctor', room: 'demo' });
      expect(doctor.room).toBe(patient.room);
      expect(doctor.identity.startsWith('doctor-')).toBe(true);
      // Two different connections, never the same identity.
      expect(doctor.identity).not.toBe(patient.identity);
    });

    it('defaults the room when none is given, still outside the real consult- namespace', async () => {
      const { room } = await build().issueTestToken({ role: 'patient' });
      expect(room).toBe('testkit-default');
    });

    it('never leaks LIVEKIT_API_SECRET into the token response', async () => {
      const secret = getEnv().LIVEKIT_API_SECRET;
      const response = await build().issueTestToken({ role: 'doctor', room: 'leak-check' });
      expect(JSON.stringify(response)).not.toContain(secret);
    });
  });
});
