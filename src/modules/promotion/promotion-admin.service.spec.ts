import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import { PromotionAdminService, type CreateInstrumentInput } from './promotion-admin.service';

/**
 * The admin write path.
 *
 * *** THE ONE INVARIANT THIS FILE EXISTS TO PROTECT: the code written here goes
 * through the SAME normaliser the patient resolver uses. *** That is what lets
 * `discount_instruments.code` carry a plain `UNIQUE` and still match
 * case-insensitively, with no `citext` and no functional index — and if the two
 * sides ever diverge the failure is SILENT: an admin creates `SaveMe`, a patient
 * types `saveme`, and the answer is "this code cannot be used" with no error in
 * any log.
 */

function instrument(overrides: Partial<DiscountInstrumentRow> = {}): DiscountInstrumentRow {
  return {
    id: 'inst-1',
    code: 'SAVEME',
    kind: 'coupon',
    status: 'draft',
    label: 'Save me',
    description: null,
    isPubliclyListed: false,
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
    createdByAdminId: 'admin-1',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as DiscountInstrumentRow;
}

const VALID: CreateInstrumentInput = {
  code: 'SAVEME',
  kind: 'coupon',
  label: 'Save me',
  description: null,
  isPubliclyListed: false,
  valueKind: 'flat',
  flatAmount: '100.00',
  percentRate: null,
  maxDiscountAmount: null,
  minOrderAmount: '0.00',
  validFrom: null,
  validTo: null,
  maxTotalRedemptions: null,
  maxDistinctRedeemers: null,
  maxRedemptionsPerUser: 1,
  assignedPatientId: null,
};

function build(overrides: { repo?: Record<string, jest.Mock> } = {}) {
  const repo = {
    insertInstrument: jest.fn().mockImplementation(async (values: Record<string, unknown>) => instrument(values)),
    findInstrumentById: jest.fn().mockResolvedValue(instrument()),
    updateInstrument: jest.fn().mockImplementation(async (_id: string, values: Record<string, unknown>) => instrument(values)),
    updateInstrumentStatusIfIn: jest.fn().mockImplementation(async (_id: string, _from: string[], to: string) => instrument({ status: to as never })),
    listInstruments: jest.fn().mockResolvedValue([]),
    countInstruments: jest.fn().mockResolvedValue(0),
    listRedemptionsForInstrument: jest.fn().mockResolvedValue([]),
    listRedemptionsForExport: jest.fn().mockResolvedValue([]),
    countLiveRedemptions: jest.fn().mockResolvedValue(0),
    countDistinctRedeemers: jest.fn().mockResolvedValue(0),
    ...overrides.repo,
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const db = { transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) };

  const service = new PromotionAdminService(db as never, repo as never, audit as never);
  return { service, repo, audit, db };
}

describe('PromotionAdminService', () => {
  describe('createInstrument', () => {
    it('*** NORMALISES THE CODE WITH THE SAME FUNCTION THE RESOLVER USES ***', async () => {
      const { service, repo } = build();
      await service.createInstrument('admin-1', { ...VALID, code: '  save-me  ' });
      expect(repo.insertInstrument).toHaveBeenCalledWith(expect.objectContaining({ code: 'SAVEME' }), expect.anything());
    });

    it('*** IS BORN `draft`, so activating a campaign is a second, separate, audited act ***', async () => {
      const { service, repo } = build();
      await service.createInstrument('admin-1', VALID);
      expect(repo.insertInstrument).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }), expect.anything());
    });

    it('refuses a code that cannot survive normalisation, naming what is required', async () => {
      const { service, repo } = build();
      await expect(service.createInstrument('admin-1', { ...VALID, code: '!!' })).rejects.toThrow(BadRequestException);
      expect(repo.insertInstrument).not.toHaveBeenCalled();
    });

    it('reports a collision against the NORMALISED form, because that is what collided', async () => {
      // An admin who typed `SAVE-ME` needs to be told `SAVEME` is taken, not
      // that `SAVE-ME` is — otherwise they will try `SAVE.ME` next and hit the
      // same wall.
      const { service } = build({
        repo: { insertInstrument: jest.fn().mockRejectedValue({ code: '23505', constraint: 'discount_instruments_code_unique' }) },
      });
      await expect(service.createInstrument('admin-1', { ...VALID, code: 'save-me' })).rejects.toThrow(/SAVEME is already in use/);
    });

    it('records the full rule set in the audit metadata', async () => {
      const { service, audit } = build();
      await service.createInstrument('admin-1', { ...VALID, maxTotalRedemptions: 100 });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          metadata: expect.objectContaining({ code: 'SAVEME', caps: expect.objectContaining({ total: 100 }) }),
        }),
        expect.anything(),
      );
    });

    describe('value shape — discount_instruments_value_check, enforced where the message names the field', () => {
      it('*** REFUSES AN UNCAPPED PERCENTAGE ***', async () => {
        // `doctors.consultation_fee_inr` is admin-settable with no ceiling, so
        // "50% off" is an unbounded liability against a number somebody can
        // raise later.
        const { service } = build();
        await expect(
          service.createInstrument('a', { ...VALID, valueKind: 'percent', flatAmount: null, percentRate: '50', maxDiscountAmount: null }),
        ).rejects.toThrow(/maxDiscountAmount is REQUIRED/);
      });

      it('accepts a capped percentage', async () => {
        const { service, repo } = build();
        await service.createInstrument('a', {
          ...VALID,
          valueKind: 'percent',
          flatAmount: null,
          percentRate: '50',
          maxDiscountAmount: '150.00',
        });
        expect(repo.insertInstrument).toHaveBeenCalled();
      });

      it('refuses a flat instrument that also carries a rate or a cap', async () => {
        const { service } = build();
        await expect(service.createInstrument('a', { ...VALID, percentRate: '10' })).rejects.toThrow(/must not carry/);
        await expect(service.createInstrument('a', { ...VALID, maxDiscountAmount: '10.00' })).rejects.toThrow(/must not carry/);
      });

      it('refuses a rate outside (0, 100]', async () => {
        const { service } = build();
        for (const rate of ['0', '101', '-5']) {
          await expect(
            service.createInstrument('a', { ...VALID, valueKind: 'percent', flatAmount: null, percentRate: rate, maxDiscountAmount: '10.00' }),
          ).rejects.toThrow(/percentRate/);
        }
      });
    });

    describe('kind shape — the discriminator half of discount_instruments_kind_shape_check', () => {
      it('refuses a voucher with no assigned patient', async () => {
        const { service } = build();
        await expect(service.createInstrument('a', { ...VALID, kind: 'voucher' })).rejects.toThrow(/must name the patient/);
      });

      it('refuses a coupon that names one', async () => {
        const { service } = build();
        await expect(service.createInstrument('a', { ...VALID, assignedPatientId: 'p-1' })).rejects.toThrow(/kind "voucher"/);
      });
    });

    describe('cap shape', () => {
      it('*** REFUSES MORE DISTINCT PEOPLE THAN TOTAL REDEMPTIONS — an unreachable rule ***', async () => {
        const { service } = build();
        await expect(
          service.createInstrument('a', { ...VALID, maxTotalRedemptions: 10, maxDistinctRedeemers: 20 }),
        ).rejects.toThrow(/cannot exceed maxTotalRedemptions/);
      });

      it('refuses a validity window that ends before it starts', async () => {
        const { service } = build();
        await expect(
          service.createInstrument('a', {
            ...VALID,
            validFrom: new Date('2030-01-02T00:00:00Z'),
            validTo: new Date('2030-01-01T00:00:00Z'),
          }),
        ).rejects.toThrow(/validTo must be after validFrom/);
      });

      it('refuses a per-user cap below 1', async () => {
        const { service } = build();
        await expect(service.createInstrument('a', { ...VALID, maxRedemptionsPerUser: 0 })).rejects.toThrow(/at least 1/);
      });
    });
  });

  describe('updateInstrument', () => {
    it('*** DOES NOT EXPOSE THE VALUE RULES — re-pricing is a new code ***', async () => {
      // Every redemption snapshots them, so editing would not corrupt history —
      // but it WOULD mean one code was worth two different things to two
      // patients with no visible difference between them.
      const { service } = build();
      const editable = Object.keys({
        label: '',
        description: '',
        isPubliclyListed: false,
        validTo: new Date(),
        maxTotalRedemptions: 1,
        maxDistinctRedeemers: 1,
      });
      // A compile-time guarantee already, asserted here so a later widening of
      // the input type is a visible test failure.
      expect(editable).not.toContain('flatAmount');
      expect(editable).not.toContain('percentRate');
      expect(editable).not.toContain('valueKind');

      await service.updateInstrument('admin-1', 'inst-1', { label: 'New label' });
    });

    it('writes nothing and audits nothing for a no-op call', async () => {
      const { service, repo, audit } = build();
      await service.updateInstrument('admin-1', 'inst-1', {});
      expect(repo.updateInstrument).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('refuses to edit an ARCHIVED instrument, which is terminal', async () => {
      const { service } = build({ repo: { findInstrumentById: jest.fn().mockResolvedValue(instrument({ status: 'archived' })) } });
      await expect(service.updateInstrument('admin-1', 'inst-1', { label: 'x' })).rejects.toThrow(ConflictException);
    });

    it('audits BEFORE and AFTER', async () => {
      const { service, audit } = build();
      await service.updateInstrument('admin-1', 'inst-1', { label: 'Renamed' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            before: expect.objectContaining({ label: 'Save me' }),
            after: expect.objectContaining({ label: 'Renamed' }),
          }),
        }),
        expect.anything(),
      );
    });

    it('404s on an instrument that does not exist', async () => {
      const { service } = build({ repo: { findInstrumentById: jest.fn().mockResolvedValue(null) } });
      await expect(service.updateInstrument('admin-1', 'nope', { label: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('setInstrumentStatus', () => {
    it('is a no-op when the status is already what was asked for', async () => {
      const { service, repo } = build({ repo: { findInstrumentById: jest.fn().mockResolvedValue(instrument({ status: 'active' })) } });
      await service.setInstrumentStatus('admin-1', 'inst-1', 'active');
      expect(repo.updateInstrumentStatusIfIn).not.toHaveBeenCalled();
    });

    it('*** REFUSES TO REACTIVATE AN ARCHIVED INSTRUMENT — archived is terminal ***', async () => {
      const { service } = build({ repo: { findInstrumentById: jest.fn().mockResolvedValue(instrument({ status: 'archived' })) } });
      await expect(service.setInstrumentStatus('admin-1', 'inst-1', 'active')).rejects.toThrow(/terminal/);
    });

    it('records that LIVE RESERVATIONS ARE UNAFFECTED by a pause', async () => {
      // Pausing stops NEW redemptions; it does not repudiate quoted ones. The
      // patient has been shown a price and may be at the gateway. Stated on the
      // audit row so an auditor does not have to infer it.
      const { service, audit } = build();
      await service.setInstrumentStatus('admin-1', 'inst-1', 'paused');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ change: 'status', after: 'paused', liveReservationsUnaffected: true }),
        }),
        expect.anything(),
      );
    });
  });

  describe('listing and reporting', () => {
    it('normalises a code filter, so an admin searching `save-me` finds `SAVEME`', async () => {
      const { service, repo } = build();
      await service.listInstruments({ code: 'save-me', limit: 10, offset: 0 });
      expect(repo.listInstruments).toHaveBeenCalledWith(expect.objectContaining({ code: 'SAVEME' }));
    });

    it('*** COUNTS the usage figures rather than reading a stored counter ***', async () => {
      // There is deliberately no `redeemed_count` column. This is a REPORT taken
      // without a lock; the caps themselves are enforced under the instrument's
      // row lock inside `PromotionService.reserve`.
      const { service, repo } = build({
        repo: {
          countLiveRedemptions: jest.fn().mockResolvedValue(7),
          countDistinctRedeemers: jest.fn().mockResolvedValue(5),
        },
      });

      const summary = await service.getInstrument('inst-1');
      expect(summary).toMatchObject({ redeemedCount: 7, distinctRedeemerCount: 5 });
      expect(repo.countLiveRedemptions).toHaveBeenCalledWith('inst-1');
    });

    it('skips the count on a freshly created instrument, which cannot have redemptions yet', async () => {
      const { service, repo } = build();
      const summary = await service.createInstrument('admin-1', VALID);
      expect(summary).toMatchObject({ redeemedCount: 0, distinctRedeemerCount: 0 });
      expect(repo.countLiveRedemptions).not.toHaveBeenCalled();
    });
  });

  describe('exportRedemptionsCsv', () => {
    it('*** AUDITS THE EXPORT ITSELF ***', async () => {
      // A bulk extract of who redeemed what is exactly the act an auditor would
      // want a record of.
      const { service, audit } = build();
      await service.exportRedemptionsCsv('admin-1', {});
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'read', entityType: 'promotion_export', metadata: expect.objectContaining({ rowCount: 0 }) }),
      );
    });

    it('*** DEFUSES CSV FORMULA INJECTION in a human-typed field ***', async () => {
      // A coupon label is typed by a human into an admin form and opened in
      // Excel by another human. A leading `=` is a FORMULA to both Excel and
      // Sheets.
      const { service } = build({
        repo: {
          listRedemptionsForExport: jest.fn().mockResolvedValue([
            {
              id: 'r1',
              instrumentId: 'i1',
              patientId: 'p1',
              consultationId: 'c1',
              paymentId: null,
              status: 'consumed',
              valueKind: 'flat',
              discountableBase: '100.00',
              discountAmount: '10.00',
              currency: 'INR',
              capturedConsultationFee: null,
              capturedConvenienceFee: null,
              affiliatePartnerId: null,
              attributionSource: '=HYPERLINK("http://evil","click")',
              createdAt: new Date('2020-01-01T00:00:00Z'),
              consumedAt: null,
              releasedAt: null,
              releaseReason: null,
            },
          ]),
        },
      });

      const { content } = await service.exportRedemptionsCsv('admin-1', {});
      expect(content).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    });

    it('names the file with a date stamp and caps the row count', async () => {
      const { service, repo } = build();
      const result = await service.exportRedemptionsCsv('admin-1', {});
      expect(result.filename).toMatch(/^discount-redemptions-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(repo.listRedemptionsForExport).toHaveBeenCalledWith(expect.objectContaining({ limit: 50_000 }));
    });
  });
});
