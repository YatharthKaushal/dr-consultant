import { BadRequestException } from '@nestjs/common';
import { PromotionConfigService } from './promotion-config.service';
import {
  PROMOTION_CONFIG_FALLBACKS,
  PROMOTION_CONFIG_KEYS,
  PROMOTION_DEFAULT_QUALIFYING_STATUSES,
  PROMOTION_DEFAULT_REFERRAL_PROGRAM,
} from './promotion.constants';

/**
 * The read and write path for the seven `promotion.*` keys.
 *
 * *** TWO OF THESE VALUES ARE MORE CONSEQUENTIAL THAN THE REST, AND BOTH ARE
 * TESTED AS SUCH. ***
 *
 *   `promotion.affiliate_enabled` — the NMC-regulated switch. It must FAIL
 *   CLOSED on anything malformed: "we could not parse the config so we left it
 *   on" is not a sentence anybody should have to say about a mechanism that can
 *   get a doctor suspended.
 *
 *   `promotion.referral_qualifying_statuses` — the key that exists precisely so
 *   the qualifying status is not hard-coded to something M-15 sets. It is
 *   deliberately NOT validated against this build's enum, because refusing a
 *   status this build has not heard of would reintroduce the
 *   deploy-to-change-a-policy problem the key was created to remove.
 */
