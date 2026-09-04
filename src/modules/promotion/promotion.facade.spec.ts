import { PromotionFacade } from './promotion.facade';
import type { DiscountContract, DiscountOrderContext } from './promotion.contract';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * *** THE POINT OF THIS FILE IS THE FIRST TEST, AND IT IS A COMPILE-TIME ONE. ***
 *
 * `modules/pricing` is being built in a PARALLEL WORKTREE against a LOCAL MIRROR
 * of `DiscountContract`. It cannot see this file, this module, or these types.
 * The entire handover post-merge is one line in pricing's providers array:
 *
 *     { provide: DISCOUNT_PORT, useExisting: PromotionFacade }
 *
 * That works only because TypeScript is structural and `PromotionFacade`
 * satisfies `DiscountContract` with NO ADAPTER AND NO CAST. The assignment below
 * is what makes a drift on the frozen half a `tsc` error in THIS repository,
 * rather than a runtime surprise after both branches are merged, on the one seam
 * that decides what a patient is charged.
 *
 * If this file stops compiling, do not fix it by widening a type. Find what
 * changed on the frozen surface and put it back.
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('PromotionFacade', () => {
  const context: DiscountOrderContext = {
    patientId: 'p-1',
    doctorId: 'd-1',
    specialtyId: null,
    components: [],
    discountableAmount: '100.00',
    currency: 'INR',
    mode: 'scheduled',
  };

  function build() {
    const promotions = {
      preview: jest.fn().mockResolvedValue({ applicable: false, reason: 'CODE_NOT_USABLE', message: 'no' }),
      reserve: jest.fn().mockResolvedValue({ reserved: false, reason: 'CODE_NOT_USABLE', message: 'no' }),
      confirm: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
      getForConsultation: jest.fn().mockResolvedValue(null),
      listRedeemableForPatient: jest.fn().mockResolvedValue([]),
      countDataRightsRowsForPatient: jest.fn().mockResolvedValue({
        discountInstruments: 0,
        discountRedemptions: 0,
        affiliateAttributions: 0,
        affiliateCommissions: 0,
        referralEvents: 0,
        promotionCodeAttempts: 0,
      }),
      anonymizePromotionCodeAttemptsForPatient: jest.fn().mockResolvedValue({ anonymizedCount: 0 }),
    };
    const referrals = { getOrCreateReferralCode: jest.fn().mockResolvedValue({ code: 'REFX' }) };
    const affiliates = {
      recordAttribution: jest.fn().mockResolvedValue(null),
      recordLinkOnlyCommissionForPatient: jest.fn().mockResolvedValue(null),
    };

    const facade = new PromotionFacade(promotions as never, referrals as never, affiliates as never);
    return { facade, promotions, referrals, affiliates };
  }

  it('*** SATISFIES `DiscountContract` STRUCTURALLY — no adapter, no cast ***', () => {
    const { facade } = build();

    // THE ASSERTION IS THE ASSIGNMENT ITSELF. If `DiscountContract` and
    // `PromotionFacade` ever diverge — a renamed field, an added required
    // argument — this line fails to compile and the suite never runs.
    const port: DiscountContract = facade;

    // A runtime check too, so a `tsc` run that was skipped cannot hide a missing
    // method behind an interface that is erased at runtime.
    for (const method of ['preview', 'reserve', 'confirm', 'release', 'getForConsultation'] as const) {
      expect(typeof port[method]).toBe('function');
    }
  });

  it('exposes EXACTLY the frozen five plus this module’s own, and nothing accidental', () => {
    // A method that appears here without appearing in `PromotionContract` is a
    // surface somebody added without deciding it was public — the facade is the
    // ONLY thing another module may import (`backend/README.md` §2), so its
    // shape is a design decision rather than an implementation detail.
    const own = Object.getOwnPropertyNames(PromotionFacade.prototype).filter((name) => name !== 'constructor');
    expect(own.sort()).toEqual(
      [
        'anonymizePromotionCodeAttemptsForPatient',
        'confirm',
        'countDataRightsRowsForPatient',
        'getForConsultation',
        'getOrCreateReferralCode',
        'listRedeemableInstrumentsForPatient',
        'preview',
        'recordAffiliateAttribution',
        'recordLinkOnlyAffiliateCommission',
        'release',
        'reserve',
      ].sort(),
    );
  });

  describe('is THIN — every rule lives in a service, and the facade only forwards', () => {
    it('forwards preview', async () => {
      const { facade, promotions } = build();
      await facade.preview('SAVEME', context);
      expect(promotions.preview).toHaveBeenCalledWith('SAVEME', context);
    });

    it('forwards reserve unchanged', async () => {
      const { facade, promotions } = build();
      const input = { code: 'SAVEME', context, consultationId: 'c-1', holdExpiresAt: new Date('2030-01-01T00:00:00Z') };
      await facade.reserve(input);
      expect(promotions.reserve).toHaveBeenCalledWith(input);
    });

    it('forwards confirm, including the optional captured components', async () => {
      const { facade, promotions } = build();
      const input = { consultationId: 'c-1', paymentId: 'pay-1', capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }] };
      await facade.confirm(input);
      expect(promotions.confirm).toHaveBeenCalledWith(input);
    });

    it('forwards release', async () => {
      const { facade, promotions } = build();
      await facade.release({ consultationId: 'c-1', reason: 'cancelled' });
      expect(promotions.release).toHaveBeenCalledWith({ consultationId: 'c-1', reason: 'cancelled' });
    });

    it('forwards getForConsultation', async () => {
      const { facade, promotions } = build();
      await facade.getForConsultation('c-1');
      expect(promotions.getForConsultation).toHaveBeenCalledWith('c-1');
    });

    it('forwards the referral code request', async () => {
      const { facade, referrals } = build();
      await facade.getOrCreateReferralCode('p-1');
      expect(referrals.getOrCreateReferralCode).toHaveBeenCalledWith('p-1');
    });

    it('forwards the link attribution', async () => {
      const { facade, affiliates } = build();
      await facade.recordAffiliateAttribution({ patientId: 'p-1', token: 't' });
      expect(affiliates.recordAttribution).toHaveBeenCalledWith({ patientId: 'p-1', token: 't' });
    });

    it('forwards the link-only commission — the seam the coordinator wires', async () => {
      const { facade, affiliates } = build();
      const input = { patientId: 'p-1', doctorId: 'd-1', consultationId: 'c-1', paymentId: 'pay-1' };
      await facade.recordLinkOnlyAffiliateCommission(input);
      expect(affiliates.recordLinkOnlyCommissionForPatient).toHaveBeenCalledWith(input);
    });

    it('forwards the M-21 data-rights count', async () => {
      const { facade, promotions } = build();
      const input = { patientId: 'p-1', consultationIds: ['c-1', 'c-2'] };
      await facade.countDataRightsRowsForPatient(input);
      expect(promotions.countDataRightsRowsForPatient).toHaveBeenCalledWith(input);
    });

    it('forwards the M-21 promotion-code-attempts anonymization', async () => {
      const { facade, promotions } = build();
      await facade.anonymizePromotionCodeAttemptsForPatient('p-1');
      expect(promotions.anonymizePromotionCodeAttemptsForPatient).toHaveBeenCalledWith('p-1');
    });
  });

  it('returns the union UNTOUCHED, so a caller can discriminate on it', async () => {
    // The facade must not normalise, wrap or throw on a refusal — the whole
    // reason the contract returns a union is that a refusal is the system
    // working, and a caller has to be able to see which one it was.
    const { facade, promotions } = build();
    promotions.preview.mockResolvedValue({
      applicable: false,
      reason: 'MIN_ORDER_NOT_MET',
      message: 'This code needs a higher order value.',
      requiredMinOrder: '500.00',
    });

    const result = await facade.preview('SAVEME', context);
    expect(result).toEqual({
      applicable: false,
      reason: 'MIN_ORDER_NOT_MET',
      message: 'This code needs a higher order value.',
      requiredMinOrder: '500.00',
    });
  });
});
