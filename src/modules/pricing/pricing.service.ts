import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { NewPriceQuoteComponentRow } from '../../schema/price-quote-components.schema';
import { AuditService } from '../../shared/audit/audit.service';
import {
  basisPointsToPct,
  MoneyFormatError,
  paiseToRupees,
  rupeesToPaise,
} from '../../shared/money/money.util';
import { PriceQuoteRepository } from './price-quote.repository';
import { PricingConfigService } from './pricing-config.service';
import {
  DISCOUNT_PORT,
  type DiscountOrderContext,
  type DiscountPort,
} from './pricing-discount.contract';
import { financialYearFor, PricingDocumentRepository } from './pricing-document.repository';
import { isSelectableGstStateCode } from './pricing-gst.constants';
import { priceQuote, PricingEngineError, type PricedQuote } from './pricing.engine';
import { toQuoteView, toQuoteViewFromRows } from './pricing.mapper';
import type { DiscountView, PriceQuoteView, QuoteRequest } from './pricing.contract';
import {
  PRICING_AUDIT_ENTITY_TYPES,
  PRICING_DEFAULT_CURRENCY,
  PRICING_DOCUMENT_SERIES,
  PRICING_ERROR_CODES,
  placeOfSupplyKindFor,
  type PricingTaxProfile,
} from './pricing.constants';

