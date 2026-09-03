/**
 * `PricingService` — the quote lifecycle, the place-of-supply decision, and the
 * discount port's failure behaviour.
 *
 * `new PricingService(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`. The ARITHMETIC is not re-tested here — it is
 * proved in `pricing.engine.spec.ts`, where it is testable as arithmetic; this
 * spec is about what the service does around it.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PriceQuoteRepository } from './price-quote.repository';
import type { PricingConfigService } from './pricing-config.service';
import type { DiscountPort } from './pricing-discount.contract';
import type { PricingDocumentRepository } from './pricing-document.repository';
import { PricingService } from './pricing.service';
import {
  PRICING_DEFAULT_COMPONENTS,
  PRICING_DEFAULT_QUOTE_TTL_MINUTES,
  PRICING_DEFAULT_TAX_PROFILE,
} from './pricing.constants';

describe('PricingService', () => {
  let quotes: jest.Mocked<PriceQuoteRepository>;
  let documents: jest.Mocked<PricingDocumentRepository>;
  let config: jest.Mocked<PricingConfigService>;
  let discounts: jest.Mocked<DiscountPort>;
  let audit: jest.Mocked<AuditService>;
  let service: PricingService;

  beforeEach(() => {
    quotes = {
      insertQuote: jest.fn().mockImplementation(async (quote) => ({ quote: { id: 'q1', ...quote }, components: [] })),
      findById: jest.fn().mockResolvedValue(null),
      findComponents: jest.fn().mockResolvedValue([]),
      findTotalsByIds: jest.fn().mockResolvedValue(new Map()),
      pinIfDraft: jest.fn(),
      markConsumedIfPinned: jest.fn().mockResolvedValue(1),
      abandonIfOpen: jest.fn().mockResolvedValue(1),
      findLatestByConsultationId: jest.fn().mockResolvedValue(null),
      findStaleDraftsHoldingReservations: jest.fn().mockResolvedValue([]),
      expireStaleDraftsWithoutReservations: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<PriceQuoteRepository>;

    documents = {
      allocate: jest.fn().mockResolvedValue('INV/2026-27/000001'),
      withTransaction: jest.fn().mockImplementation(async (work) => work({} as never)),
      peek: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<PricingDocumentRepository>;

    config = {
      getResolved: jest.fn().mockResolvedValue({
        components: [...PRICING_DEFAULT_COMPONENTS],
        taxProfile: { ...PRICING_DEFAULT_TAX_PROFILE },
        quoteTtlMinutes: PRICING_DEFAULT_QUOTE_TTL_MINUTES,
        componentsFellBack: false,
        taxProfileFellBack: false,
      }),
      hasCatalogue: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PricingConfigService>;

    discounts = {
      preview: jest.fn(),
      reserve: jest.fn(),
      confirm: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
      getForConsultation: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<DiscountPort>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    service = new PricingService({} as Database, quotes, documents, config, discounts, audit);
  });

  /* ================================================================== */
  /* preview                                                             */
  /* ================================================================== */

  describe('preview', () => {
    /** The seeded catalogue: doctor fee exempt, convenience fee taxable at 18%. */
    it('prices the seeded default at 618.00 and persists nothing', async () => {
      const view = await service.preview({ consultationFeeInr: '500.00' });

      expect(view.totalPayable).toBe('618.00');
      expect(view.taxableTotal).toBe('600.00');
      expect(view.quoteId).toBeNull();
      expect(view.expiresAt).toBeNull();
      expect(quotes.insertQuote).not.toHaveBeenCalled();
    });

    /** FR-7.4, carried on the live view where the engine knows the payee. */
    it('reports the doctor payout and a zero platform deduction', async () => {
      const view = await service.preview({ consultationFeeInr: '500.00' });
      expect(view.doctorPayout).toBe('500.00');
      expect(view.platformDeduction).toBe('0.00');
    });
  });

  /* ================================================================== */
  /* Place of supply                                                     */
  /* ================================================================== */

  describe('place of supply', () => {
    /**
     * *** THE DEFAULT IS THE ORG'S OWN STATE, AND THAT IS THE LEGALLY
     * CONSERVATIVE CHOICE. *** It yields CGST+SGST and never a wrongly-claimed
     * IGST. Charging CGST+SGST where IGST was due is a misallocation corrected
     * by amending a return; claiming an inter-state supply that did not happen
     * is the worse error to have to explain.
     */
    it('defaults to the supplier’s own state, giving CGST + SGST', async () => {
      const view = await service.preview({ consultationFeeInr: '500.00' });

      expect(view.placeOfSupply.stateCode).toBe(PRICING_DEFAULT_TAX_PROFILE.registeredStateCode);
      expect(view.placeOfSupply.kind).toBe('intra_state');
      expect(view.cgstTotal).toBe('9.00');
      expect(view.sgstTotal).toBe('9.00');
      expect(view.igstTotal).toBe('0.00');
    });

    it('charges IGST for a different state, and records it', async () => {
      const view = await service.preview({ consultationFeeInr: '500.00', placeOfSupplyStateCode: '29' });

      expect(view.placeOfSupply.stateCode).toBe('29');
      expect(view.placeOfSupply.stateName).toBe('Karnataka');
      expect(view.placeOfSupply.kind).toBe('inter_state');
      expect(view.igstTotal).toBe('18.00');
      expect(view.cgstTotal).toBe('0.00');
      expect(view.sgstTotal).toBe('0.00');
      // Either way the patient pays the same total.
      expect(view.totalPayable).toBe('618.00');
    });

    /**
     * *** AN EXPLICIT BAD CODE IS REFUSED, NEVER DEFAULTED. *** Silently
     * substituting a different state would change the tax on the bill without
     * telling anyone. `99` (Centre Jurisdiction) is a real GSTIN prefix and the
     * code an admin would most plausibly invent.
     */
    it('refuses a state code the GST portal does not issue as a place of supply', async () => {
      await expect(
        service.preview({ consultationFeeInr: '500.00', placeOfSupplyStateCode: '99' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.preview({ consultationFeeInr: '500.00', placeOfSupplyStateCode: '75' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /** The pincode is RECORDED and never consulted — a postal circle is not a state boundary. */
    it('records a pincode without letting it decide the tax', async () => {
      // 560001 is Bengaluru (Karnataka, 29) — but the state code says 27, and
      // the state code is what decides.
      const view = await service.preview({
        consultationFeeInr: '500.00',
        placeOfSupplyStateCode: '27',
        placeOfSupplyPincode: '560001',
      });

      expect(view.placeOfSupply.pincode).toBe('560001');
      expect(view.placeOfSupply.stateCode).toBe('27');
      expect(view.placeOfSupply.kind).toBe('intra_state');
    });
  });

  /* ================================================================== */
  /* The discount port                                                   */
  /* ================================================================== */

  describe('the discount port is NOT load-bearing', () => {
    /**
     * *** A PROMOTIONS FAILURE IS "NO COUPON", NEVER "CHECKOUT IS DOWN". ***
     * That asymmetry with `UnavailableBookingPaymentProvider` — which throws a
     * 503 on every call — is deliberate: payment is load-bearing for checkout
     * and discounts are not.
     */
    it('prices the bill normally when the port THROWS', async () => {
      discounts.preview.mockRejectedValue(new Error('promotions is down'));

      const view = await service.preview({
        consultationFeeInr: '500.00',
        discountCode: 'WELCOME20',
        patientId: 'pat1',
      });

      expect(view.totalPayable).toBe('618.00');
      expect(view.discount).toMatchObject({ applied: false, reason: 'UNAVAILABLE' });
    });

    it('prices the bill normally when the port REFUSES', async () => {
      discounts.preview.mockResolvedValue({
        applicable: false,
        reason: 'MIN_ORDER_NOT_MET',
        message: 'Spend 800.00 to use this code.',
        requiredMinOrder: '800.00',
      });

      const view = await service.preview({
        consultationFeeInr: '500.00',
        discountCode: 'WELCOME20',
        patientId: 'pat1',
      });

      expect(view.totalPayable).toBe('618.00');
      expect(view.discount).toMatchObject({ applied: false, reason: 'MIN_ORDER_NOT_MET' });
    });

    /**
     * *** THE BASE HANDED TO THE PORT IS THE WHOLE ORDER'S GROSS. ***
     * 600.00, not the 100.00 convenience fee — otherwise every sensible
     * minimum-order rule would be unsatisfiable. See
     * `pricing-discount.contract.ts`.
     */
    it('names the whole order’s gross as the discountable base, with every component pre-discount and pre-tax', async () => {
      discounts.preview.mockResolvedValue({
        applicable: false,
        reason: 'CODE_NOT_USABLE',
        message: 'no',
      });

      await service.preview({ consultationFeeInr: '500.00', discountCode: 'X', patientId: 'pat1' });

      expect(discounts.preview).toHaveBeenCalledWith(
        'X',
        expect.objectContaining({
          discountableAmount: '600.00',
          components: [
            { code: 'doctor_fee', label: 'Doctor consultation fee', grossAmount: '500.00' },
            { code: 'convenience_fee', label: 'Convenience fee', grossAmount: '100.00' },
          ],
        }),
      );
    });

    /**
     * *** THE DISCOUNT COMES OFF THE CONVENIENCE FEE, NEVER THE DOCTOR'S FEE. ***
     * FR-7.4 promises the doctor the full fee with zero deduction.
     */
    it('places a discount on the platform’s line and leaves the payout intact', async () => {
      discounts.preview.mockResolvedValue({
        applicable: true,
        instrumentId: 'i1',
        kind: 'coupon',
        code: 'SAVE50',
        label: '50 off',
        discountAmount: '50.00',
        residualDiscountable: '550.00',
        attributionOnly: false,
        fullyDiscounted: false,
      });

      const view = await service.preview({
        consultationFeeInr: '500.00',
        discountCode: 'SAVE50',
        patientId: 'pat1',
      });

      expect(view.doctorPayout).toBe('500.00');
      expect(view.platformDeduction).toBe('0.00');
      expect(view.components[0].discountAmount).toBe('0.00');
      expect(view.components[1].discountAmount).toBe('50.00');
      expect(view.components[1].discountBearer).toBe('platform');
      // 500 exempt + (100 - 50) taxed at 18% = 559.00.
      expect(view.totalPayable).toBe('559.00');
    });

    /**
     * The overflow case is ORDINARY, not exotic: 20% of the 600.00 base is
     * 120.00 against a 100.00 convenience fee. The checkout must show the CAPPED
     * figure rather than the promised one.
     */
    it('caps a discount at what the platform lines can bear and reports the shortfall', async () => {
      discounts.preview.mockResolvedValue({
        applicable: true,
        instrumentId: 'i1',
        kind: 'coupon',
        code: 'TWENTY',
        label: '20% off',
        discountAmount: '120.00',
        residualDiscountable: '480.00',
        attributionOnly: false,
        fullyDiscounted: false,
      });

      const view = await service.preview({
        consultationFeeInr: '500.00',
        discountCode: 'TWENTY',
        patientId: 'pat1',
      });

      expect(view.discount?.amount).toBe('100.00');
      expect(view.discount?.cappedAmount).toBe('20.00');
      expect(view.doctorPayout).toBe('500.00');
      expect(view.totalPayable).toBe('500.00');
    });

    it('does not consult the port at all when no code is offered', async () => {
      await service.preview({ consultationFeeInr: '500.00', patientId: 'pat1' });
      expect(discounts.preview).not.toHaveBeenCalled();
      expect(discounts.reserve).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* pin                                                                 */
  /* ================================================================== */

  describe('pin — the price is frozen by ONE conditional UPDATE', () => {
    /**
     * *** NOBODY NEEDS A TIMER FOR CORRECTNESS. *** Expiry is checked inside the
     * statement, against the database's clock. Zero rows matched means the quote
     * was not a live draft, and the caller re-quotes.
     */
    it('reports PRICING_QUOTE_EXPIRED when the conditional UPDATE matches nothing', async () => {
      quotes.pinIfDraft.mockResolvedValue(null);
      quotes.findById.mockResolvedValue({ id: 'q1', status: 'expired' } as never);

      await expect(service.pin({ quoteId: 'q1', consultationId: 'c1' })).rejects.toMatchObject({
        response: { code: 'PRICING_QUOTE_EXPIRED' },
      });
    });

    it('distinguishes a quote that never existed from one that went stale', async () => {
      quotes.pinIfDraft.mockResolvedValue(null);
      quotes.findById.mockResolvedValue(null);

      await expect(service.pin({ quoteId: 'q1', consultationId: 'c1' })).rejects.toMatchObject({
        response: { code: 'PRICING_QUOTE_NOT_FOUND' },
      });
    });

    it('attaches the consultation as it pins', async () => {
      quotes.pinIfDraft.mockResolvedValue({
        id: 'q1',
        status: 'pinned',
        discountCode: null,
        totalPayable: '618.00',
        placeOfSupplyStateCode: '27',
        placeOfSupplyKind: 'intra_state',
        supplierStateCode: '27',
        supplierGstin: null,
        currency: 'INR',
        grossTotal: '600.00',
        discountTotal: '0.00',
        taxableTotal: '600.00',
        cgstTotal: '9.00',
        sgstTotal: '9.00',
        igstTotal: '0.00',
        discountId: null,
        discountLabel: null,
        placeOfSupplyPincode: null,
        expiresAt: new Date(),
      } as never);

      const view = await service.pin({ quoteId: 'q1', consultationId: 'c1' });

      expect(quotes.pinIfDraft).toHaveBeenCalledWith('q1', { consultationId: 'c1', patientId: null });
      expect(view.totalPayable).toBe('618.00');
    });
  });

  /* ================================================================== */
  /* markConsumed / abandon                                              */
  /* ================================================================== */

  describe('markConsumed', () => {
    it('confirms the discount and reports the change', async () => {
      const result = await service.markConsumed({ quoteId: 'q1', consultationId: 'c1', paymentId: 'p1' });

      expect(result.changed).toBe(true);
      expect(discounts.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: 'c1', paymentId: 'p1' }),
      );
    });

    /** Idempotent: a replayed capture webhook updates zero rows and confirms nothing again. */
    it('is a no-op on a replayed capture', async () => {
      quotes.markConsumedIfPinned.mockResolvedValue(0);

      const result = await service.markConsumed({ quoteId: 'q1', consultationId: 'c1', paymentId: 'p1' });

      expect(result.changed).toBe(false);
      expect(discounts.confirm).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    /**
     * *** THE COMMISSION-BASE CONVENTION. THIS WAS A REAL BUG. ***
     *
     * The seam carries ONE amount per component, so it can carry only one
     * convention, and promotions reads it as GROSS — pre-discount, pre-tax.
     * Passing `lineTotal` instead (taxable value plus tax, already net of the
     * discount) was wrong twice over: it put GST into the affiliate commission
     * base, which promotions' own util states must never happen, and it let
     * `net_platform_margin` subtract the discount a SECOND time, because that
     * base is the convenience fee LESS the discount and promotions applies that
     * subtraction itself.
     *
     * With a 100.00 convenience fee, an 18% GST and a 50.00 discount, the three
     * candidate figures are 100.00 (gross), 50.00 (taxable) and 59.00
     * (lineTotal). Only gross lets promotions arrive at the correct 50.00 base.
     */
    it('passes each component GROSS — never lineTotal, which would tax the commission base', async () => {
      // Only the four money columns matter here; the rest of the row is noise.
      quotes.findComponents.mockResolvedValue([
        { code: 'convenience_fee', grossAmount: '100.00', discountAmount: '50.00', taxableValue: '50.00', lineTotal: '59.00' },
      ] as unknown as Awaited<ReturnType<typeof quotes.findComponents>>);

      await service.markConsumed({ quoteId: 'q1', consultationId: 'c1', paymentId: 'p1' });

      expect(discounts.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          capturedComponents: [{ code: 'convenience_fee', amount: '100.00' }],
        }),
      );
    });

    it('does not leak a tax-inclusive or discounted figure into the commission base', async () => {
      // Only the four money columns matter here; the rest of the row is noise.
      quotes.findComponents.mockResolvedValue([
        { code: 'convenience_fee', grossAmount: '100.00', discountAmount: '50.00', taxableValue: '50.00', lineTotal: '59.00' },
      ] as unknown as Awaited<ReturnType<typeof quotes.findComponents>>);

      await service.markConsumed({ quoteId: 'q1', consultationId: 'c1', paymentId: 'p1' });

      const sent = (
        discounts.confirm.mock.calls[0][0] as unknown as {
          capturedComponents: ReadonlyArray<{ amount: string }>;
        }
      ).capturedComponents;
      expect(sent.map((c) => c.amount)).not.toContain('59.00'); // lineTotal — carries GST
      expect(sent.map((c) => c.amount)).not.toContain('50.00'); // taxableValue — already net
    });

    /** The money is already captured; a promotions failure must not rewrite that outcome. */
    it('still reports success when confirming the discount throws', async () => {
      discounts.confirm.mockRejectedValue(new Error('promotions is down'));

      const result = await service.markConsumed({ quoteId: 'q1', consultationId: 'c1', paymentId: 'p1' });

      expect(result.changed).toBe(true);
    });
  });

  describe('abandon', () => {
    it('releases the discount reservation', async () => {
      await service.abandon({ quoteId: 'q1', consultationId: 'c1', reason: 'checkout_abandoned' });

      expect(quotes.abandonIfOpen).toHaveBeenCalledWith('q1', 'expired');
      expect(discounts.release).toHaveBeenCalledWith({
        consultationId: 'c1',
        reason: 'checkout_abandoned',
      });
    });

    /** A re-priced quote is `superseded`, not `expired` — a finance query asks which. */
    it('records a supersession distinctly from an expiry', async () => {
      await service.abandon({
        quoteId: 'q1',
        consultationId: 'c1',
        reason: 'repriced',
        status: 'superseded',
      });
      expect(quotes.abandonIfOpen).toHaveBeenCalledWith('q1', 'superseded');
    });

    /** Still releases the coupon even if the quote had already been taken out of play. */
    it('releases the reservation even when the status move matched nothing', async () => {
      quotes.abandonIfOpen.mockResolvedValue(0);

      const result = await service.abandon({ quoteId: 'q1', consultationId: 'c1', reason: 'x' });

      expect(result.changed).toBe(false);
      expect(discounts.release).toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* Document serials                                                    */
  /* ================================================================== */

  describe('document serials', () => {
    it('allocates an invoice number under a transaction and audits it', async () => {
      const result = await service.allocateInvoiceNumber(new Date('2026-06-01T00:00:00Z'));

      expect(result.number).toBe('INV/2026-27/000001');
      expect(documents.allocate).toHaveBeenCalledWith('INV', '2026-27', expect.anything());
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'pricing_document_serial', entityId: 'INV/2026-27/000001' }),
      );
    });

    it('uses the CRN series for a credit note', async () => {
      documents.allocate.mockResolvedValue('CRN/2026-27/000001');
      const result = await service.allocateCreditNoteNumber(new Date('2026-06-01T00:00:00Z'));

      expect(result.number).toBe('CRN/2026-27/000001');
      expect(documents.allocate).toHaveBeenCalledWith('CRN', '2026-27', expect.anything());
    });
  });

  /* ================================================================== */
  /* getQuoteTotals                                                      */
  /* ================================================================== */

  describe('getQuoteTotals — what collapsed the four re-derivations', () => {
    it('returns a map of quote id to its authoritative total', async () => {
      quotes.findTotalsByIds.mockResolvedValue(new Map([['q1', '618.00']]));
      expect(await service.getQuoteTotals(['q1'])).toEqual({ q1: '618.00' });
    });

    /**
     * A missing id is simply ABSENT from the map. The caller
     * (`capturedTotalPaise`) then throws rather than falling back to
     * re-deriving, which is the whole point.
     */
    it('omits an id that does not exist rather than inventing a total', async () => {
      quotes.findTotalsByIds.mockResolvedValue(new Map());
      expect(await service.getQuoteTotals(['missing'])).toEqual({});
    });
  });
});
