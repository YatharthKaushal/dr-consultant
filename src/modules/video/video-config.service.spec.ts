import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  VIDEO_CONFIG_FALLBACKS,
  VIDEO_CONFIG_KEYS,
  VIDEO_ERROR_CODES,
} from './video.constants';
import { VideoConfigService } from './video-config.service';

/**
 * The two `video.*` keys `docs/erd.sql` reserves, their bounds, and the audited
 * write path.
 *
 * The TTL is not an ordinary setting: it bounds how long a leaked join token
 * admits somebody to a clinical conversation. So the tests below are as much
 * about what a bad write CANNOT do as about what a good one does.
 */

const ADMIN_ID = randomUUID();

function build(stored: Record<string, unknown> = {}) {
  const repo = {
    findConfigByKeys: jest.fn(async (keys: readonly string[]) => {
      const map = new Map<string, unknown>();
      for (const key of keys) if (key in stored) map.set(key, stored[key]);
      return map;
    }),
    upsertConfig: jest.fn(async (key: string, value: unknown) => {
      stored[key] = value;
    }),
  };
  const appConfig = {
    getNumber: jest.fn(async (key: string, fallback: number) =>
      typeof stored[key] === 'number' ? (stored[key] as number) : fallback,
    ),
    invalidate: jest.fn(),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new VideoConfigService(repo as never, appConfig as never, audit as never),
    repo,
    appConfig,
    audit,
    stored,
  };
}

describe('VideoConfigService', () => {
  describe('reads', () => {
    it('serves the compiled-in fallbacks when nothing is stored', async () => {
      const { service } = build();

      await expect(service.getResolved()).resolves.toEqual({
        joinTokenTtlSeconds: VIDEO_CONFIG_FALLBACKS.JOIN_TOKEN_TTL_SECONDS,
        joinWindowMinutes: VIDEO_CONFIG_FALLBACKS.JOIN_WINDOW_MINUTES,
      });
    });

    it('serves a stored value', async () => {
      const { service } = build({
        [VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS]: 900,
        [VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES]: 30,
      });

      await expect(service.getResolved()).resolves.toEqual({ joinTokenTtlSeconds: 900, joinWindowMinutes: 30 });
      await expect(service.getJoinTokenTtlSeconds()).resolves.toBe(900);
      await expect(service.getJoinWindowMinutes()).resolves.toBe(30);
    });

    it.each([
      ['a string', 'five minutes'],
      ['a negative number', -5],
      ['a fraction', 30.5],
      ['null', null],
      ['an object', { seconds: 300 }],
      ['*** an absurdly long TTL — thirty years of standing admission ***', 1e9],
    ])('*** FALLS BACK TO THE DEFAULT, NEVER WIDENS, on %s ***', async (_label, value) => {
      const { service } = build({ [VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS]: value });

      // Falling back is both the AVAILABLE choice and the SECURE one here:
      // every value the bounds reject is one that would have made the token
      // live longer than the bound allows.
      await expect(service.getJoinTokenTtlSeconds()).resolves.toBe(
        VIDEO_CONFIG_FALLBACKS.JOIN_TOKEN_TTL_SECONDS,
      );
    });

    it('accepts a join window of zero — "no early joining" is a legitimate policy', async () => {
      const { service } = build({ [VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES]: 0 });
      await expect(service.getJoinWindowMinutes()).resolves.toBe(0);
    });
  });

  describe('writes', () => {
    it('writes, invalidates the memo, and audits with before/after', async () => {
      const { service, repo, appConfig, audit } = build({
        [VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS]: 300,
      });

      await service.update(ADMIN_ID, { joinTokenTtlSeconds: 600 });

      expect(repo.upsertConfig).toHaveBeenCalledWith(VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS, 600);
      // *** Without this the 30s memo keeps minting on the previous TTL. ***
      expect(appConfig.invalidate).toHaveBeenCalledWith(VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: 'video_config',
          entityId: VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS,
          metadata: { before: 300, after: 600 },
        }),
      );
    });

    it('records `before: null` for a key that had no row', async () => {
      const { service, audit } = build();

      await service.update(ADMIN_ID, { joinWindowMinutes: 20 });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { before: null, after: 20 } }),
      );
    });

    it('writes only the fields present, leaving the other key untouched', async () => {
      const { service, repo } = build();

      await service.update(ADMIN_ID, { joinWindowMinutes: 20 });

      expect(repo.upsertConfig).toHaveBeenCalledTimes(1);
      expect(repo.upsertConfig).toHaveBeenCalledWith(VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES, 20);
    });

    it('an empty update writes nothing and audits nothing — no misleading audit entry', async () => {
      const { service, repo, audit } = build();

      await service.update(ADMIN_ID, {});

      expect(repo.upsertConfig).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it.each([
      ['below the minimum', { joinTokenTtlSeconds: 30 }],
      ['above the maximum', { joinTokenTtlSeconds: 86_400 }],
      ['a fraction', { joinTokenTtlSeconds: 300.5 }],
      ['a window past the maximum', { joinWindowMinutes: 1440 }],
      ['a negative window', { joinWindowMinutes: -1 }],
    ])('*** REFUSES %s, and writes nothing ***', async (_label, update) => {
      const { service, repo, audit } = build();

      await expect(service.update(ADMIN_ID, update)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertConfig).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('refuses a non-numeric value the DTO would have caught, because the service holds the rule too', async () => {
      const { service } = build();

      await expect(
        service.update(ADMIN_ID, { joinTokenTtlSeconds: '600' as unknown as number }),
      ).rejects.toMatchObject({ response: { code: VIDEO_ERROR_CODES.CONFIG_INVALID } });
    });

    it('*** VALIDATES BOTH FIELDS BEFORE WRITING EITHER, so a half-valid body writes nothing ***', async () => {
      const { service, repo } = build();

      await expect(
        service.update(ADMIN_ID, { joinWindowMinutes: 20, joinTokenTtlSeconds: 999_999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertConfig).not.toHaveBeenCalled();
    });
  });
});