function build(stored: Record<string, unknown> = {}) {
  const repo = {
    findByKeys: jest.fn().mockImplementation(async (keys: string[]) => new Map(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const appConfig = {
    getJson: jest.fn().mockImplementation(async (key: string, fallback: unknown) => (key in stored ? stored[key] : fallback)),
    getNumber: jest.fn().mockImplementation(async (key: string, fallback: number) => {
      const value = stored[key];
      return typeof value === 'number' ? value : fallback;
    }),
    invalidate: jest.fn(),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new PromotionConfigService(repo as never, appConfig as never, audit as never);
  return { service, repo, appConfig, audit };
}

describe('PromotionConfigService', () => {
  describe('getResolved', () => {
    it('serves the compiled-in defaults when nothing has been seeded', async () => {
      const { service } = build();
      const resolved = await service.getResolved();

      expect(resolved).toMatchObject({
        affiliateEnabled: false,
        affiliateAttributionDays: 30,
        reservationGraceMinutes: 5,
        codeAttemptsPerPatientPerHour: 20,
        codeAttemptsPerIpPerHour: 60,
      });
      expect(resolved.referralQualifyingStatuses).toEqual([...PROMOTION_DEFAULT_QUALIFYING_STATUSES]);
      expect(resolved.referralProgram).toEqual(PROMOTION_DEFAULT_REFERRAL_PROGRAM);
    });

    it('*** SHIPS `affiliateEnabled: false` ***', async () => {
      const { service } = build();
      expect((await service.getResolved()).affiliateEnabled).toBe(false);
      expect(PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ENABLED).toBe(false);
    });

    it.each([
      ['a string', 'true'],
      ['a number', 1],
      ['null', null],
      ['an object', {}],
      ['undefined', undefined],
    ])('*** FAILS THE AFFILIATE SWITCH CLOSED on %s ***', async (_label, value) => {
      const { service } = build({ [PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED]: value });
      expect((await service.getResolved()).affiliateEnabled).toBe(false);
    });

    it('honours a genuine `true`, because the switch must still be usable once signed off', async () => {
      const { service } = build({ [PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED]: true });
      expect((await service.getResolved()).affiliateEnabled).toBe(true);
    });

    it('degrades a malformed programme to the compiled-in default rather than throwing', async () => {
      // Running the documented default is defensible; refusing every checkout
      // because one config row is malformed is not — and `app_config` can be
      // hand-edited during an incident, which is exactly when a hard failure is
      // least welcome.
      const { service } = build({ [PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM]: { enabled: 'yes' } });
      expect((await service.getResolved()).referralProgram).toEqual(PROMOTION_DEFAULT_REFERRAL_PROGRAM);
    });

    it('degrades an out-of-range number to its fallback', async () => {
      const { service } = build({
        [PROMOTION_CONFIG_KEYS.AFFILIATE_ATTRIBUTION_DAYS]: 100_000,
        [PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES]: -5,
      });
      const resolved = await service.getResolved();
      expect(resolved.affiliateAttributionDays).toBe(30);
      expect(resolved.reservationGraceMinutes).toBe(5);
    });

    it('accepts a qualifying status this build’s enum has never heard of', async () => {
      // The whole point of the key. An unknown status simply never matches,
      // which is inert — and refusing it would turn a config edit into a deploy.
      const { service } = build({
        [PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES]: ['some_future_status'],
      });
      expect((await service.getResolved()).referralQualifyingStatuses).toEqual(['some_future_status']);
    });

    it('degrades an empty or malformed status list to the default', async () => {
      for (const bad of [[], 'completed', [1, 2], null]) {
        const { service } = build({ [PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES]: bad });
        expect((await service.getResolved()).referralQualifyingStatuses).toEqual([
          ...PROMOTION_DEFAULT_QUALIFYING_STATUSES,
        ]);
      }
    });
  });

  describe('update', () => {
    it('writes nothing and audits nothing for a no-op call', async () => {
      // No misleading audit entry — the same discipline
      // `payment-config.service.ts` uses.
      const { service, repo, audit } = build();
      await service.update('admin-1', {});
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('*** INVALIDATES THE MEMO, or the panel would show a change that never took effect ***', async () => {
      const { service, appConfig } = build();
      await service.update('admin-1', { reservationGraceMinutes: 10 });
      expect(appConfig.invalidate).toHaveBeenCalledWith(PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES);
    });

    it('audits BEFORE and AFTER with the acting admin', async () => {
      const { service, audit } = build({ [PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES]: 5 });
      await service.update('admin-1', { reservationGraceMinutes: 10 });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          entityType: 'promotion_config',
          // The KEY is the entity — an auditor asking who changed a value should
          // not have to know a uuid.
          entityId: PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES,
          metadata: { before: 5, after: 10 },
        }),
      );
    });

    it('*** FLAGS THE AFFILIATE SWITCH IN THE AUDIT ROW, naming the regulation ***', async () => {
      // So the one audit entry that matters most is findable by predicate rather
      // than by reading every config change.
      const { service, audit } = build();
      await service.update('admin-1', { affiliateEnabled: true });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED,
          metadata: expect.objectContaining({
            after: true,
            legalSignOffRequired: true,
            regulation: expect.stringContaining('NMC'),
          }),
        }),
      );
    });

    it('does NOT flag an unrelated key', async () => {
      const { service, audit } = build();
      await service.update('admin-1', { codeAttemptsPerIpPerHour: 100 });
      const metadata = (audit.write.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;
      expect(metadata).not.toHaveProperty('legalSignOffRequired');
    });

    describe('validation — where the message can name the field', () => {
      it('refuses a non-boolean affiliate switch', async () => {
        const { service } = build();
        await expect(service.update('a', { affiliateEnabled: 'yes' as never })).rejects.toThrow(BadRequestException);
      });

      it('refuses an out-of-range number', async () => {
        const { service } = build();
        await expect(service.update('a', { affiliateAttributionDays: 0 })).rejects.toThrow(/between 1 and 365/);
        await expect(service.update('a', { affiliateAttributionDays: 1.5 })).rejects.toThrow(/whole number/);
      });

      it('refuses an empty qualifying-status list', async () => {
        const { service } = build();
        await expect(service.update('a', { referralQualifyingStatuses: [] })).rejects.toThrow(/non-empty array/);
      });

      it('*** REFUSES A PERCENTAGE REWARD WITH NO CAP, at the edit rather than in a sweep ***', async () => {
        // `discount_instruments_value_check` refuses an uncapped percentage
        // instrument. If this shape were accepted here, nothing would break
        // until a referral qualified — inside a sweep, hours later, surfacing as
        // a constraint violation nobody can connect back to a config edit.
        const { service } = build();
        await expect(
          service.update('a', {
            referralProgram: {
              ...PROMOTION_DEFAULT_REFERRAL_PROGRAM,
              referrerReward: {
                ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward,
                valueKind: 'percent',
                flatAmount: null,
                percentRate: '10',
                maxDiscountAmount: null,
              },
            },
          }),
        ).rejects.toThrow(/maxDiscountAmount is REQUIRED/);
      });

      it('accepts a percentage reward once a cap is given', async () => {
        const { service, repo } = build();
        await service.update('a', {
          referralProgram: {
            ...PROMOTION_DEFAULT_REFERRAL_PROGRAM,
            referrerReward: {
              ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward,
              valueKind: 'percent',
              flatAmount: null,
              percentRate: '10',
              maxDiscountAmount: '200.00',
            },
          },
        });
        expect(repo.upsert).toHaveBeenCalled();
      });

      it('refuses a money field that money.util.ts would not parse', async () => {
        const { service } = build();
        await expect(
          service.update('a', {
            referralProgram: {
              ...PROMOTION_DEFAULT_REFERRAL_PROGRAM,
              referrerReward: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward, flatAmount: '100.005' },
            },
          }),
        ).rejects.toThrow(/flatAmount/);
      });

      it('refuses a negative or zero per-referrer cap, but allows null for unlimited', async () => {
        const { service, repo } = build();
        await expect(
          service.update('a', { referralProgram: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, maxQualifiedReferralsPerReferrer: 0 } }),
        ).rejects.toThrow(/positive whole number/);

        await service.update('a', {
          referralProgram: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, maxQualifiedReferralsPerReferrer: null },
        });
        expect(repo.upsert).toHaveBeenCalled();
      });

      it('refuses a programme that is not an object at all', async () => {
        const { service } = build();
        await expect(service.update('a', { referralProgram: 'nope' as never })).rejects.toThrow(/must be an object/);
      });
    });
  });
});
