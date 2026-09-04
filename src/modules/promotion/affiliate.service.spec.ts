import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { AffiliatePartnerRow } from '../../schema/affiliate-partners.schema';
import type { DiscountRedemptionRow } from '../../schema/discount-redemptions.schema';
import { AffiliateService } from './affiliate.service';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * *** THE AFFILIATE MECHANISM SHIPS SWITCHED OFF, AND THESE TESTS ARE WHERE
 * THAT IS ENFORCED RATHER THAN ASSERTED IN A COMMENT. ***
 *
 * India's NMC Registered Medical Practitioner (Professional Conduct)
 * Regulations, 2023 prohibit a registered practitioner from receiving any
 * commission in return for referring or procuring a patient; the stated penalty
 * is suspension and THE EXPOSURE LANDS ON THE DOCTOR. The product owner
 * confirmed: build it, ship it disabled.
 *
 * So every gate below is a test, not a convention: nothing accrues, nothing
 * activates and nothing settles while `promotion.affiliate_enabled` is `false`,
 * and a partner is born `paused` whatever the caller asks for.
 * ══════════════════════════════════════════════════════════════════════════
 */

const DOCTOR = 'doctor-1';
const PARTNER = 'partner-1';

function partner(overrides: Partial<AffiliatePartnerRow> = {}): AffiliatePartnerRow {
  return {
    id: PARTNER,
    doctorId: DOCTOR,
    status: 'active',
    linkSlug: 'dr-smith-clinic',
    commissionValueKind: 'percent',
    commissionRate: '10.00',
    commissionFlat: null,
    commissionBase: 'net_platform_margin',
    commissionMax: null,
    agreementReference: 'AGR-1',
    note: null,
    createdByAdminId: 'admin-1',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as AffiliatePartnerRow;
}

function redemption(overrides: Partial<DiscountRedemptionRow> = {}): DiscountRedemptionRow {
  return {
    id: 'red-1',
    instrumentId: 'inst-1',
    patientId: 'patient-1',
    consultationId: 'consult-1',
    paymentId: null,
    status: 'consumed',
    valueKind: 'flat',
    flatAmount: '40.00',
    percentRate: null,
    maxDiscountAmount: null,
    discountableBase: '100.00',
    discountAmount: '40.00',
    currency: 'INR',
    capturedConsultationFee: null,
    capturedConvenienceFee: null,
    affiliatePartnerId: PARTNER,
    attributionSource: 'code',
    enforcesSingleUsePerUser: true,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    consumedAt: new Date('2020-01-01T00:00:00Z'),
    releasedAt: null,
    releaseReason: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as DiscountRedemptionRow;
}

const CONFIG = {
  affiliateEnabled: true,
  affiliateAttributionDays: 30,
  referralProgram: {} as never,
  referralQualifyingStatuses: ['completed'],
  reservationGraceMinutes: 5,
  codeAttemptsPerPatientPerHour: 20,
  codeAttemptsPerIpPerHour: 60,
};

function build(overrides: { repo?: Record<string, jest.Mock>; config?: Partial<typeof CONFIG> } = {}) {
  const repo = {
    findPartnerById: jest.fn().mockResolvedValue(partner()),
    findPartnerByDoctorId: jest.fn().mockResolvedValue(null),
    findPartnerByLinkSlug: jest.fn().mockResolvedValue(null),
    insertPartner: jest.fn().mockImplementation(async (values: Record<string, unknown>) => partner(values)),
    updatePartner: jest.fn().mockImplementation(async (_id: string, values: Record<string, unknown>) => partner(values)),
    listPartners: jest.fn().mockResolvedValue([]),
    countPartners: jest.fn().mockResolvedValue(0),
    recordAttribution: jest.fn().mockImplementation(async (values: Record<string, unknown>) => ({ id: 'attr-1', ...values })),
    findActiveAttribution: jest.fn().mockResolvedValue(null),
    insertCommissionIfAbsent: jest.fn().mockImplementation(async (values: Record<string, unknown>) => ({ id: 'comm-1', ...values })),
    findCommissionByConsultation: jest.fn().mockResolvedValue(null),
    accrueCommissionIfPending: jest.fn().mockResolvedValue({ id: 'comm-1', partnerId: PARTNER, commissionAmount: '6.00' }),
    voidCommissionIfPending: jest.fn().mockResolvedValue({ id: 'comm-1' }),
    findPendingCommissions: jest.fn().mockResolvedValue([]),
    listCommissions: jest.fn().mockResolvedValue([]),
    countCommissions: jest.fn().mockResolvedValue(0),
    sumAccruedForPartner: jest.fn().mockResolvedValue('0.00'),
    claimAccruedCommissionsForSettlement: jest.fn().mockResolvedValue([]),
    insertSettlement: jest.fn().mockResolvedValue({ id: 'settle-1' }),
    setSettlementTotals: jest.fn().mockResolvedValue({ id: 'settle-1' }),
    listSettlements: jest.fn().mockResolvedValue([]),
    voidSettlement: jest.fn().mockResolvedValue({ settlement: null, restored: 0 }),
    ...overrides.repo,
  };

  const config = { getResolved: jest.fn().mockResolvedValue({ ...CONFIG, ...overrides.config }) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const db = { transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) };

  const service = new AffiliateService(db as never, repo as never, config as never, audit as never);
  return { service, repo, config, audit, db };
}

describe('AffiliateService', () => {
  describe('the master switch', () => {
    it('*** RECORDS NO COMMISSION while the mechanism is off ***', async () => {
      const { service, repo } = build({ config: { affiliateEnabled: false } });
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: { consultationFee: null, convenienceFee: '100.00' }, config: { ...CONFIG, affiliateEnabled: false } as never },
        {} as never,
      );
      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('*** REFUSES TO ACTIVATE A PARTNER while the mechanism is off ***', async () => {
      // Refused, not silently allowed-but-inert. An admin who thinks they have
      // switched a doctor on has made a COMMITMENT to that doctor; discovering
      // months later that nothing accrued is worse than a clear refusal now.
      const { service } = build({ config: { affiliateEnabled: false } });
      await expect(service.setPartnerStatus('admin-1', PARTNER, 'active')).rejects.toThrow(ForbiddenException);
    });

    it('still allows PAUSING a partner while the mechanism is off', async () => {
      // The switch gates turning things ON, never turning them off — an
      // emergency stop must work regardless of configuration.
      const { service } = build({ config: { affiliateEnabled: false } });
      await expect(service.setPartnerStatus('admin-1', PARTNER, 'paused')).resolves.toBeDefined();
    });

    it('*** REFUSES TO SETTLE while the mechanism is off ***', async () => {
      const { service } = build({ config: { affiliateEnabled: false } });
      await expect(
        service.settle('admin-1', { partnerId: PARTNER, method: 'off_system', periodStart: null, periodEnd: null, reference: null, note: null }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('records no LINK attribution while the mechanism is off', async () => {
      const { service, repo } = build({ config: { affiliateEnabled: false } });
      const token = service.mintAttributionToken(PARTNER, 30).token;
      expect(await service.recordAttribution({ patientId: 'p-1', token })).toBeNull();
      expect(repo.recordAttribution).not.toHaveBeenCalled();
    });

    it('issues no link while the mechanism is off — an admin must not be handed a URL that cannot work', async () => {
      const { service } = build({ config: { affiliateEnabled: false } });
      expect(await service.issueAttributionLink(PARTNER)).toBeNull();
    });
  });

  describe('createPartner', () => {
    it('*** IS BORN `paused`, WHATEVER THE CALLER ASKS ***', async () => {
      // Activating is a SECOND, separate, audited act — the least a mechanism
      // carrying the NMC exposure should require, and what makes "who turned
      // this on, and when" answerable.
      const { service, repo } = build();
      await service.createPartner('admin-1', {
        doctorId: DOCTOR,
        linkSlug: null,
        commissionValueKind: 'percent',
        commissionRate: '10',
        commissionFlat: null,
        commissionBase: 'net_platform_margin',
        commissionMax: null,
        agreementReference: 'AGR-1',
        note: null,
      });

      expect(repo.insertPartner).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }), expect.anything());
    });

    it('flags the audit row with the regulation, so every affiliate act is findable by predicate', async () => {
      const { service, audit } = build();
      await service.createPartner('admin-1', {
        doctorId: DOCTOR,
        linkSlug: null,
        commissionValueKind: 'flat',
        commissionFlat: '50.00',
        commissionRate: null,
        commissionBase: 'net_platform_margin',
        commissionMax: null,
        agreementReference: 'AGR-1',
        note: null,
      });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            legalSignOffRequired: true,
            regulation: expect.stringContaining('NMC'),
          }),
        }),
        expect.anything(),
      );
    });

    it('refuses a second arrangement for one doctor', async () => {
      const { service } = build({ repo: { findPartnerByDoctorId: jest.fn().mockResolvedValue(partner()) } });
      await expect(
        service.createPartner('admin-1', {
          doctorId: DOCTOR,
          linkSlug: null,
          commissionValueKind: 'flat',
          commissionFlat: '10.00',
          commissionRate: null,
          commissionBase: 'net_platform_margin',
          commissionMax: null,
          agreementReference: null,
          note: null,
        }),
      ).rejects.toThrow(ConflictException);
    });

    describe('commission shape, enforced where the message can name the field', () => {
      const base = {
        doctorId: DOCTOR,
        linkSlug: null,
        commissionBase: 'net_platform_margin' as const,
        commissionMax: null,
        agreementReference: null,
        note: null,
      };

      it('refuses a percentage with no rate', async () => {
        const { service } = build();
        await expect(
          service.createPartner('a', { ...base, commissionValueKind: 'percent', commissionRate: null, commissionFlat: null }),
        ).rejects.toThrow(/needs commissionRate/);
      });

      it('refuses a flat commission that also carries a rate', async () => {
        const { service } = build();
        await expect(
          service.createPartner('a', { ...base, commissionValueKind: 'flat', commissionFlat: '10.00', commissionRate: '5' }),
        ).rejects.toThrow(/no commissionRate/);
      });

      it('*** REQUIRES A CEILING FOR ANY BASE OTHER THAN NET MARGIN ***', async () => {
        // `affiliate_partners_nondefault_base_needs_cap`. Either of the other
        // two bases can exceed what the booking actually earned and make an
        // affiliate booking loss-making.
        const { service } = build();
        await expect(
          service.createPartner('a', {
            ...base,
            commissionBase: 'consultation_fee',
            commissionValueKind: 'percent',
            commissionRate: '10',
            commissionFlat: null,
            commissionMax: null,
          }),
        ).rejects.toThrow(/commissionMax is required/);
      });

      it('accepts a non-default base once a ceiling is given', async () => {
        const { service } = build();
        await expect(
          service.createPartner('a', {
            ...base,
            commissionBase: 'consultation_fee',
            commissionValueKind: 'percent',
            commissionRate: '10',
            commissionFlat: null,
            commissionMax: '100.00',
          }),
        ).resolves.toBeDefined();
      });

      it('refuses a malformed link slug', async () => {
        const { service } = build();
        await expect(
          service.createPartner('a', {
            ...base,
            linkSlug: 'Dr Smith!',
            commissionValueKind: 'flat',
            commissionFlat: '10.00',
            commissionRate: null,
          }),
        ).rejects.toThrow(/linkSlug/);
      });
    });
  });

  describe('the commission base', () => {
    const captured = (convenienceFee: string | null, consultationFee: string | null = null) => ({
      consultationFee,
      convenienceFee,
    });

    it('*** `net_platform_margin` = convenience fee LESS the discount the platform absorbed ***', async () => {
      // 100.00 convenience fee, 40.00 discount -> 60.00 margin -> 10% -> 6.00.
      // It NEVER reads the doctor's consultation fee, which is what keeps FR-7.4
      // literally true: a commission off platform revenue is a platform EXPENSE,
      // not a deduction from the doctor.
      const { service, repo } = build();
      await service.recordCommissionForRedemption(
        { redemption: redemption({ discountAmount: '40.00' }), paymentId: 'pay-1', captured: captured('100.00', '500.00'), config: CONFIG as never },
        {} as never,
      );

      expect(repo.insertCommissionIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ commissionBase: 'net_platform_margin', baseAmount: '60.00', commissionAmount: '6.00' }),
        expect.anything(),
      );
    });

    it('*** NEVER mistakes `discountable_base` for the convenience fee — it is THE WHOLE ORDER’S GROSS ***', async () => {
      // ══════════════════════════════════════════════════════════════════════
      // THE REGRESSION THIS FILE EXISTS TO HOLD. `resolveBasePaise` used to
      // fall back to the redemption's `discountable_base` when no
      // convenience-fee component arrived, on the grounds that "pricing
      // declared that amount discountable, and for this platform that IS the
      // convenience fee".
      //
      // It is not. `pricing-discount.contract.ts` names `discountableAmount` as
      // the WHOLE ORDER'S GROSS and `pricing.engine.ts` fills it from
      // `grossTotalPaise` — 600.00 on the seeded catalogue (500.00 doctor fee +
      // 100.00 convenience fee), not 100.00.
      //
      // So on this booking the platform's TRUE net margin is
      // 100.00 - 100.00 = 0.00 and the correct commission is 0.00. The old
      // fallback computed 600.00 - 100.00 = 500.00 and paid 50.00 — five times
      // the entire convenience fee, funded out of the DOCTOR'S OWN CONSULTATION
      // FEE, on the one base that ships with no mandatory ceiling precisely
      // because it is supposed to be incapable of that.
      //
      // The fix is to refuse to guess. Skipping under-pays; guessing over-paid.
      // ══════════════════════════════════════════════════════════════════════
      const { service, repo } = build();
      const result = await service.recordCommissionForRedemption(
        {
          redemption: redemption({ discountableBase: '600.00', discountAmount: '100.00' }),
          paymentId: 'pay-1',
          captured: captured(null),
          config: CONFIG as never,
        },
        {} as never,
      );

      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('and the link-only path is refused for the same reason, so both entry points agree', async () => {
      const { service, repo } = build({
        repo: {
          findActiveAttribution: jest.fn().mockResolvedValue({ partnerId: PARTNER }),
        },
      });
      const result = await service.recordLinkOnlyCommissionForPatient({
        patientId: 'patient-1',
        doctorId: 'other-doctor',
        consultationId: 'consult-1',
        paymentId: 'pay-1',
        capturedComponents: [{ code: 'doctor_fee', amount: '500.00' }],
      });

      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('SKIPS rather than guessing when no base can be derived at all', async () => {
      const { service, repo } = build({
        repo: { findPartnerById: jest.fn().mockResolvedValue(partner({ commissionBase: 'consultation_fee', commissionMax: '50.00' })) },
      });
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00', null), config: CONFIG as never },
        {} as never,
      );

      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('*** GST IS NEVER A BASE *** — an unrecognised base derives nothing rather than falling through to a number', async () => {
      const { service, repo } = build({
        repo: { findPartnerById: jest.fn().mockResolvedValue(partner({ commissionBase: 'gst_amount' as never, commissionMax: '50.00' })) },
      });
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00', '500.00'), config: CONFIG as never },
        {} as never,
      );

      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('cannot pay out more than the margin, even on a fully discounted booking', async () => {
      const { service, repo } = build();
      await service.recordCommissionForRedemption(
        { redemption: redemption({ discountAmount: '100.00' }), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );

      expect(repo.insertCommissionIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ baseAmount: '0.00', commissionAmount: '0.00' }),
        expect.anything(),
      );
    });

    it('SNAPSHOTS every term onto the commission row', async () => {
      // Renegotiating a partner's deal next quarter must not restate what last
      // quarter's bookings earned.
      const { service, repo } = build();
      await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );

      expect(repo.insertCommissionIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          commissionValueKind: 'percent',
          commissionRate: '10.00',
          commissionBase: 'net_platform_margin',
          commissionMax: null,
          status: 'pending',
        }),
        expect.anything(),
      );
    });

    it('creates the row `pending`, NEVER `accrued` — that is the anti-clawback design', async () => {
      const { service, repo } = build();
      await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );
      expect(repo.insertCommissionIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
        expect.anything(),
      );
    });

    it('records nothing for a redemption with no attribution', async () => {
      const { service, repo } = build();
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption({ affiliatePartnerId: null }), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );
      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('records nothing when the partner has since been paused', async () => {
      const { service, repo } = build({ repo: { findPartnerById: jest.fn().mockResolvedValue(partner({ status: 'paused' })) } });
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );
      expect(result).toBeNull();
    });

    it('treats a swallowed ON CONFLICT as SUCCESS, not an error', async () => {
      // One commission per consultation, ever. A replayed capture, a sweep pass
      // and an explicit confirm can all race; the index decides and every writer
      // tolerates losing.
      const { service, audit } = build({ repo: { insertCommissionIfAbsent: jest.fn().mockResolvedValue(null) } });
      const result = await service.recordCommissionForRedemption(
        { redemption: redemption(), paymentId: 'pay-1', captured: captured('100.00'), config: CONFIG as never },
        {} as never,
      );
      expect(result).toBeNull();
      // And no second audit row for a commission that already existed.
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('readCapturedComponents — the tolerant match at the pricing seam', () => {
    it('finds the convenience fee under several plausible names', () => {
      const { service } = build();
      for (const code of ['convenience_fee', 'CONVENIENCE', 'platform_fee', 'the-convenience-charge']) {
        expect(service.readCapturedComponents([{ code, amount: '100.00' }]).convenienceFee).toBe('100.00');
      }
    });

    it('finds the consultation fee, which exists only so it can be EXCLUDED from the default base', () => {
      const { service } = build();
      expect(service.readCapturedComponents([{ code: 'consultation_fee', amount: '500.00' }]).consultationFee).toBe('500.00');
      expect(service.readCapturedComponents([{ code: 'doctor_fee', amount: '500.00' }]).consultationFee).toBe('500.00');
    });

    it('returns nulls rather than guessing when nothing matches', () => {
      const { service } = build();
      expect(service.readCapturedComponents([{ code: 'gst', amount: '90.00' }])).toEqual({
        consultationFee: null,
        convenienceFee: null,
      });
      expect(service.readCapturedComponents(undefined)).toEqual({ consultationFee: null, convenienceFee: null });
      expect(service.readCapturedComponents([])).toEqual({ consultationFee: null, convenienceFee: null });
    });
  });

  describe('accrual', () => {
    it('flips `pending` to `accrued` and audits it as the moment money became owed', async () => {
      const { service, audit } = build();
      expect(await service.accrueCommission('comm-1', 'consult-1')).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ change: 'accrued', before: 'pending', nmcRegulatedArrangement: true }),
        }),
        expect.anything(),
      );
    });

    it('*** ACCRUES NOTHING WHILE THE MASTER SWITCH IS OFF, even for a row recorded while it was on ***', async () => {
      // A `pending` commission outlives the switch that created it. Without this
      // gate the sweep goes on turning those rows into money owed to a doctor
      // AFTER an admin has switched the mechanism off — so "off" would mean
      // "stops taking new ones", which is not what a regulatory kill switch is.
      // The row is left `pending`, not voided: it accrues if the switch returns.
      const { service, repo, audit } = build({ config: { affiliateEnabled: false } });
      expect(await service.accrueCommission('comm-1', 'consult-1')).toBe(false);
      expect(repo.accrueCommissionIfPending).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does nothing on a second pass — the guarded UPDATE matches zero rows', async () => {
      const { service, audit } = build({ repo: { accrueCommissionIfPending: jest.fn().mockResolvedValue(null) } });
      expect(await service.accrueCommission('comm-1', 'consult-1')).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('voids a pending commission when the consultation dies', async () => {
      const { service } = build();
      expect(await service.voidPendingCommissionById('comm-1', 'consult-1', 'consultation_cancelled')).toBe(true);
    });

    it('never voids a commission that is not pending', async () => {
      const { service } = build({ repo: { voidCommissionIfPending: jest.fn().mockResolvedValue(null) } });
      expect(await service.voidPendingCommissionById('comm-1', 'consult-1', 'too_late')).toBe(false);
    });
  });

  describe('settlement — the status guard is what makes double-payment impossible', () => {
    it('writes the amount and count FROM THE `RETURNING` SET, never from a prior read', async () => {
      // Which is what stops the settlement row from disagreeing with the
      // commissions it claims.
      const { service, repo } = build({
        repo: {
          claimAccruedCommissionsForSettlement: jest.fn().mockResolvedValue([
            { id: 'c1', commissionAmount: '10.50' },
            { id: 'c2', commissionAmount: '4.50' },
          ]),
        },
      });

      const result = await service.settle('admin-1', {
        partnerId: PARTNER,
        method: 'off_system',
        periodStart: null,
        periodEnd: null,
        reference: 'UTR-123',
        note: null,
      });

      expect(result).toEqual({ settlementId: 'settle-1', amount: '15.00', commissionCount: 2 });
      expect(repo.setSettlementTotals).toHaveBeenCalledWith(
        'settle-1',
        { amount: '15.00', commissionCount: 2 },
        expect.anything(),
      );
    });

    it('*** REFUSES AN EMPTY SETTLEMENT, rolling the insert back with it ***', async () => {
      // Two admins settling one partner concurrently: the second UPDATE matches
      // zero rows because of `settlement_id IS NULL`, and this refusal is what
      // stops a settlement of nothing being recorded as if it were real.
      const { service } = build({ repo: { claimAccruedCommissionsForSettlement: jest.fn().mockResolvedValue([]) } });
      await expect(
        service.settle('admin-1', { partnerId: PARTNER, method: 'off_system', periodStart: null, periodEnd: null, reference: null, note: null }),
      ).rejects.toThrow(ConflictException);
    });

    it('MIRRORS the bank reference into the audit metadata as well as the column', async () => {
      // The `payments` rule ("the admin who marks a payout paid puts the
      // reference in the metadata of that audit_log row") is honoured even
      // though this table legitimately has its own column.
      const { service, audit } = build({
        repo: { claimAccruedCommissionsForSettlement: jest.fn().mockResolvedValue([{ id: 'c1', commissionAmount: '10.00' }]) },
      });

      await service.settle('admin-1', {
        partnerId: PARTNER,
        method: 'off_system',
        periodStart: null,
        periodEnd: null,
        reference: 'UTR-999',
        note: null,
      });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reference: 'UTR-999', commissionIds: ['c1'], nmcRegulatedArrangement: true }),
        }),
        expect.anything(),
      );
    });

    it('sums exactly, in paise, never through a float', async () => {
      const { service } = build({
        repo: {
          claimAccruedCommissionsForSettlement: jest.fn().mockResolvedValue(
            Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, commissionAmount: '0.10' })),
          ),
        },
      });
      // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in IEEE-754.
      const result = await service.settle('admin-1', {
        partnerId: PARTNER,
        method: 'off_system',
        periodStart: null,
        periodEnd: null,
        reference: null,
        note: null,
      });
      expect(result.amount).toBe('0.30');
    });
  });

  describe('the link token — signed, self-expiring, never trusted twice', () => {
    it('round-trips a token it minted', () => {
      const { service } = build();
      const { token } = service.mintAttributionToken(PARTNER, 30);
      expect(service.verifyAttributionToken(token)).toMatchObject({ partnerId: PARTNER });
    });

    it('*** REFUSES A FORGED SIGNATURE ***', () => {
      const { service } = build();
      const { token } = service.mintAttributionToken(PARTNER, 30);
      const [version, payload] = token.split('.');
      expect(service.verifyAttributionToken(`${version}.${payload}.forged`)).toBeNull();
    });

    it('refuses a tampered payload — the signature covers it', () => {
      const { service } = build();
      const { token } = service.mintAttributionToken(PARTNER, 30);
      const parts = token.split('.');
      const swapped = Buffer.from(JSON.stringify({ p: 'other-partner', e: 9_999_999_999 }), 'utf8').toString('base64url');
      expect(service.verifyAttributionToken(`${parts[0]}.${swapped}.${parts[2]}`)).toBeNull();
    });

    it('*** SELF-EXPIRES, so a stale bookmark stops attributing with no server state ***', () => {
      const { service } = build();
      const { token } = service.mintAttributionToken(PARTNER, -1);
      expect(service.verifyAttributionToken(token)).toBeNull();
    });

    it('refuses malformed input without throwing', () => {
      const { service } = build();
      for (const bad of ['', 'nonsense', 'v1.only-two', 'v2.a.b', 'v1..']) {
        expect(service.verifyAttributionToken(bad)).toBeNull();
      }
    });
  });

  describe('resolveLinkSlug — the only unauthenticated entry point', () => {
    it('exchanges an active partner’s slug for a token, and returns NOTHING else', async () => {
      // No partner id, no doctor name, no terms. The token is inert until an
      // authenticated request presents it.
      const { service } = build({ repo: { findPartnerByLinkSlug: jest.fn().mockResolvedValue(partner()) } });
      const resolved = await service.resolveLinkSlug('dr-smith-clinic');

      expect(Object.keys(resolved ?? {}).sort()).toEqual(['expiresAt', 'token']);
      expect(service.verifyAttributionToken(resolved!.token)).toMatchObject({ partnerId: PARTNER });
    });

    it('*** COLLAPSES unknown / paused / switched-off into ONE answer ***', async () => {
      // So an unauthenticated caller cannot walk the slug namespace and learn
      // which doctors have arrangements — the same collapse, for the same
      // reason, as the code resolver's single CODE_NOT_USABLE.
      const unknown = build({ repo: { findPartnerByLinkSlug: jest.fn().mockResolvedValue(null) } });
      expect(await unknown.service.resolveLinkSlug('dr-smith-clinic')).toBeNull();

      const paused = build({ repo: { findPartnerByLinkSlug: jest.fn().mockResolvedValue(partner({ status: 'paused' })) } });
      expect(await paused.service.resolveLinkSlug('dr-smith-clinic')).toBeNull();

      const off = build({
        repo: { findPartnerByLinkSlug: jest.fn().mockResolvedValue(partner()) },
        config: { affiliateEnabled: false },
      });
      expect(await off.service.resolveLinkSlug('dr-smith-clinic')).toBeNull();
    });

    it('does not even query on a malformed slug', async () => {
      const { service, repo } = build();
      expect(await service.resolveLinkSlug('Dr Smith!')).toBeNull();
      expect(await service.resolveLinkSlug('short')).toBeNull();
      expect(repo.findPartnerByLinkSlug).not.toHaveBeenCalled();
    });

    it('*** WRITES NO ROW — nothing is stored for an anonymous visitor, ever ***', async () => {
      const { service, repo } = build({ repo: { findPartnerByLinkSlug: jest.fn().mockResolvedValue(partner()) } });
      await service.resolveLinkSlug('dr-smith-clinic');
      expect(repo.recordAttribution).not.toHaveBeenCalled();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('recordAttribution — LAST TOUCH WINS', () => {
    it('writes the row and honours the CONFIGURED window, not the token’s', async () => {
      // An admin shortening the attribution window must not be overridden by a
      // long-lived token minted before the change. The token only carries the
      // claim; the row is what the server honours.
      const { service, repo } = build({ config: { affiliateAttributionDays: 7 } });
      const { token } = service.mintAttributionToken(PARTNER, 365);

      const result = await service.recordAttribution({ patientId: 'p-1', token });
      expect(result).toMatchObject({ partnerId: PARTNER });

      const written = repo.recordAttribution.mock.calls[0][0] as { expiresAt: Date; source: string; status: string };
      const days = (written.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(Math.round(days)).toBe(7);
      expect(written).toMatchObject({ source: 'link', status: 'active' });
    });

    it('returns null — never throws — for a stale link in somebody’s bookmark', async () => {
      // A 4xx would surface as a broken app on a perfectly ordinary journey.
      const { service } = build();
      expect(await service.recordAttribution({ patientId: 'p-1', token: 'rubbish' })).toBeNull();
    });

    it('returns null when the partner has since been paused', async () => {
      const { service } = build({ repo: { findPartnerById: jest.fn().mockResolvedValue(partner({ status: 'paused' })) } });
      const { token } = service.mintAttributionToken(PARTNER, 30);
      expect(await service.recordAttribution({ patientId: 'p-1', token })).toBeNull();
    });
  });

  describe('recordLinkOnlyCommissionForPatient — the doctor’s commission does not need a coupon', () => {
    it('*** NEVER PAYS A DOCTOR FOR A BOOKING WITH THEMSELVES ***', async () => {
      const { service, repo } = build({
        repo: { findActiveAttribution: jest.fn().mockResolvedValue({ partnerId: PARTNER }) },
      });

      const result = await service.recordLinkOnlyCommissionForPatient({
        patientId: 'p-1',
        doctorId: DOCTOR,
        consultationId: 'consult-1',
        paymentId: 'pay-1',
        capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }],
      });

      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('records a `link`-sourced commission for a booking with a different doctor', async () => {
      const { service, repo } = build({
        repo: { findActiveAttribution: jest.fn().mockResolvedValue({ partnerId: PARTNER }) },
      });

      await service.recordLinkOnlyCommissionForPatient({
        patientId: 'p-1',
        doctorId: 'another-doctor',
        consultationId: 'consult-1',
        paymentId: 'pay-1',
        capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }],
      });

      expect(repo.insertCommissionIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ attributionSource: 'link', redemptionId: null, baseAmount: '100.00' }),
        expect.anything(),
      );
    });

    it('skips with a logged warning when no convenience fee is supplied, rather than guessing a base', async () => {
      const { service, repo } = build({
        repo: { findActiveAttribution: jest.fn().mockResolvedValue({ partnerId: PARTNER }) },
      });
      const result = await service.recordLinkOnlyCommissionForPatient({
        patientId: 'p-1',
        doctorId: 'another-doctor',
        consultationId: 'consult-1',
        paymentId: 'pay-1',
      });
      expect(result).toBeNull();
      expect(repo.insertCommissionIfAbsent).not.toHaveBeenCalled();
    });

    it('does nothing when the patient carries no attribution at all', async () => {
      const { service } = build();
      expect(
        await service.recordLinkOnlyCommissionForPatient({
          patientId: 'p-1',
          doctorId: 'another-doctor',
          consultationId: 'consult-1',
          paymentId: 'pay-1',
          capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }],
        }),
      ).toBeNull();
    });
  });
});
