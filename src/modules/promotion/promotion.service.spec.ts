import { BadRequestException } from '@nestjs/common';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import type { DiscountRedemptionRow } from '../../schema/discount-redemptions.schema';
import { PromotionService } from './promotion.service';
import { PROMOTION_INDEXES } from './promotion.constants';
import type { DiscountOrderContext } from './promotion.contract';

/**
 * *** HAND-ROLLED `jest.fn()` MOCKS, `new PromotionService(...)`, NO
 * `Test.createTestingModule`. *** House convention: a service is a class with
 * constructor arguments, and testing it as one keeps the test about the RULES
 * rather than about Nest's resolution graph.
 *
 * ── WHAT THIS FILE DOES AND DOES NOT PROVE ────────────────────────────────
 *
 * It proves the DECISIONS: which refusal a given state produces, what is
 * collapsed into `CODE_NOT_USABLE`, how the throttle counts, and that a mapped
 * `23505` becomes the right refusal.
 *
 * It cannot prove the CONCURRENCY. A mocked repository returns whatever it is
 * told, so it cannot demonstrate that `SELECT ... FOR UPDATE` serialises two
 * transactions — which is exactly why
 * `promotion.redemption-race.integration.spec.ts` exists and runs against a real
 * database. The two files are complements, and neither is sufficient alone.
 */

const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '22222222-2222-4222-8222-222222222222';
const DOCTOR = '33333333-3333-4333-8333-333333333333';
const CONSULTATION = '44444444-4444-4444-8444-444444444444';