/**
 * M-12.5's core: pricing a bill, freezing it, and the document serials that hang
 * off it.
 *
 * ── THE LIFECYCLE, AND WHY IT EXISTS ───────────────────────────────────────
 *
 *   draft -> pinned -> consumed, plus terminal `expired` / `superseded`.
 *
 * *** RAZORPAY FIXES AN ORDER'S AMOUNT AT CREATION. *** That single fact drives
 * the whole design: the price must be decided and FROZEN before the order
 * exists, because afterwards it cannot change. A `draft` is a price offered; a
 * `pinned` quote is a price committed to, with a gateway order about to be
 * created for exactly that number; `consumed` is one that was paid.
 *
 * ── *** NOBODY NEEDS A TIMER FOR CORRECTNESS. *** ──────────────────────────
 *
 * Expiry is enforced inside `pin`'s own conditional UPDATE
 * (`... AND expires_at > now()`), evaluated against the DATABASE's clock. A
 * stale quote cannot be pinned whether or not a sweep has run, whether or not
 * two processes' clocks agree, and whether or not two callers raced. The sweep
 * (`pricing-quote-sweep.service.ts`) exists for one narrower reason: releasing
 * the discount reservations that stale drafts are still holding.
 *
 * ── THE DISCOUNT PORT IS NOT LOAD-BEARING ──────────────────────────────────
 *
 * Every call into `DISCOUNT_PORT` is wrapped. A promotions module that is
 * missing, slow or broken must degrade to "no coupon", never to "checkout is
 * down" — see `unavailable-discount.provider.ts` on why that asymmetry with
 * `UnavailableBookingPaymentProvider` is deliberate. A throw from the port is
 * caught here and turned into a refusal, exactly as an unusable code would be.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly quotes: PriceQuoteRepository,
    private readonly documents: PricingDocumentRepository,
    private readonly config: PricingConfigService,
    @Inject(DISCOUNT_PORT) private readonly discounts: DiscountPort,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Pricing                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Prices a bill WITHOUT persisting anything. Nothing is reserved and nothing expires. */
  async preview(request: QuoteRequest): Promise<PriceQuoteView> {
    const resolved = await this.resolveAndPrice(request, { reserve: false });

    return toQuoteView({
      priced: resolved.priced,
      quoteId: null,
      status: null,
      currency: PRICING_DEFAULT_CURRENCY,
      placeOfSupplyStateCode: resolved.placeOfSupplyStateCode,
      placeOfSupplyPincode: request.placeOfSupplyPincode ?? null,
      supplier: resolved.taxProfile,
      discount: resolved.discount,
      expiresAt: null,
    });
  }

  /**
   * Prices a bill and writes it as a `draft`.
   *
   * *** THE DISCOUNT IS RESERVED ONLY WHEN A CONSULTATION ALREADY EXISTS. ***
   * `DiscountPort.reserve` keys on `consultationId`, and
   * `price_quotes.consultation_id` is documented as "Null until the quote is
   * pinned — a price is quoted before a consultation exists". So a quote raised
   * before booking EVALUATES the code (`preview`) and the reservation is taken at
   * `pin`, which always has a consultation. Both paths converge, and a draft with
   * no consultation holds nothing that would need releasing.
   */
  async createQuote(request: QuoteRequest): Promise<PriceQuoteView> {
    const consultationId = request.consultationId ?? null;
    const resolved = await this.resolveAndPrice(request, {
      reserve: consultationId !== null,
      consultationId,
    });

    const written = await this.writeQuote(request, resolved, consultationId);

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: PRICING_AUDIT_ENTITY_TYPES.QUOTE,
      entityId: written.quoteId,
      consultationId: consultationId ?? undefined,
      metadata: {
        totalPayable: paiseToRupees(resolved.priced.totalPayablePaise),
        placeOfSupply: resolved.placeOfSupplyStateCode,
        placeOfSupplyKind: resolved.priced.placeOfSupplyKind,
        discountCode: resolved.discount?.code ?? null,
        discountAmount: resolved.discount?.amount ?? null,
        discountCapped: resolved.discount?.cappedAmount ?? null,
      },
    });

    return written.view;
  }

  /**
   * *** FREEZES THE PRICE. ONE CONDITIONAL UPDATE. ***
   *
   * `SET status='pinned' WHERE id=$1 AND status='draft' AND expires_at > now()`.
   * Zero rows -> `PRICING_QUOTE_EXPIRED`, and the caller re-quotes.
   *
   * Deliberately NOT a read-then-write: two concurrent pins would both read
   * `draft` and both proceed, and the second would attach a second consultation
   * to one frozen price. The guard has to live in the WHERE clause.
   */
  async pin(input: { quoteId: string; consultationId: string; patientId?: string | null }): Promise<PriceQuoteView> {
    const pinned = await this.quotes.pinIfDraft(input.quoteId, {
      consultationId: input.consultationId,
      patientId: input.patientId ?? null,
    });

    if (!pinned) {
      // Either it was not a draft (already pinned, consumed, expired or
      // superseded) or its `expires_at` had passed. One code for both: from the
      // caller's side they are the same event, and telling them apart would need
      // a second read that could itself be stale by the time it returned.
      const exists = await this.quotes.findById(input.quoteId);
      if (!exists) {
        throw new NotFoundException({
          code: PRICING_ERROR_CODES.PRICING_QUOTE_NOT_FOUND,
          message: 'That price quote does not exist.',
        });
      }
      throw new ConflictException({
        code: PRICING_ERROR_CODES.PRICING_QUOTE_EXPIRED,
        message: 'That price is no longer available. Please refresh to see the current price.',
      });
    }

    // *** THE RESERVATION IS TAKEN HERE FOR A QUOTE THAT HAD NO CONSULTATION. ***
    // See `createQuote`. Best-effort by construction: the price is already frozen
    // and the patient is about to pay it, so a promotions outage must not undo a
    // committed price. The discount was already priced in at `createQuote` time.
    if (pinned.discountCode !== null) {
      await this.tryReserveForPinned(pinned.id, input.consultationId, pinned.discountCode, pinned.expiresAt);
    }

    const components = await this.quotes.findComponents(pinned.id);
    return toQuoteViewFromRows(pinned, components);
  }

  /**
   * Prices, persists and pins in one call.
   *
   * *** A SUPPORTED PATH, NOT A DEGRADED ONE. *** It is how
   * `createOrderForConsultation` guarantees that NO CALL SITE CAN PRODUCE AN
   * UNPRICED PAYMENT: a caller with no quote gets one made for it, from the fee
   * it supplied plus the org's own registered state as the place of supply.
   *
   * That default is also the legally conservative one — it yields CGST+SGST and
   * never a wrongly-claimed IGST. See `PricingTaxProfile`.
   */
  async materialiseAndPin(request: QuoteRequest & { consultationId: string }): Promise<PriceQuoteView> {
    const draft = await this.createQuote(request);
    if (draft.quoteId === null) {
      // Unreachable — `createQuote` always persists.
      throw new ConflictException({
        code: PRICING_ERROR_CODES.PRICING_QUOTE_NOT_FOUND,
        message: 'The quote could not be created.',
      });
    }
    return this.pin({
      quoteId: draft.quoteId,
      consultationId: request.consultationId,
      patientId: request.patientId ?? null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async getQuote(quoteId: string): Promise<PriceQuoteView | null> {
    const quote = await this.quotes.findById(quoteId);
    if (!quote) return null;
    const components = await this.quotes.findComponents(quoteId);
    return toQuoteViewFromRows(quote, components);
  }

  /**
   * *** THE AUTHORITATIVE CAPTURED TOTALS. ***
   *
   * The one query behind `capturedTotalPaise` in `modules/payment`, which
   * collapsed four separate re-derivations of "what was this payment billed"
   * onto a single helper. A quote id that is absent from the returned map does
   * not exist — and the caller must treat that as an ERROR rather than falling
   * back to recomputing, because recomputing a quoted payment with
   * `calculateBill` is exactly the divergence this module exists to prevent.
   */
  async getQuoteTotals(quoteIds: readonly string[]): Promise<Record<string, string>> {
    const totals = await this.quotes.findTotalsByIds(quoteIds);
    return Object.fromEntries(totals);
  }

  async hasCatalogue(): Promise<boolean> {
    return this.config.hasCatalogue();
  }

  /**
   * ADDITIVE (M-21/data rights execution): the `price_quotes`/
   * `price_quote_components` half of `PricingContract
   * #countDataRightsRowsForPatient` — a READ-ONLY row count for a patient's
   * approved data-deletion request. `refund_components`, the third table
   * this contract method reports, is `PricingRefundService
   * #countRefundComponentsForConsultations`'s job instead — see
   * `PricingFacade#countDataRightsRowsForPatient` for where the two are
   * combined.
   */
  async countPriceQuoteRowsForPatient(patientId: string): Promise<{ priceQuotes: number; priceQuoteComponents: number }> {
    const [priceQuotes, priceQuoteComponents] = await Promise.all([
      this.quotes.countByPatientId(patientId),
      this.quotes.countComponentsByPatientId(patientId),
    ]);
    return { priceQuotes, priceQuoteComponents };
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle transitions                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Capture. Marks the quote consumed and CONFIRMS the discount reservation.
   *
   * Idempotent: `markConsumedIfPinned` is guarded on `status = 'pinned'`, so a
   * replayed capture webhook updates zero rows and this returns
   * `changed: false`. The port's `confirm` is idempotent on its own side.
   */
  async markConsumed(input: {
    quoteId: string;
    consultationId: string | null;
    paymentId: string;
  }): Promise<{ changed: boolean }> {
    const rows = await this.quotes.markConsumedIfPinned(input.quoteId);

    if (rows === 0) {
      this.logger.log(`Quote ${input.quoteId} was already consumed — replayed capture is a no-op.`);
      return { changed: false };
    }

    if (input.consultationId !== null) {
      // Best-effort: the money is already captured and committed. A promotions
      // failure here must not rewrite the outcome of a payment that succeeded —
      // the same reasoning `payment-webhook.service.ts` gives for wrapping its
      // `PAYMENT_CAPTURED_EVENT` emit.
      try {
        const components = await this.quotes.findComponents(input.quoteId);
        await this.discounts.confirm({
          consultationId: input.consultationId,
          paymentId: input.paymentId,
          // *** GROSS, NOT `lineTotal`. THE CONVENTION IS LOAD-BEARING. ***
          //
          // `line_total` is taxable value PLUS tax, and it is already NET of any
          // discount. Passing it made the affiliate commission base wrong twice
          // over: it put GST INTO the base -- which promotion's own
          // `promotion-discount.util.ts` states must never happen ("GST IS NEVER
          // A BASE"; paying commission out of collected tax is not ours to do) --
          // and it let `net_platform_margin` subtract the discount a SECOND time,
          // because that base is defined as the convenience fee LESS the
          // discount and promotions applies that subtraction itself.
          //
          // `gross_amount` is pre-discount and pre-tax, which is what every one
          // of promotion's three bases actually wants:
          //     net_platform_margin  = gross - discount   (promotions subtracts)
          //     convenience_fee      = gross
          //     consultation_fee     = gross
          //
          // The frozen port carries one amount per component, so it can only
          // carry one convention; gross is the one that serves all three. Do not
          // "improve" this to a net or tax-inclusive figure without changing
          // `affiliate.service.ts#resolveBasePaise` in the same commit.
          capturedComponents: components.map((row) => ({ code: row.code, amount: row.grossAmount })),
        });
      } catch (error) {
        this.logger.error(
          `Quote ${input.quoteId} was consumed but the discount could not be confirmed: ${describeError(error)}`,
        );
      }
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PRICING_AUDIT_ENTITY_TYPES.QUOTE,
      entityId: input.quoteId,
      consultationId: input.consultationId ?? undefined,
      metadata: { transition: 'consumed', paymentId: input.paymentId },
    });

    return { changed: true };
  }

  /**
   * Failure or abandonment. Takes the quote out of play and RELEASES the
   * discount reservation, so a coupon with a per-user limit is not left burnt by
   * a checkout nobody completed.
   *
   * Guarded so it can never reverse a capture (`abandonIfOpen` matches only
   * `draft` and `pinned`).
   */
  async abandon(input: {
    quoteId: string;
    consultationId: string | null;
    reason: string;
    status?: 'expired' | 'superseded';
  }): Promise<{ changed: boolean }> {
    const status = input.status ?? 'expired';
    const rows = await this.quotes.abandonIfOpen(input.quoteId, status);

    if (input.consultationId !== null) {
      try {
        await this.discounts.release({ consultationId: input.consultationId, reason: input.reason });
      } catch (error) {
        this.logger.error(
          `Quote ${input.quoteId} was abandoned but the discount could not be released: ${describeError(error)}`,
        );
      }
    }

    if (rows > 0) {
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: PRICING_AUDIT_ENTITY_TYPES.QUOTE,
        entityId: input.quoteId,
        consultationId: input.consultationId ?? undefined,
        metadata: { transition: status, reason: input.reason },
      });
    }

    return { changed: rows > 0 };
  }

  /* ---------------------------------------------------------------------- */
  /* Document serials                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Takes the next s.31 invoice serial.
   *
   * *** ALLOCATED AT CAPTURE, NEVER AT INTENT. *** A checkout that is merely
   * started must not burn a number, because a gap in a statutory series is its
   * own compliance question.
   */
  async allocateInvoiceNumber(at: Date = new Date()): Promise<{ number: string; issuedAt: Date }> {
    return this.allocate(PRICING_DOCUMENT_SERIES.INVOICE, at);
  }

  /** Takes the next s.34 credit-note serial. Allocated when a refund reaches `processed`, never at intent. */
  async allocateCreditNoteNumber(at: Date = new Date()): Promise<{ number: string; issuedAt: Date }> {
    return this.allocate(PRICING_DOCUMENT_SERIES.CREDIT_NOTE, at);
  }

  private async allocate(
    series: (typeof PRICING_DOCUMENT_SERIES)[keyof typeof PRICING_DOCUMENT_SERIES],
    at: Date,
  ): Promise<{ number: string; issuedAt: Date }> {
    const financialYear = financialYearFor(at);
    const number = await this.documents.withTransaction((tx) => this.documents.allocate(series, financialYear, tx));

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: PRICING_AUDIT_ENTITY_TYPES.DOCUMENT_SERIAL,
      entityId: number,
      metadata: { series, financialYear, issuedAt: at.toISOString() },
    });

    return { number, issuedAt: at };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves configuration and place of supply, evaluates any discount, and
   * prices the bill.
   *
   * *** THE ENGINE RUNS TWICE, AND IT HAS TO. *** The discount port is handed
   * every component "PRE-discount and PRE-tax", which only exists once the
   * grosses have been computed — so pass one prices with no discount to build
   * that context, and pass two prices with the amount the port returned. The
   * engine is pure and cheap, and the alternative (asking the port to price
   * against a bill it has not seen) is not a thing that can be made correct.
   */
  private async resolveAndPrice(
    request: QuoteRequest,
    options: { reserve: boolean; consultationId?: string | null },
  ): Promise<{
    priced: PricedQuote;
    taxProfile: PricingTaxProfile;
    placeOfSupplyStateCode: string;
    discount: DiscountView | null;
    ttlMinutes: number;
  }> {
    const config = await this.config.getResolved();
    const consultationFeePaise = this.parseFee(request.consultationFeeInr);
    const placeOfSupplyStateCode = this.resolvePlaceOfSupply(request, config.taxProfile);
    const placeOfSupplyKind = placeOfSupplyKindFor(config.taxProfile.registeredStateCode, placeOfSupplyStateCode);

    const priceWith = (discountPaise: bigint): PricedQuote => {
      try {
        return priceQuote({
          components: config.components,
          consultationFeePaise,
          placeOfSupplyKind,
          discountPaise,
        });
      } catch (error) {
        if (error instanceof PricingEngineError) {
          // `PricingConfigService` already falls back to the compiled-in
          // catalogue for anything unusable, so reaching here means the DEFAULT
          // catalogue is broken — a code bug, not a configuration one.
          throw new BadRequestException({
            code: PRICING_ERROR_CODES.PRICING_CATALOGUE_INVALID,
            message: error.message,
          });
        }
        throw error;
      }
    };

    // PASS 1 — the pre-discount, pre-tax bill the port needs as context.
    const undiscounted = priceWith(0n);

    const evaluation = await this.evaluateDiscount({
      request,
      undiscounted,
      reserve: options.reserve,
      consultationId: options.consultationId ?? null,
      ttlMinutes: config.quoteTtlMinutes,
    });

    if (evaluation === null || !evaluation.view.applied) {
      return {
        priced: undiscounted,
        taxProfile: config.taxProfile,
        placeOfSupplyStateCode,
        discount: evaluation?.view ?? null,
        ttlMinutes: config.quoteTtlMinutes,
      };
    }

    // PASS 2 — the same catalogue, with the discount PLACED by the engine.
    const priced = priceWith(evaluation.discountPaise);

    return {
      priced,
      taxProfile: config.taxProfile,
      placeOfSupplyStateCode,
      discount: {
        ...evaluation.view,
        // What was ACTUALLY taken off, which may be less than the port promised
        // — the checkout must show this figure, not the promised one.
        amount: paiseToRupees(priced.discountTotalPaise),
        cappedAmount: paiseToRupees(priced.discountUnplacedPaise),
      },
      ttlMinutes: config.quoteTtlMinutes,
    };
  }

  /**
   * Asks the promotions port about a code, and never lets it break checkout.
   *
   * Returns `null` when no code was offered. Every failure mode — a missing
   * module, a thrown exception, a refusal — comes back as a `DiscountView` with
   * `applied: false`, which the checkout renders as "that code did not apply"
   * rather than as an outage.
   */
  private async evaluateDiscount(input: {
    request: QuoteRequest;
    undiscounted: PricedQuote;
    reserve: boolean;
    consultationId: string | null;
    ttlMinutes: number;
  }): Promise<{ view: DiscountView; discountPaise: bigint } | null> {
    const code = input.request.discountCode?.trim();
    if (!code) return null;

    if (!input.request.patientId) {
      // The port's context requires a patient; without one there is no per-user
      // limit to test and no attribution to record.
      return {
        view: refusal(code, 'CODE_NOT_USABLE', 'Sign in to use a discount code.'),
        discountPaise: 0n,
      };
    }

    const context: DiscountOrderContext = {
      patientId: input.request.patientId,
      doctorId: input.request.doctorId ?? null,
      specialtyId: input.request.specialtyId ?? null,
      components: input.undiscounted.components.map((component) => ({
        code: component.code,
        label: component.label,
        grossAmount: paiseToRupees(component.grossPaise),
      })),
      // *** THE BASE: the whole order's gross, pre-discount and pre-tax. ***
      // See `pricing-discount.contract.ts` for why it is named this way and what
      // follows from it.
      discountableAmount: paiseToRupees(input.undiscounted.discountableBasePaise),
      currency: PRICING_DEFAULT_CURRENCY,
      mode: input.request.mode ?? 'scheduled',
    };

    try {
      if (input.reserve && input.consultationId !== null) {
        const holdExpiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
        const result = await this.discounts.reserve({
          code,
          context,
          consultationId: input.consultationId,
          holdExpiresAt,
        });
        if (!result.reserved) {
          return { view: refusal(code, result.reason, result.message), discountPaise: 0n };
        }
        return {
          view: {
            applied: true,
            code: result.code,
            instrumentId: result.instrumentId,
            kind: null,
            label: null,
            amount: result.discountAmount,
            cappedAmount: '0.00',
            attributionOnly: rupeesToPaise(result.discountAmount) === 0n,
            reason: null,
            message: null,
          },
          discountPaise: rupeesToPaise(result.discountAmount),
        };
      }

      const evaluated = await this.discounts.preview(code, context);
      if (!evaluated.applicable) {
        return { view: refusal(code, evaluated.reason, evaluated.message), discountPaise: 0n };
      }
      return {
        view: {
          applied: true,
          code: evaluated.code,
          instrumentId: evaluated.instrumentId,
          kind: evaluated.kind,
          label: evaluated.label,
          amount: evaluated.discountAmount,
          cappedAmount: '0.00',
          attributionOnly: evaluated.attributionOnly,
          reason: null,
          message: null,
        },
        discountPaise: rupeesToPaise(evaluated.discountAmount),
      };
    } catch (error) {
      // *** A PROMOTIONS FAILURE IS "NO COUPON", NEVER "CHECKOUT IS DOWN". ***
      this.logger.error(`Discount code ${code} could not be evaluated: ${describeError(error)}`);
      return {
        view: refusal(code, 'UNAVAILABLE', 'Discount codes are not available at the moment.'),
        discountPaise: 0n,
      };
    }
  }

  /** Writes the draft quote and its components. */
  private async writeQuote(
    request: QuoteRequest,
    resolved: Awaited<ReturnType<PricingService['resolveAndPrice']>>,
    consultationId: string | null,
  ): Promise<{ quoteId: string; view: PriceQuoteView }> {
    const expiresAt = new Date(Date.now() + resolved.ttlMinutes * 60_000);
    const priced = resolved.priced;

    const components: Omit<NewPriceQuoteComponentRow, 'priceQuoteId'>[] = priced.components.map((component) => ({
      position: component.position,
      code: component.code,
      label: component.label,
      hsnSac: component.hsnSac,
      grossAmount: paiseToRupees(component.grossPaise),
      discountAmount: paiseToRupees(component.discountPaise),
      taxableValue: paiseToRupees(component.taxableValuePaise),
      taxTreatment: component.taxTreatment,
      taxMode: component.taxMode,
      taxRatePct: basisPointsToPct(component.taxRateBasisPoints),
      cgstAmount: paiseToRupees(component.cgstPaise),
      sgstAmount: paiseToRupees(component.sgstPaise),
      igstAmount: paiseToRupees(component.igstPaise),
      lineTotal: paiseToRupees(component.lineTotalPaise),
      discountBearer: component.discountBearer,
      basis: component.basis,
      basisPct: component.basisPct,
      basisCodes: component.basisCodes,
    }));

    const written = await this.quotes.insertQuote(
      {
        status: 'draft',
        currency: PRICING_DEFAULT_CURRENCY,
        patientId: request.patientId ?? null,
        doctorId: request.doctorId ?? null,
        specialtyId: request.specialtyId ?? null,
        consultationId,
        placeOfSupplyStateCode: resolved.placeOfSupplyStateCode,
        placeOfSupplyPincode: request.placeOfSupplyPincode ?? null,
        placeOfSupplyKind: priced.placeOfSupplyKind,
        supplierStateCode: resolved.taxProfile.registeredStateCode,
        supplierGstin: resolved.taxProfile.gstin,
        grossTotal: paiseToRupees(priced.grossTotalPaise),
        discountTotal: paiseToRupees(priced.discountTotalPaise),
        taxableTotal: paiseToRupees(priced.taxableTotalPaise),
        cgstTotal: paiseToRupees(priced.cgstTotalPaise),
        sgstTotal: paiseToRupees(priced.sgstTotalPaise),
        igstTotal: paiseToRupees(priced.igstTotalPaise),
        totalPayable: paiseToRupees(priced.totalPayablePaise),
        discountId: resolved.discount?.applied ? resolved.discount.instrumentId : null,
        discountCode: resolved.discount?.applied ? resolved.discount.code : null,
        discountLabel: resolved.discount?.applied ? resolved.discount.label : null,
        expiresAt,
      },
      components,
    );

    return {
      quoteId: written.quote.id,
      view: toQuoteView({
        priced,
        quoteId: written.quote.id,
        status: 'draft',
        currency: PRICING_DEFAULT_CURRENCY,
        placeOfSupplyStateCode: resolved.placeOfSupplyStateCode,
        placeOfSupplyPincode: request.placeOfSupplyPincode ?? null,
        supplier: resolved.taxProfile,
        discount: resolved.discount,
        expiresAt,
      }),
    };
  }

  /**
   * Resolves the recipient's state.
   *
   * An EXPLICIT code that is not currently issued is refused rather than
   * defaulted — silently substituting a different state would change the tax on
   * the bill without telling anyone. An ABSENT code falls back to the tax
   * profile's default, which is a supported path and the legally conservative one
   * (it yields CGST+SGST and never a wrongly-claimed IGST).
   *
   * *** THE PINCODE IS NEVER CONSULTED HERE. *** It is recorded, and
   * `suggestStateCodeForPincode` may pre-select a dropdown, but a postal circle
   * is not a state boundary and using one to decide a tax produces a wrong
   * CGST/SGST-versus-IGST call on a real bill.
   */
  private resolvePlaceOfSupply(request: QuoteRequest, profile: PricingTaxProfile): string {
    const requested = request.placeOfSupplyStateCode?.trim();
    if (!requested) return profile.defaultPlaceOfSupplyStateCode;

    if (!isSelectableGstStateCode(requested)) {
      throw new BadRequestException({
        code: PRICING_ERROR_CODES.PRICING_STATE_CODE_INVALID,
        message: `${requested} is not a currently-issued GST state code.`,
      });
    }
    return requested;
  }

  private parseFee(consultationFeeInr: string): bigint {
    try {
      return rupeesToPaise(consultationFeeInr);
    } catch (error) {
      if (error instanceof MoneyFormatError) {
        throw new BadRequestException({
          code: PRICING_ERROR_CODES.PRICING_CATALOGUE_INVALID,
          message: 'The consultation fee must be a non-negative amount with at most two decimal places.',
        });
      }
      throw error;
    }
  }

  /** Best-effort reservation for a quote that was drafted before its consultation existed. */
  private async tryReserveForPinned(
    quoteId: string,
    consultationId: string,
    code: string,
    holdExpiresAt: Date,
  ): Promise<void> {
    try {
      const existing = await this.discounts.getForConsultation(consultationId);
      if (existing) return;

      const quote = await this.quotes.findById(quoteId);
      const components = await this.quotes.findComponents(quoteId);
      if (!quote) return;

      await this.discounts.reserve({
        code,
        consultationId,
        holdExpiresAt,
        context: {
          patientId: quote.patientId ?? '',
          doctorId: quote.doctorId,
          specialtyId: quote.specialtyId,
          components: components.map((row) => ({
            code: row.code,
            label: row.label,
            grossAmount: row.grossAmount,
          })),
          discountableAmount: quote.grossTotal,
          currency: quote.currency,
          mode: 'scheduled',
        },
      });
    } catch (error) {
      // The price is already frozen and the patient is about to pay it. A
      // promotions outage must not undo a committed price.
      this.logger.error(
        `Quote ${quoteId} was pinned but its discount could not be reserved: ${describeError(error)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */

function refusal(
  code: string,
  reason: DiscountView['reason'],
  message: string,
): DiscountView {
  return {
    applied: false,
    code,
    instrumentId: null,
    kind: null,
    label: null,
    amount: '0.00',
    cappedAmount: '0.00',
    attributionOnly: false,
    reason,
    message,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
