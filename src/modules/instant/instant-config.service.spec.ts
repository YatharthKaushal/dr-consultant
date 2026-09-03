import { BadRequestException } from '@nestjs/common';
import { InstantConfigService } from './instant-config.service';
import {
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_CONFIG_BOUNDS,
  INSTANT_CONFIG_FALLBACKS,
  INSTANT_CONFIG_KEYS,
  INSTANT_ERROR_CODES,
} from './instant.constants';

/**
 * Unit tests for the `instant.*` `app_config` keys — one reserved by
 * `docs/erd.sql` and never declared until now, one genuinely new.
 * `new Service(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 *
 * The three things a bare config write does not do, and which
 * `payment-config.service.ts` established the pattern for: key ownership,
 * shape validation against untyped jsonb, and audit + cache invalidation.
 */

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

type Fn = jest.Mock;

function buildHarness(stored: Map<string, unknown> = new Map()) {
  const repo: Record<string, Fn> = {
    findConfigByKeys: jest.fn(async () => stored),
    upsertConfig: jest.fn(async () => undefined),
  };

  const appConfig: Record<string, Fn> = {
    getNumber: jest.fn(async (key: string, fallback: number) => (stored.has(key) ? (stored.get(key) as number) : fallback)),
    invalidate: jest.fn(),
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const service = new InstantConfigService(repo as never, appConfig as never, audit as never);
  return { service, repo, appConfig, audit };
}

describe('InstantConfigService', () => {
  describe('reads', () => {
    it('falls back to the compiled-in defaults when nothing is seeded', async () => {
      const { service } = buildHarness();

      await expect(service.getAcceptanceWindowSeconds()).resolves.toBe(
        INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
      );
      await expect(service.getPaymentWindowSeconds()).resolves.toBe(INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS);
    });

    it('reads the hot path through AppConfigService, which memoizes it — not through a fresh query per routing decision', async () => {
      const { service, appConfig, repo } = buildHarness();

      await service.getAcceptanceWindowSeconds();

      expect(appConfig.getNumber).toHaveBeenCalledWith(
        INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS,
        INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
      );
      expect(repo.findConfigByKeys).not.toHaveBeenCalled();
    });

    it('serves an admin-tuned value', async () => {
      const { service } = buildHarness(new Map([[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, 45]]));
      await expect(service.getAcceptanceWindowSeconds()).resolves.toBe(45);
    });

    it.each([
      ['a string', 'sixty'],
      ['a fraction of a second', 30.5],
      ['below the floor', 1],
      ['above the ceiling', 999_999],
      ['NaN', Number.NaN],
      ['null', null],
    ])('degrades %s to the documented default rather than routing on nonsense', async (_label, value) => {
      const { service } = buildHarness(new Map([[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, value]]));

      // Refusing every instant request because one config row is malformed
      // would be a self-inflicted outage.
      await expect(service.getAcceptanceWindowSeconds()).resolves.toBe(
        INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
      );
    });

    it('getResolved reads the whole set in ONE query, not one per key', async () => {
      const { service, repo } = buildHarness(
        new Map<string, unknown>([
          [INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, 90],
          [INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS, 600],
        ]),
      );

      await expect(service.getResolved()).resolves.toEqual({ acceptanceWindowSeconds: 90, paymentWindowSeconds: 600 });
      expect(repo.findConfigByKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('writes, INVALIDATES THE MEMO, and audits before/after', async () => {
      const { service, repo, appConfig, audit } = buildHarness(
        new Map<string, unknown>([[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, 60]]),
      );

      await service.update(ADMIN_ID, { acceptanceWindowSeconds: 90 });

      expect(repo.upsertConfig).toHaveBeenCalledWith(INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, 90);
      // Without this the 30s memo keeps routing on the previous window, and an
      // operator correcting it mid-incident would watch nothing happen.
      expect(appConfig.invalidate).toHaveBeenCalledWith(INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          entityType: INSTANT_AUDIT_ENTITY_TYPES.CONFIG,
          // The key IS the entity — an auditor asking who widened the window
          // should not have to know a uuid.
          entityId: INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS,
          metadata: { before: 60, after: 90 },
        }),
      );
    });

    it('writes only the fields present in the body', async () => {
      const { service, repo } = buildHarness();

      await service.update(ADMIN_ID, { paymentWindowSeconds: 420 });

      expect(repo.upsertConfig).toHaveBeenCalledTimes(1);
      expect(repo.upsertConfig).toHaveBeenCalledWith(INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS, 420);
    });

    it('a no-op call writes nothing and audits nothing — no misleading entry for a change that did not happen', async () => {
      const { service, repo, audit, appConfig } = buildHarness();

      await service.update(ADMIN_ID, {});

      expect(repo.upsertConfig).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
      expect(appConfig.invalidate).not.toHaveBeenCalled();
    });

    it('records a null `before` for a key that had no row yet', async () => {
      const { service, audit } = buildHarness();

      await service.update(ADMIN_ID, { acceptanceWindowSeconds: 90 });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { before: null, after: 90 } }),
      );
    });

    describe('shape validation — `app_config.value` is untyped jsonb, so nothing else catches this', () => {
      it.each([
        ['a non-number', 'sixty' as unknown as number],
        ['a fraction of a second', 30.5],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['below the floor', INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS].min - 1],
        ['above the ceiling', INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS].max + 1],
      ])('refuses %s with CONFIG_INVALID and writes nothing', async (_label, value) => {
        const { service, repo, audit } = buildHarness();

        await expect(service.update(ADMIN_ID, { acceptanceWindowSeconds: value })).rejects.toMatchObject({
          response: { code: INSTANT_ERROR_CODES.CONFIG_INVALID },
        });
        expect(repo.upsertConfig).not.toHaveBeenCalled();
        expect(audit.write).not.toHaveBeenCalled();
      });

      it('validates EVERY field before writing ANY — a bad second value must not leave the first one written', async () => {
        const { service, repo } = buildHarness();

        await expect(
          service.update(ADMIN_ID, { acceptanceWindowSeconds: 90, paymentWindowSeconds: -1 }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(repo.upsertConfig).not.toHaveBeenCalled();
      });

      it('accepts the documented bounds themselves', async () => {
        const { service } = buildHarness();
        const acceptance = INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS];
        const payment = INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS];

        await expect(
          service.update(ADMIN_ID, { acceptanceWindowSeconds: acceptance.min, paymentWindowSeconds: payment.max }),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('key ownership', () => {
    it('owns exactly the two `instant.*` keys and nothing else', () => {
      expect(Object.values(INSTANT_CONFIG_KEYS)).toEqual([
        'instant.acceptance_window_seconds',
        'instant.payment_window_seconds',
      ]);
      // One shared `app_config` table must not become one shared permission:
      // an admin holding `appointments.manage` must not be able to reach
      // `search.crisis_keywords` or `payments.gst_rate` through this service.
      for (const key of Object.values(INSTANT_CONFIG_KEYS)) expect(key.startsWith('instant.')).toBe(true);
    });

    it('reads and writes only its own keys', async () => {
      const { service, repo } = buildHarness();

      await service.getResolved();
      await service.update(ADMIN_ID, { acceptanceWindowSeconds: 90, paymentWindowSeconds: 600 });

      const readKeys = repo.findConfigByKeys.mock.calls.flatMap((call: unknown[]) => call[0] as string[]);
      const writtenKeys = repo.upsertConfig.mock.calls.map((call: unknown[]) => call[0] as string);
      for (const key of [...readKeys, ...writtenKeys]) expect(key.startsWith('instant.')).toBe(true);
    });
  });

  describe('the two windows are not the same trade', () => {
    it('the payment window default is SHORTER than M-11s 20-minute slot hold — it holds a live doctor, not a slot', () => {
      // booking.constants.ts sets SLOT_HOLD_MINUTES to 20 deliberately LONGER
      // than the gateway's checkout window, so a slot is never lost. Doing
      // that here would hold a doctor idle for twenty minutes while one
      // patient decides.
      expect(INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS).toBeLessThan(20 * 60);
    });

    it('a doctor is never asked to wait longer to be paid for than they were given to accept', () => {
      expect(INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS).toBeGreaterThan(
        INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
      );
    });

    it('every default sits inside its own bounds', () => {
      const acceptance = INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS];
      const payment = INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS];

      expect(INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS).toBeGreaterThanOrEqual(acceptance.min);
      expect(INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS).toBeLessThanOrEqual(acceptance.max);
      expect(INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS).toBeGreaterThanOrEqual(payment.min);
      expect(INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS).toBeLessThanOrEqual(payment.max);
    });
  });
});