function instrument(overrides: Partial<DiscountInstrumentRow> = {}): DiscountInstrumentRow {
  return {
    id: 'inst-1',
    code: 'SAVEME',
    kind: 'coupon',
    status: 'active',
    label: 'Save me',
    description: null,
    isPubliclyListed: true,
    valueKind: 'flat',
    flatAmount: '100.00',
    percentRate: null,
    maxDiscountAmount: null,
    minOrderAmount: '0.00',
    currency: 'INR',
    validFrom: new Date('2020-01-01T00:00:00Z'),
    validTo: null,
    maxTotalRedemptions: null,
    maxDistinctRedeemers: null,
    maxRedemptionsPerUser: 1,
    assignedPatientId: null,
    referrerPatientId: null,
    affiliatePartnerId: null,
    referralEventId: null,
    referralRewardRole: null,
    createdByAdminId: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as DiscountInstrumentRow;
}

function redemption(overrides: Partial<DiscountRedemptionRow> = {}): DiscountRedemptionRow {
  return {
    id: 'red-1',
    instrumentId: 'inst-1',
    patientId: PATIENT,
    consultationId: CONSULTATION,
    paymentId: null,
    status: 'reserved',
    valueKind: 'flat',
    flatAmount: '100.00',
    percentRate: null,
    maxDiscountAmount: null,
    discountableBase: '500.00',
    discountAmount: '100.00',
    currency: 'INR',
    capturedConsultationFee: null,
    capturedConvenienceFee: null,
    affiliatePartnerId: null,
    attributionSource: null,
    enforcesSingleUsePerUser: true,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    consumedAt: null,
    releasedAt: null,
    releaseReason: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as DiscountRedemptionRow;
}

function context(overrides: Partial<DiscountOrderContext> = {}): DiscountOrderContext {
  return {
    patientId: PATIENT,
    doctorId: DOCTOR,
    specialtyId: null,
    components: [{ code: 'convenience_fee', label: 'Convenience fee', grossAmount: '500.00' }],
    discountableAmount: '500.00',
    currency: 'INR',
    mode: 'scheduled',
    ...overrides,
  };
}

const BASE_CONFIG = {
  referralProgram: {
    enabled: true,
    refereeMustBeFirstConsultation: true,
    maxQualifiedReferralsPerReferrer: null,
    referrerReward: {
      enabled: true,
      valueKind: 'flat' as const,
      flatAmount: '100.00',
      percentRate: null,
      maxDiscountAmount: null,
      minOrderAmount: '0.00',
      validityDays: 90,
      label: 'Referral reward',
    },
    refereeReward: {
      enabled: false,
      valueKind: 'flat' as const,
      flatAmount: '100.00',
      percentRate: null,
      maxDiscountAmount: null,
      minOrderAmount: '0.00',
      validityDays: 90,
      label: 'Welcome reward',
    },
  },
  referralQualifyingStatuses: ['completed'],
  affiliateEnabled: false,
  affiliateAttributionDays: 30,
  reservationGraceMinutes: 5,
  codeAttemptsPerPatientPerHour: 20,
  codeAttemptsPerIpPerHour: 60,
};

/** Builds the service with every dependency a `jest.fn()`. Each test overrides only what it is about. */
function build(overrides: {
  repo?: Record<string, jest.Mock>;
  referrals?: Record<string, jest.Mock>;
  affiliateRepo?: Record<string, jest.Mock>;
  affiliates?: Record<string, jest.Mock>;
  config?: Partial<typeof BASE_CONFIG>;
  booking?: Record<string, jest.Mock>;
  /** Makes the reservation transaction throw, to exercise the `23505` mapping. */
  transactionThrows?: unknown;
} = {}) {
  const repo = {
    findInstrumentByCode: jest.fn(),
    findInstrumentById: jest.fn(),
    findInstrumentByIdForUpdate: jest.fn(),
    findLiveRedemptionForConsultation: jest.fn(),
    findLiveRedemptionForConsultationForUpdate: jest.fn(),
    insertRedemption: jest.fn(),
    consumeRedemptionIfReserved: jest.fn(),
    releaseRedemptionIfReserved: jest.fn(),
    attachPaymentIdIfMissing: jest.fn().mockResolvedValue(0),
    countCapsUnderLock: jest.fn().mockResolvedValue({ total: 0, distinctRedeemers: 0, forPatient: 0 }),
    countLiveRedemptions: jest.fn().mockResolvedValue(0),
    countDistinctRedeemers: jest.fn().mockResolvedValue(0),
    countLiveRedemptionsForPatient: jest.fn().mockResolvedValue(0),
    recordCodeAttempt: jest.fn().mockResolvedValue(1),
    markCodeAttemptOutcome: jest.fn().mockResolvedValue(undefined),
    countRecentAttemptsByPatient: jest.fn().mockResolvedValue(0),
    countRecentAttemptsByIp: jest.fn().mockResolvedValue(0),
    listRedeemableForPatient: jest.fn().mockResolvedValue([]),
    countDataRightsRows: jest
      .fn()
      .mockResolvedValue({ discountInstruments: 0, discountRedemptions: 0, promotionCodeAttempts: 0 }),
    anonymizeCodeAttemptsForPatient: jest.fn().mockResolvedValue({ anonymizedCount: 0 }),
    ...overrides.repo,
  };

  const referrals = {
    findEventByReferee: jest.fn().mockResolvedValue(null),
    findEventByRedemption: jest.fn().mockResolvedValue(null),
    markVoidIfQualifying: jest.fn().mockResolvedValue(null),
    insertEvent: jest.fn().mockResolvedValue({ id: 'event-1' }),
    countDataRightsRows: jest.fn().mockResolvedValue({ referralEvents: 0 }),
    ...overrides.referrals,
  };

  const affiliateRepo = {
    findPartnerById: jest.fn().mockResolvedValue(null),
    findActiveAttribution: jest.fn().mockResolvedValue(null),
    countDataRightsRows: jest.fn().mockResolvedValue({ affiliateAttributions: 0, affiliateCommissions: 0 }),
    ...overrides.affiliateRepo,
  };

  const affiliates = {
    readCapturedComponents: jest.fn().mockReturnValue({ consultationFee: null, convenienceFee: null }),
    recordCommissionForRedemption: jest.fn().mockResolvedValue(null),
    voidPendingCommissionForConsultation: jest.fn().mockResolvedValue(false),
    ...overrides.affiliates,
  };

  const config = { getResolved: jest.fn().mockResolvedValue({ ...BASE_CONFIG, ...overrides.config }) };

  const booking = {
    getConsultationStatus: jest.fn().mockResolvedValue('unknown'),
    getConsultationStatuses: jest.fn().mockResolvedValue(new Map()),
    countPriorConsultations: jest.fn().mockResolvedValue('unknown'),
    ...overrides.booking,
  };

  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  // The transaction handle IS the mocked executor: repository methods here take
  // an `executor` and ignore it, so passing the same object through keeps the
  // call shapes honest without a second layer of stubs.
  const db = {
    transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (overrides.transactionThrows !== undefined) throw overrides.transactionThrows;
      return callback({});
    }),
  };

  const service = new PromotionService(
    db as never,
    repo as never,
    referrals as never,
    affiliateRepo as never,
    affiliates as never,
    config as never,
    booking as never,
    audit as never,
  );

  return { service, repo, referrals, affiliateRepo, affiliates, config, booking, audit, db };
}

describe('PromotionService', () => {
  describe('preview — the refusal collapse', () => {
    /**
     * *** THE COLLAPSE IS THE SECURITY PROPERTY, NOT A CONVENIENCE. ***
     *
     * `is_publicly_listed = false` means hidden-but-redeemable, which is exactly
     * what makes walking the code namespace worth an attacker's time. A
     * distinguishable "that code exists but has expired" is a CONFIRMED HIT.
     * Every one of these must be the same reason with the same message.
     */
    it.each([
      ['no such code', undefined],
      ['a draft campaign', instrument({ status: 'draft' })],
      ['a paused campaign', instrument({ status: 'paused' })],
      ['an archived campaign', instrument({ status: 'archived' })],
      ['one that has not started', instrument({ validFrom: new Date('2999-01-01T00:00:00Z') })],
      ['one that has expired', instrument({ validTo: new Date('2000-01-01T00:00:00Z') })],
      ['somebody else’s voucher', instrument({ kind: 'voucher', assignedPatientId: OTHER_PATIENT })],
    ])('collapses %s into one indistinguishable CODE_NOT_USABLE', async (_label, row) => {
      const { service } = build({ repo: { findInstrumentByCode: jest.fn().mockResolvedValue(row ?? null) } });
      const result = await service.preview('SAVEME', context());

      expect(result).toEqual({
        applicable: false,
        reason: 'CODE_NOT_USABLE',
        message: 'This code cannot be used on this booking.',
      });
    });

    it('collapses a code that is not even well-formed, without touching the database', async () => {
      // So the SHAPE of the response cannot teach an attacker the code format.
      const { service, repo } = build();
      const result = await service.preview('!!', context());
      expect(result).toMatchObject({ reason: 'CODE_NOT_USABLE' });
      expect(repo.findInstrumentByCode).not.toHaveBeenCalled();
    });

    it('*** MIN_ORDER_NOT_MET IS THE ONE DELIBERATE EXCEPTION, and it carries the figure ***', async () => {
      // The only refusal a patient can ACT on. It leaks nothing an attacker
      // wants, because reaching it already required a valid, live, applicable
      // code.
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument({ minOrderAmount: '1000.00' })) },
      });
      const result = await service.preview('SAVEME', context({ discountableAmount: '500.00' }));

      expect(result).toEqual({
        applicable: false,
        reason: 'MIN_ORDER_NOT_MET',
        message: 'This code needs a higher order value.',
        requiredMinOrder: '1000.00',
      });
    });

    it('quotes an applicable code with the arithmetic already done', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument()) },
      });
      const result = await service.preview('SAVEME', context());

      expect(result).toMatchObject({
        applicable: true,
        instrumentId: 'inst-1',
        kind: 'coupon',
        code: 'SAVEME',
        discountAmount: '100.00',
        residualDiscountable: '400.00',
        attributionOnly: false,
        fullyDiscounted: false,
      });
    });

    it('refuses a currency mismatch distinctly, because it is a caller bug rather than a probe', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument({ currency: 'USD' })) },
      });
      expect(await service.preview('SAVEME', context())).toMatchObject({ reason: 'CURRENCY_MISMATCH' });
    });

    it('THROWS rather than refusing when the BASE itself is malformed', async () => {
      // A malformed base is a caller bug at the pricing seam, not a state a
      // patient can do anything about. Burying it in `CODE_NOT_USABLE` would
      // make every code look broken while the real fault stayed invisible.
      const { service } = build();
      await expect(service.preview('SAVEME', context({ discountableAmount: 'not-money' }))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('the enumeration throttle', () => {
    it('*** OPENS THE ATTEMPT ROW BEFORE IT COUNTS — the ordering IS the throttle ***', async () => {
      // ══════════════════════════════════════════════════════════════════════
      // This used to count first and record afterwards, which made the throttle
      // decorative: every concurrent caller read the same pre-write total, so
      // sixty parallel `preview` calls all passed a budget of twenty and sixty
      // rows landed afterwards. Proved against a real database in
      // `promotion.redemption-race.integration.spec.ts`.
      //
      // Recording first is what bounds it: the row COMMITS on this module's own
      // connection before the count runs, so a caller whose insert is the k-th
      // to commit in the window sees at least k rows. Nothing else in this file
      // can demonstrate that, but the ORDER can be asserted here, and the order
      // is the fix.
      // ══════════════════════════════════════════════════════════════════════
      const order: string[] = [];
      const { service } = build({
        repo: {
          recordCodeAttempt: jest.fn(async () => {
            order.push('record');
            return 1;
          }),
          countRecentAttemptsByPatient: jest.fn(async () => {
            order.push('count');
            return 0;
          }),
        },
      });

      await service.preview('SAVEME', context());
      expect(order).toEqual(['record', 'count']);
    });

    it('refuses TOO_MANY_ATTEMPTS once the per-patient budget is spent', async () => {
      // 21, not 20: the count now INCLUDES this call's own just-opened row, so
      // a budget of 20 is exceeded at 21.
      const { service, repo } = build({
        repo: { countRecentAttemptsByPatient: jest.fn().mockResolvedValue(21) },
      });
      expect(await service.preview('SAVEME', context())).toMatchObject({ reason: 'TOO_MANY_ATTEMPTS' });
      // And it did not even look the code up.
      expect(repo.findInstrumentByCode).not.toHaveBeenCalled();
    });

    it('still admits the LAST attempt inside the budget, so the limit is 20 and not 19', async () => {
      const { service } = build({
        repo: {
          countRecentAttemptsByPatient: jest.fn().mockResolvedValue(20),
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
        },
      });
      expect(await service.preview('SAVEME', context())).toMatchObject({ applicable: true });
    });

    it('counts the per-IP budget too, but only when an IP is available', async () => {
      // `DiscountOrderContext` is FROZEN and carries no IP, so the pricing path
      // throttles per patient only. This module's own controller has one.
      const { service, repo } = build({ repo: { countRecentAttemptsByIp: jest.fn().mockResolvedValue(61) } });

      expect(await service.preview('SAVEME', context())).not.toMatchObject({ reason: 'TOO_MANY_ATTEMPTS' });
      expect(repo.countRecentAttemptsByIp).not.toHaveBeenCalled();

      expect(await service.previewForPatient('SAVEME', context(), '203.0.113.9')).toMatchObject({
        reason: 'TOO_MANY_ATTEMPTS',
      });
      expect(repo.countRecentAttemptsByIp).toHaveBeenCalledWith('203.0.113.9', expect.any(Date));
    });

    it('*** RECORDS BOTH OUTCOMES, because a throttle that only counts failures is trivially evaded ***', async () => {
      const resolved = build({ repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument()) } });
      await resolved.service.preview('SAVEME', context());
      expect(resolved.repo.recordCodeAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: PATIENT, outcome: 'pending' }),
      );
      expect(resolved.repo.markCodeAttemptOutcome).toHaveBeenCalledWith(1, 'resolved');

      const refused = build({ repo: { findInstrumentByCode: jest.fn().mockResolvedValue(null) } });
      await refused.service.preview('SAVEME', context());
      expect(refused.repo.markCodeAttemptOutcome).toHaveBeenCalledWith(1, 'refused');
    });

    it('records EXACTLY ONE attempt per call, so the budget cannot be steered by which refusal fires', async () => {
      const { service, repo } = build({ repo: { findInstrumentByCode: jest.fn().mockResolvedValue(null) } });
      await service.preview('SAVEME', context());
      expect(repo.recordCodeAttempt).toHaveBeenCalledTimes(1);
    });

    it('spends an attempt even when the base is malformed and the call THROWS', async () => {
      // A caller hammering the endpoint with rubbish bodies must not get a free
      // budget: `parseDiscountableBase` throws before any code is resolved, and
      // the row was already opened.
      const { service, repo } = build();
      await expect(
        service.preview('SAVEME', { ...context(), discountableAmount: 'not-money' }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.recordCodeAttempt).toHaveBeenCalledTimes(1);
      expect(repo.markCodeAttemptOutcome).toHaveBeenCalledWith(1, 'refused');
    });

    it('swallows a failure to record, because a bookkeeping row must not fail a checkout', async () => {
      const { service } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          recordCodeAttempt: jest.fn().mockRejectedValue(new Error('table gone')),
        },
      });
      await expect(service.preview('SAVEME', context())).resolves.toMatchObject({ applicable: true });
    });
  });

  describe('referral eligibility', () => {
    const referralCode = (referrer: string) =>
      instrument({ kind: 'referral', referrerPatientId: referrer, isPubliclyListed: false });

    it('refuses SELF_REFERRAL', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(PATIENT)) },
      });
      expect(await service.preview('REFABCD', context())).toMatchObject({ reason: 'SELF_REFERRAL' });
    });

    it('refuses ALREADY_REFERRED when the patient has ever been a referee', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(OTHER_PATIENT)) },
        referrals: { findEventByReferee: jest.fn().mockResolvedValue({ id: 'existing' }) },
      });
      expect(await service.preview('REFABCD', context())).toMatchObject({ reason: 'ALREADY_REFERRED' });
    });

    it('refuses NOT_A_FIRST_CONSULTATION when the port says the patient has consulted before', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(OTHER_PATIENT)) },
        booking: { countPriorConsultations: jest.fn().mockResolvedValue(3) },
      });
      expect(await service.preview('REFABCD', context())).toMatchObject({ reason: 'NOT_A_FIRST_CONSULTATION' });
    });

    it('*** SKIPS the first-consultation rule when the port reports `unknown` ***', async () => {
      // The asymmetry with the sweep, and it is deliberate. Refusing here would
      // mean referral codes NEVER WORK until the port is bound — the same class
      // of silent, total feature-off as hard-coding the qualifying status. The
      // hard guarantees (`referral_events_referee_once_idx`,
      // `referral_events_not_self_check`, the per-user cap) are database-enforced
      // and do not depend on this port at all.
      const { service, booking } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(OTHER_PATIENT)) },
        booking: { countPriorConsultations: jest.fn().mockResolvedValue('unknown') },
      });
      expect(await service.preview('REFABCD', context())).toMatchObject({ applicable: true });
      expect(booking.countPriorConsultations).toHaveBeenCalled();
    });

    it('does not even ASK the port when the rule is switched off', async () => {
      const { service, booking } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(OTHER_PATIENT)) },
        config: {
          referralProgram: { ...BASE_CONFIG.referralProgram, refereeMustBeFirstConsultation: false },
        },
      });
      await service.preview('REFABCD', context());
      expect(booking.countPriorConsultations).not.toHaveBeenCalled();
    });

    it('collapses a referral code into CODE_NOT_USABLE when the programme is off', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(referralCode(OTHER_PATIENT)) },
        config: { referralProgram: { ...BASE_CONFIG.referralProgram, enabled: false } },
      });
      expect(await service.preview('REFABCD', context())).toMatchObject({ reason: 'CODE_NOT_USABLE' });
    });
  });

  describe('affiliate eligibility', () => {
    const affiliateCode = instrument({ kind: 'affiliate', affiliatePartnerId: 'partner-1', isPubliclyListed: false });
    const partner = { id: 'partner-1', doctorId: DOCTOR, status: 'active' };

    it('*** COLLAPSES AN AFFILIATE CODE INTO CODE_NOT_USABLE WHILE THE MECHANISM IS OFF ***', async () => {
      // Which is how it ships. With the switch off, an affiliate code is
      // indistinguishable from a code that does not exist — the safe answer and
      // the honest one. Crucially this fires BEFORE the self-affiliate check, so
      // a disabled system reveals nothing at all.
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(affiliateCode) },
        affiliateRepo: { findPartnerById: jest.fn().mockResolvedValue(partner) },
        config: { affiliateEnabled: false },
      });
      expect(await service.preview('DRSMITH', context())).toMatchObject({ reason: 'CODE_NOT_USABLE' });
    });

    it('refuses SELF_AFFILIATE for a doctor’s own code on a booking with that same doctor', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(affiliateCode) },
        affiliateRepo: { findPartnerById: jest.fn().mockResolvedValue(partner) },
        config: { affiliateEnabled: true },
      });
      expect(await service.preview('DRSMITH', context({ doctorId: DOCTOR }))).toMatchObject({
        reason: 'SELF_AFFILIATE',
      });
    });

    it('allows the same code for a booking with a DIFFERENT doctor', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(affiliateCode) },
        affiliateRepo: { findPartnerById: jest.fn().mockResolvedValue(partner) },
        config: { affiliateEnabled: true },
      });
      expect(await service.preview('DRSMITH', context({ doctorId: 'another-doctor' }))).toMatchObject({
        applicable: true,
      });
    });

    it('collapses a paused partner into CODE_NOT_USABLE', async () => {
      const { service } = build({
        repo: { findInstrumentByCode: jest.fn().mockResolvedValue(affiliateCode) },
        affiliateRepo: { findPartnerById: jest.fn().mockResolvedValue({ ...partner, status: 'paused' }) },
        config: { affiliateEnabled: true },
      });
      expect(await service.preview('DRSMITH', context({ doctorId: 'another-doctor' }))).toMatchObject({
        reason: 'CODE_NOT_USABLE',
      });
    });
  });

  describe('the counted caps', () => {
    it('refuses TOTAL_LIMIT_REACHED when the total is full', async () => {
      const { service } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument({ maxTotalRedemptions: 5 })),
          countLiveRedemptions: jest.fn().mockResolvedValue(5),
        },
      });
      expect(await service.preview('SAVEME', context())).toMatchObject({ reason: 'TOTAL_LIMIT_REACHED' });
    });

    it('refuses USER_LIMIT_REACHED when this patient is at their own cap', async () => {
      const { service } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument({ maxRedemptionsPerUser: 1 })),
          countLiveRedemptionsForPatient: jest.fn().mockResolvedValue(1),
        },
      });
      expect(await service.preview('SAVEME', context())).toMatchObject({ reason: 'USER_LIMIT_REACHED' });
    });

    it('*** DOES NOT COUNT AN EXISTING REDEEMER AS A NEW DISTINCT ONE ***', async () => {
      // The subtle case. A "first 100 customers" coupon must still let customer
      // 42 take their second allowed use after the hundredth has arrived;
      // without the `forPatient === 0` guard the distinct cap silently becomes a
      // total cap for everybody who was not first.
      const capped = instrument({ maxDistinctRedeemers: 1, maxRedemptionsPerUser: 2 });

      const newcomer = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(capped),
          countDistinctRedeemers: jest.fn().mockResolvedValue(1),
          countLiveRedemptionsForPatient: jest.fn().mockResolvedValue(0),
        },
      });
      expect(await newcomer.service.preview('SAVEME', context())).toMatchObject({
        reason: 'DISTINCT_USER_LIMIT_REACHED',
      });

      const returning = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(capped),
          countDistinctRedeemers: jest.fn().mockResolvedValue(1),
          countLiveRedemptionsForPatient: jest.fn().mockResolvedValue(1),
        },
      });
      expect(await returning.service.preview('SAVEME', context())).toMatchObject({ applicable: true });
    });

    it('*** SKIPS THE GLOBAL COUNTS ENTIRELY when no global cap exists ***', async () => {
      // The bounding argument the schema makes. A per-user cap always exists
      // (the column is NOT NULL and > 0), but counting every live redemption to
      // satisfy it would make a popular uncapped coupon scan its whole history
      // on every checkout.
      const { service, repo } = build({
        repo: {
          findInstrumentByCode: jest
            .fn()
            .mockResolvedValue(instrument({ maxTotalRedemptions: null, maxDistinctRedeemers: null })),
        },
      });
      await service.preview('SAVEME', context());

      expect(repo.countLiveRedemptionsForPatient).toHaveBeenCalled();
      expect(repo.countLiveRedemptions).not.toHaveBeenCalled();
      expect(repo.countDistinctRedeemers).not.toHaveBeenCalled();
    });
  });

  describe('reserve', () => {
    it('takes the row lock BY ID and re-reads the status under it', async () => {
      const { service, repo } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument()),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });

      const result = await service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      expect(repo.findInstrumentByIdForUpdate).toHaveBeenCalledWith('inst-1', expect.anything());
      expect(result).toMatchObject({ reserved: true, reservationId: 'red-1', code: 'SAVEME' });
    });

    it('*** REFUSES IF THE CAMPAIGN WAS PAUSED BETWEEN THE LOOKUP AND THE LOCK ***', async () => {
      // The re-read under the lock is not redundant: the instrument was resolved
      // WITHOUT a lock, and an admin can pause it in the microseconds between.
      const { service, repo } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument({ status: 'active' })),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument({ status: 'paused' })),
        },
      });

      const result = await service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      expect(result).toMatchObject({ reserved: false, reason: 'CODE_NOT_USABLE' });
      expect(repo.insertRedemption).not.toHaveBeenCalled();
    });

    it('sets the reservation window to the booking hold PLUS the configured grace', async () => {
      // So a discount is never released while the slot it was priced for is
      // still held.
      const { service, repo } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument()),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
        config: { reservationGraceMinutes: 5 },
      });

      const hold = new Date('2030-01-01T00:00:00Z');
      await service.reserve({ code: 'SAVEME', context: context(), consultationId: CONSULTATION, holdExpiresAt: hold });

      expect(repo.insertRedemption).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: new Date('2030-01-01T00:05:00Z') }),
        expect.anything(),
      );
    });

    it('SNAPSHOTS the value rules onto the redemption, so a later edit cannot restate history', async () => {
      const { service, repo } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest
            .fn()
            .mockResolvedValue(instrument({ valueKind: 'percent', flatAmount: null, percentRate: '20', maxDiscountAmount: '150.00' })),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });

      await service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      expect(repo.insertRedemption).toHaveBeenCalledWith(
        expect.objectContaining({
          valueKind: 'percent',
          percentRate: '20',
          maxDiscountAmount: '150.00',
          discountableBase: '500.00',
          discountAmount: '100.00',
        }),
        expect.anything(),
      );
    });

    it('snapshots `enforcesSingleUsePerUser` from the cap in force AT INSERT TIME', async () => {
      // Deliberately a snapshot: raising a cap from 1 to 3 later must not
      // retroactively unlock an already-reserved row, or the partial index would
      // start permitting what it previously refused.
      const single = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument({ maxRedemptionsPerUser: 1 })),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });
      await single.service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });
      expect(single.repo.insertRedemption).toHaveBeenCalledWith(
        expect.objectContaining({ enforcesSingleUsePerUser: true }),
        expect.anything(),
      );

      const multi = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument({ maxRedemptionsPerUser: 3 })),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });
      await multi.service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });
      expect(multi.repo.insertRedemption).toHaveBeenCalledWith(
        expect.objectContaining({ enforcesSingleUsePerUser: false }),
        expect.anything(),
      );
    });

    it('writes the referral event in the SAME transaction as the redemption', async () => {
      const { service, referrals } = build({
        repo: {
          findInstrumentByCode: jest
            .fn()
            .mockResolvedValue(instrument({ kind: 'referral', referrerPatientId: OTHER_PATIENT })),
          findInstrumentByIdForUpdate: jest
            .fn()
            .mockResolvedValue(instrument({ kind: 'referral', referrerPatientId: OTHER_PATIENT })),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });

      await service.reserve({
        code: 'REFABCD',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      expect(referrals.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          referrerPatientId: OTHER_PATIENT,
          refereePatientId: PATIENT,
          // Born `qualifying`. Nothing is earned until a qualifying status.
          status: 'qualifying',
          // The terms in force RIGHT NOW, copied whole.
          programSnapshot: BASE_CONFIG.referralProgram,
        }),
        expect.anything(),
      );
    });

    it('audits TRANSACTIONALLY — a redemption must not be able to exist un-audited', async () => {
      const { service, audit } = build({
        repo: {
          findInstrumentByCode: jest.fn().mockResolvedValue(instrument()),
          findInstrumentByIdForUpdate: jest.fn().mockResolvedValue(instrument()),
          insertRedemption: jest.fn().mockResolvedValue(redemption()),
        },
      });

      await service.reserve({
        code: 'SAVEME',
        context: context(),
        consultationId: CONSULTATION,
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      // Two arguments: the entry AND the transaction handle. A one-argument call
      // would be best-effort, which is not good enough for money.
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'discount_redemption', metadata: expect.objectContaining({ change: 'reserved' }) }),
        expect.anything(),
      );
      expect(audit.write.mock.calls[0]).toHaveLength(2);
    });

    describe('the indexes get the last word', () => {
      it.each([
        [PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE, 'ALREADY_APPLIED'],
        [PROMOTION_INDEXES.SINGLE_USE_PER_USER, 'USER_LIMIT_REACHED'],
        [PROMOTION_INDEXES.REFERRAL_REFEREE_ONCE, 'ALREADY_REFERRED'],
      ])('maps a %s violation to %s', async (constraint, reason) => {
        // The WRAPPED shape, which is what Drizzle 0.45 actually throws.
        const { service } = build({
          repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument()) },
          transactionThrows: { name: 'DrizzleQueryError', cause: { code: '23505', constraint } },
        });

        const result = await service.reserve({
          code: 'SAVEME',
          context: context(),
          consultationId: CONSULTATION,
          holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
        });
        expect(result).toMatchObject({ reserved: false, reason });
      });

      it('RETHROWS a genuine fault rather than dressing it as a refusal', async () => {
        const { service } = build({
          repo: { findInstrumentByCode: jest.fn().mockResolvedValue(instrument()) },
          transactionThrows: new Error('connection terminated'),
        });

        await expect(
          service.reserve({
            code: 'SAVEME',
            context: context(),
            consultationId: CONSULTATION,
            holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
          }),
        ).rejects.toThrow('connection terminated');
      });
    });
  });

  describe('confirm', () => {
    it('burns a reserved redemption and records the captured bill', async () => {
      const { service, repo } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption()),
          consumeRedemptionIfReserved: jest.fn().mockResolvedValue(redemption({ status: 'consumed' })),
        },
        affiliates: {
          readCapturedComponents: jest.fn().mockReturnValue({ consultationFee: '500.00', convenienceFee: '100.00' }),
        },
      });

      const result = await service.confirm({
        consultationId: CONSULTATION,
        paymentId: 'pay-1',
        capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }],
      });

      expect(result).toEqual({ reservationId: 'red-1', status: 'consumed' });
      expect(repo.consumeRedemptionIfReserved).toHaveBeenCalledWith(
        'red-1',
        expect.objectContaining({ paymentId: 'pay-1', capturedConvenienceFee: '100.00' }),
        expect.anything(),
      );
    });

    it('is IDEMPOTENT: a replayed capture reports the consumed row without re-burning it', async () => {
      const { service, repo } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption({ status: 'consumed', paymentId: 'pay-1' })),
        },
      });

      expect(await service.confirm({ consultationId: CONSULTATION, paymentId: 'pay-1' })).toEqual({
        reservationId: 'red-1',
        status: 'consumed',
      });
      expect(repo.consumeRedemptionIfReserved).not.toHaveBeenCalled();
    });

    it('BACKFILLS a payment id the sweep could not know, guarded so a real one is never overwritten', async () => {
      const { service, repo } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption({ status: 'consumed', paymentId: null })),
          attachPaymentIdIfMissing: jest.fn().mockResolvedValue(1),
        },
      });

      await service.confirm({ consultationId: CONSULTATION, paymentId: 'pay-1' });
      expect(repo.attachPaymentIdIfMissing).toHaveBeenCalledWith(
        'red-1',
        expect.objectContaining({ paymentId: 'pay-1' }),
        expect.anything(),
      );
    });

    it('returns null when the consultation carried no discount at all', async () => {
      const { service } = build({
        repo: { findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(null) },
      });
      expect(await service.confirm({ consultationId: CONSULTATION, paymentId: 'pay-1' })).toBeNull();
    });
  });

  describe('release', () => {
    it('*** NEVER FORCES: a confirm that won the race leaves a consumed row untouched ***', async () => {
      // Releasing a consumed redemption would hand a capacity slot back to a
      // capped coupon that has ALREADY been spent on a bill the patient has
      // already paid — so it could be redeemed once more than its cap allows.
      const { service, repo } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption({ status: 'consumed' })),
        },
      });

      expect(await service.release({ consultationId: CONSULTATION, reason: 'sweep' })).toBeNull();
      expect(repo.releaseRedemptionIfReserved).not.toHaveBeenCalled();
    });

    it('releases a reserved row and VOIDS the referral it was carrying, in one transaction', async () => {
      const { service, referrals } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption()),
          releaseRedemptionIfReserved: jest.fn().mockResolvedValue(redemption({ status: 'released' })),
        },
        referrals: {
          findEventByRedemption: jest.fn().mockResolvedValue({ id: 'event-1' }),
          markVoidIfQualifying: jest.fn().mockResolvedValue({ id: 'event-1' }),
        },
      });

      expect(await service.release({ consultationId: CONSULTATION, reason: 'abandoned' })).toEqual({
        reservationId: 'red-1',
        status: 'released',
      });
      expect(referrals.markVoidIfQualifying).toHaveBeenCalledWith('event-1', 'abandoned', expect.anything());
    });

    it('voids a pending commission alongside the release', async () => {
      const { service, affiliates } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption()),
          releaseRedemptionIfReserved: jest.fn().mockResolvedValue(redemption({ status: 'released' })),
        },
      });

      await service.release({ consultationId: CONSULTATION, reason: 'cancelled' });
      expect(affiliates.voidPendingCommissionForConsultation).toHaveBeenCalledWith(
        CONSULTATION,
        'cancelled',
        expect.anything(),
      );
    });

    it('is idempotent: with nothing live, it returns null rather than erroring', async () => {
      const { service } = build({
        repo: { findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(null) },
      });
      expect(await service.release({ consultationId: CONSULTATION, reason: 'again' })).toBeNull();
    });
  });

  describe('confirmFromSweep', () => {
    it('consumes with a NULL payment id, and flags the row as unreconciled', async () => {
      // The truthful state: the discount WAS spent, on a bill the patient WAS
      // charged. Leaving it `reserved` would need its expiry re-extended forever.
      const { service, repo, audit } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption()),
          consumeRedemptionIfReserved: jest.fn().mockResolvedValue(redemption({ status: 'consumed' })),
        },
      });

      expect(await service.confirmFromSweep(CONSULTATION, 'scheduled')).toBe(true);
      expect(repo.consumeRedemptionIfReserved).toHaveBeenCalledWith(
        'red-1',
        expect.objectContaining({ paymentId: null }),
        expect.anything(),
      );
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ source: 'sweep_backstop', paymentIdUnknown: true }),
        }),
        expect.anything(),
      );
    });

    it('does nothing when the row is not reserved', async () => {
      const { service } = build({
        repo: {
          findLiveRedemptionForConsultationForUpdate: jest.fn().mockResolvedValue(redemption({ status: 'consumed' })),
        },
      });
      expect(await service.confirmFromSweep(CONSULTATION, 'scheduled')).toBe(false);
    });
  });

  describe('getForConsultation', () => {
    it('returns the live reservation with the code read off the instrument', async () => {
      const { service } = build({
        repo: {
          findLiveRedemptionForConsultation: jest.fn().mockResolvedValue(redemption()),
          findInstrumentById: jest.fn().mockResolvedValue(instrument()),
        },
      });

      expect(await service.getForConsultation(CONSULTATION)).toEqual({
        reservationId: 'red-1',
        instrumentId: 'inst-1',
        code: 'SAVEME',
        discountAmount: '100.00',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      });
    });

    it('returns null when nothing is attached', async () => {
      const { service } = build({
        repo: { findLiveRedemptionForConsultation: jest.fn().mockResolvedValue(null) },
      });
      expect(await service.getForConsultation(CONSULTATION)).toBeNull();
    });
  });

  describe('countDataRightsRowsForPatient — M-21', () => {
    it('aggregates all six counts from the three owning repositories', async () => {
      const { service, repo, referrals, affiliateRepo } = build({
        repo: {
          countDataRightsRows: jest
            .fn()
            .mockResolvedValue({ discountInstruments: 2, discountRedemptions: 3, promotionCodeAttempts: 4 }),
        },
        referrals: { countDataRightsRows: jest.fn().mockResolvedValue({ referralEvents: 5 }) },
        affiliateRepo: {
          countDataRightsRows: jest
            .fn()
            .mockResolvedValue({ affiliateAttributions: 6, affiliateCommissions: 7 }),
        },
      });

      const input = { patientId: PATIENT, consultationIds: [CONSULTATION] };
      expect(await service.countDataRightsRowsForPatient(input)).toEqual({
        discountInstruments: 2,
        discountRedemptions: 3,
        promotionCodeAttempts: 4,
        referralEvents: 5,
        affiliateAttributions: 6,
        affiliateCommissions: 7,
      });

      expect(repo.countDataRightsRows).toHaveBeenCalledWith(PATIENT);
      expect(referrals.countDataRightsRows).toHaveBeenCalledWith(PATIENT);
      expect(affiliateRepo.countDataRightsRows).toHaveBeenCalledWith(input);
    });

    it('is all zeros for a patient with no rows anywhere', async () => {
      const { service } = build();
      expect(await service.countDataRightsRowsForPatient({ patientId: PATIENT, consultationIds: [] })).toEqual({
        discountInstruments: 0,
        discountRedemptions: 0,
        promotionCodeAttempts: 0,
        referralEvents: 0,
        affiliateAttributions: 0,
        affiliateCommissions: 0,
      });
    });
  });

  describe('anonymizePromotionCodeAttemptsForPatient — M-21, THE ONLY WRITE', () => {
    it('returns the exact count the repository reports', async () => {
      const { service, repo } = build({
        repo: { anonymizeCodeAttemptsForPatient: jest.fn().mockResolvedValue({ anonymizedCount: 3 }) },
      });
      expect(await service.anonymizePromotionCodeAttemptsForPatient(PATIENT)).toEqual({ anonymizedCount: 3 });
      expect(repo.anonymizeCodeAttemptsForPatient).toHaveBeenCalledWith(PATIENT);
    });

    it('is a no-op — returns zero, never throws — when there is nothing to anonymize', async () => {
      const { service } = build({
        repo: { anonymizeCodeAttemptsForPatient: jest.fn().mockResolvedValue({ anonymizedCount: 0 }) },
      });
      await expect(service.anonymizePromotionCodeAttemptsForPatient(OTHER_PATIENT)).resolves.toEqual({
        anonymizedCount: 0,
      });
    });
  });
});
