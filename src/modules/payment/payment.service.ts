import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { PaymentRow } from '../../schema/payments.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { PaymentConfigService } from './payment-config.service';
import { PaymentRepository } from './payment.repository';
import {
  PAYMENT_AUDIT_ENTITY_TYPES,
  PAYMENT_DEFAULT_CURRENCY,
  PAYMENT_ERROR_CODES,
} from './payment.constants';
import type { CreatedOrder, PaymentBreakdown } from './payment.contract';
import { toBreakdown, toBreakdownFromQuote } from './payment.mapper';
import {
  capturedTotalPaise,
  gatewayAmountToPaise,
  paiseToGatewayAmount,
  rupeesToPaise,
} from './payment-money.util';
import { PricingFacade } from '../pricing/pricing.facade';
import type { PriceQuoteView } from '../pricing/pricing.contract';
import { RazorpayClient } from './razorpay.client';

/**
 * M-12's core: quoting a bill, creating the order, reading status back, and
 * reconciling against the gateway.
 *
 * The capture itself is NOT here — it lives in `payment-webhook.service.ts`,
 * because FR-7.6 and SRS 6.1 both require it: "payment status is confirmed by
 * gateway webhook, not by client-side result alone", "payment status is
 * trusted only from verified gateway webhooks". `payments.schema.ts` says the
 * same in one line: a payment "becomes `paid` ONLY on a webhook whose HMAC
 * signature verifies, never on a client result." Nothing in this file sets
 * `status = 'paid'`.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly payments: PaymentRepository,
    /**
     * *** RETAINED THOUGH THIS SERVICE NO LONGER READS A RATE. ***
     *
     * Pricing owns the catalogue now, so nothing here consults it. It stays in
     * the constructor deliberately: removing it would change this class's DI
     * signature, and `payment.service.spec.ts` plus any parallel worktree
     * constructing it by hand would break for a reason that has nothing to do
     * with the change being made. It is one unused reference against a
     * cross-worktree compile break.
     */
    private readonly config: PaymentConfigService,
    private readonly gateway: RazorpayClient,
    private readonly audit: AuditService,
    private readonly pricing: PricingFacade,
  ) {}

  /**
   * FR-7.2's bill.
   *
   * *** EVERY PRICE NOW COMES FROM THE PRICING ENGINE. *** The old body read
   * two rates and called `calculateBill`; it now delegates to `PricingFacade`,
   * so the checkout screen and this method cannot disagree about a total. The
   * frontend calculates nothing.
   *
   * *** THE `options` ARGUMENT IS OPTIONAL, AND THAT IS LOAD-BEARING. ***
   * `payment.contract.ts:7-11` forbids adding a required argument because
   * booking and M-13 mirror this signature BLIND, in parallel worktrees.
   * `(fee: string, opts?: O) => R` IS assignable to a mirror declaring
   * `(fee: string) => R`, so every existing call site compiles untouched.
   *
   * `materialise: true` persists a `draft` quote and returns its id, which a
   * caller can then hand to `createOrderForConsultation` to be sure the price it
   * showed is the price that is charged. Without it nothing is persisted.
   */
  async quote(
    consultationFeeInr: string,
    options?: {
      placeOfSupplyStateCode?: string;
      placeOfSupplyPincode?: string;
      discountCode?: string | null;
      patientId?: string | null;
      doctorId?: string | null;
      materialise?: boolean;
    },
  ): Promise<PaymentBreakdown> {
    const request = {
      consultationFeeInr,
      placeOfSupplyStateCode: options?.placeOfSupplyStateCode ?? null,
      placeOfSupplyPincode: options?.placeOfSupplyPincode ?? null,
      discountCode: options?.discountCode ?? null,
      patientId: options?.patientId ?? null,
      doctorId: options?.doctorId ?? null,
    };

    const view = options?.materialise
      ? await this.pricing.createQuote(request)
      : await this.pricing.preview(request);

    return toBreakdownFromQuote(view, consultationFeeInr, PAYMENT_DEFAULT_CURRENCY);
  }

  /**
   * Creates the `payments` row, then the Razorpay order, then attaches the
   * order id.
   *
   * *** THE ROW COMES FIRST, AND THAT ORDERING IS DELIBERATE. ***
   * The same reasoning `refunds.schema.ts` gives for refunds applies here: if
   * the gateway call is made first and the process dies before the row is
   * written, an order exists at Razorpay that we have no record of and a
   * patient may be able to pay against. A row written first, with no
   * `gateway_order_id` yet, is visible evidence that a checkout was started —
   * and `reconcileWithGateway` can finish the story either way.
   *
   * -- *** THE PRICE IS FROZEN BEFORE THE ORDER EXISTS. *** ------------------
   *
   * Razorpay fixes an order's amount at creation, so the amount cannot change
   * afterwards. The quote is therefore PINNED first — a single conditional
   * UPDATE that fails if the price has gone stale — and only then is the gateway
   * told a number.
   *
   * -- *** `quoteId` ABSENT IS A SUPPORTED PATH, NOT A DEGRADED ONE. *** -----
   *
   * A caller with no quote gets one materialised and pinned inline, from the fee
   * it supplied plus the org's OWN REGISTERED STATE as the place of supply. That
   * default is also the legally conservative one: it yields CGST+SGST and never
   * a wrongly-claimed IGST.
   *
   * The point is that NO CALL SITE CAN PRODUCE AN UNPRICED PAYMENT. Every
   * `payments` row this method writes carries a `price_quote_id`, so
   * `capturedTotalPaise` always has an authoritative total to read, and the
   * legacy `calculateBill` branch applies only to rows that predate the engine.
   *
   * `consultationFeeInr` STAYS REQUIRED so M-13's blind mirror compiles
   * unchanged; everything added here is optional.
   */
  async createOrderForConsultation(input: {
    consultationId: string;
    consultationFeeInr: string;
    quoteId?: string;
    placeOfSupplyStateCode?: string;
    placeOfSupplyPincode?: string;
  }): Promise<CreatedOrder> {
    const existing = await this.payments.findByConsultationId(input.consultationId);
    if (existing) {
      // `payments.consultation_id` is UNIQUE, so this is a real conflict and
      // not something to paper over by returning the old row: the caller asked
      // to create an order and one already exists, possibly already paid.
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.PAYMENT_ALREADY_EXISTS,
        message: 'A payment has already been started for this consultation.',
      });
    }

    // *** PIN BEFORE THE GATEWAY IS TOLD ANYTHING. ***
    const quote =
      input.quoteId !== undefined
        ? await this.pricing.pin({ quoteId: input.quoteId, consultationId: input.consultationId })
        : await this.pricing.materialiseAndPin({
            consultationId: input.consultationId,
            consultationFeeInr: input.consultationFeeInr,
            placeOfSupplyStateCode: input.placeOfSupplyStateCode ?? null,
            placeOfSupplyPincode: input.placeOfSupplyPincode ?? null,
          });

    const totalPayablePaise = rupeesToPaise(quote.totalPayable);

    if (totalPayablePaise === 0n) {
      // *** RAZORPAY WILL NOT CREATE A ZERO-VALUE ORDER. ***
      // A fully-discounted consultation needs a no-payment path — booking would
      // have to take the consult live with no capture at all — and this release
      // does not have one. Refused loudly, with a code naming the cause, rather
      // than sent to the gateway to fail with something opaque. The quote is
      // released so the coupon is not left burnt by a checkout that could never
      // have completed.
      if (quote.quoteId !== null) {
        await this.pricing.abandon({
          quoteId: quote.quoteId,
          consultationId: input.consultationId,
          reason: 'zero_value_order',
        });
      }
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.ZERO_VALUE_ORDER,
        message: 'This consultation is fully discounted, so there is nothing to pay through the gateway.',
      });
    }

    // The legacy three columns, still written as the best available SUMMARY of
    // the bill. `payments.schema.ts` is explicit that once a bill can carry a
    // discount or an inclusive component they become lossy — which is exactly
    // why `price_quote_id` is written alongside them, and why
    // `capturedTotalPaise` reads the QUOTE and not these for a priced row.
    const summary = toBreakdownFromQuote(quote, input.consultationFeeInr, PAYMENT_DEFAULT_CURRENCY);

    let payment: PaymentRow;
    try {
      payment = await this.payments.insert({
        consultationId: input.consultationId,
        currency: PAYMENT_DEFAULT_CURRENCY,
        consultationFee: summary.consultationFee,
        convenienceFeePct: summary.convenienceFeePct,
        convenienceFee: summary.convenienceFee,
        gstPct: summary.gstPct,
        gstAmount: summary.gstAmount,
        priceQuoteId: quote.quoteId,
      });
    } catch (error) {
      // *** THE QUOTE IS ALREADY PINNED AT THIS POINT, SO IT MUST BE RELEASED. ***
      // The stale-draft sweep only covers DRAFTS — a pinned quote is deliberately
      // left alone there, because it may have a live gateway order behind it and
      // releasing its coupon mid-payment would let the same code be spent twice.
      // Nothing else will ever release this one, so a leaked reservation would
      // keep a per-user coupon burnt forever on a checkout that never happened.
      await this.releaseQuote(quote.quoteId, input.consultationId, 'payment_row_insert_failed');

      // Two concurrent checkouts for one consultation both passed the SELECT
      // above; the database settled it. Reported as the same conflict the
      // sequential check throws, per `postgres-error.util.ts`'s stated purpose.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          code: PAYMENT_ERROR_CODES.PAYMENT_ALREADY_EXISTS,
          message: 'A payment has already been started for this consultation.',
        });
      }
      throw error;
    }

    // The gateway call. Any failure here is already classified into one of our
    // own `{ code, message }` bodies by `RazorpayClient`; the `payments` row
    // stays behind as `created` with no order id, which is exactly the state
    // `listStale`/`reconcileWithGateway` are built to resolve.
    let order: { id: string };
    try {
      order = await this.gateway.createOrder({
      // *** THE QUOTE'S TOTAL, NOT A RECOMPUTED ONE. ***
      amount: paiseToGatewayAmount(totalPayablePaise),
      currency: PAYMENT_DEFAULT_CURRENCY,
      // `payments.id` as the receipt. Razorpay treats `receipt` as an
      // idempotency key and REJECTS a second create with the same value, which
      // makes a duplicated create for one payment row impossible at the
      // gateway as well as here. A uuid is 36 chars, inside Razorpay's 40-char
      // limit.
      receipt: payment.id,
      notes: { consultationId: input.consultationId, paymentId: payment.id },
      });
    } catch (error) {
      // No order exists, so no money can move against this quote — release the
      // reservation rather than leaving a coupon burnt. The `payments` row stays
      // behind as `created` with no order id, which is exactly the state
      // `listStale`/`reconcileWithGateway` are built to resolve, and its
      // `price_quote_id` still points at the (now expired) quote so the bill is
      // still explicable.
      await this.releaseQuote(quote.quoteId, input.consultationId, 'gateway_order_creation_failed');
      throw error;
    }

    await this.payments.setGatewayOrderId(payment.id, order.id);

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
      entityId: payment.id,
      consultationId: input.consultationId,
      metadata: {
        gatewayOrderId: order.id,
        amountPaise: paiseToGatewayAmount(totalPayablePaise),
        priceQuoteId: quote.quoteId,
        placeOfSupply: quote.placeOfSupply.stateCode,
        placeOfSupplyKind: quote.placeOfSupply.kind,
        discountCode: quote.discount?.applied ? quote.discount.code : null,
      },
    });

    return {
      paymentId: payment.id,
      gatewayOrderId: order.id,
      gatewayKeyId: this.gateway.getPublishableKeyId(),
      breakdown: summary,
    };
  }

  /**
   * Takes a pinned quote out of play and releases its discount reservation.
   *
   * Best-effort by construction: every caller is already failing and about to
   * throw the real error. Losing that exception to a bookkeeping failure would
   * be strictly worse than leaking one reservation, which is visible and
   * recoverable — the same reasoning `refund.service.ts#recordGatewayFailure`
   * gives for swallowing its own recording errors.
   */
  private async releaseQuote(
    quoteId: string | null | undefined,
    consultationId: string,
    reason: string,
  ): Promise<void> {
    if (quoteId == null) return;
    try {
      await this.pricing.abandon({ quoteId, consultationId, reason });
    } catch (releaseError) {
      const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
      this.logger.error(
        `Quote ${quoteId} could not be released after ${reason}; its discount reservation may be held until it lapses. ${message}`,
      );
    }
  }

  /** Current status, for booking to gate on. */
  async getByConsultationId(
    consultationId: string,
  ): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null> {
    const row = await this.payments.findByConsultationId(consultationId);
    if (!row) return null;
    return { paymentId: row.id, status: row.status, paidAt: row.paidAt };
  }

  async getById(paymentId: string): Promise<PaymentRow> {
    const row = await this.payments.findById(paymentId);
    if (!row) {
      throw new NotFoundException({
        code: PAYMENT_ERROR_CODES.PAYMENT_NOT_FOUND,
        message: 'Payment not found.',
      });
    }
    return row;
  }

  /**
   * *** ASKS THE GATEWAY WHAT ACTUALLY HAPPENED. NEVER TRUSTS LOCAL STATE. ***
   *
   * The hole this closes: a patient pays, Razorpay's `payment.captured`
   * webhook is lost or delayed, and locally the payment sits at `pending`
   * forever while the slot hold expires. M-11's sweep calls this; the answer
   * comes from Razorpay, not from us.
   *
   * It is also the ONLY path other than a verified webhook that may set
   * `paid`, and it is safe to be so because the fact comes from the gateway's
   * own records over an authenticated channel — the same trust basis a
   * verified webhook has. It goes through the identical
   * `markPaidIfUnpaid` guard, so it can never double-capture and can never
   * race a webhook that arrives at the same moment.
   *
   * `changed` tells the caller whether this call moved anything, so a sweep
   * can log only what it actually resolved.
   */
  async reconcileWithGateway(paymentId: string): Promise<{ status: string; changed: boolean }> {
    const payment = await this.getById(paymentId);

    if (payment.gatewayOrderId === null) {
      // The order was never created — the process died between the row insert
      // and the gateway call. There is nothing at Razorpay to reconcile
      // against, and no money can have moved.
      return { status: payment.status, changed: false };
    }

    if (payment.paidAt !== null) {
      // Already captured. Nothing to ask.
      return { status: payment.status, changed: false };
    }

    const gatewayPayments = await this.gateway.fetchOrderPayments(payment.gatewayOrderId);
    const captured = gatewayPayments.find((candidate) => candidate.status === 'captured');

    if (!captured) {
      const failed = gatewayPayments.some((candidate) => candidate.status === 'failed');
      if (failed && gatewayPayments.every((candidate) => candidate.status === 'failed')) {
        const changed = (await this.payments.markFailedIfNotPaid(payment.id, 'Payment attempt failed at the gateway.')) > 0;
        return { status: changed ? 'failed' : payment.status, changed };
      }
      // Still genuinely unpaid, or still in flight. Not an error.
      return { status: payment.status, changed: false };
    }

    // *** The amount check. *** A capture whose amount is not the amount we
    // billed must never be silently accepted as payment for this consultation.
    const expectedPaise = await this.expectedTotalPaise(payment);
    const actualPaise = gatewayAmountToPaise(captured.amount ?? 0);
    if (actualPaise !== expectedPaise) {
      this.logger.error(
        `Payment ${payment.id}: gateway captured ${actualPaise} paise but the bill was ${expectedPaise} paise. Not marking paid.`,
      );
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
        entityId: payment.id,
        metadata: { reconciliation: 'amount_mismatch', expectedPaise: Number(expectedPaise), actualPaise: Number(actualPaise) },
      });
      return { status: payment.status, changed: false };
    }

    const rows = await this.payments.markPaidIfUnpaid(payment.id, {
      gatewayPaymentId: captured.id,
      paymentMethod: captured.method ?? null,
      paidAt: new Date(),
    });

    if (rows === 0) {
      // A webhook won the race between our fetch and our update. Correct
      // outcome, nothing to do.
      return { status: 'paid', changed: false };
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
      entityId: payment.id,
      consultationId: payment.consultationId,
      metadata: { reconciliation: 'captured_via_gateway_fetch', gatewayPaymentId: captured.id },
    });

    this.logger.log(`Payment ${payment.id} reconciled to paid from the gateway (webhook never arrived or was late).`);

    // *** DELIBERATELY DOES NOT EMIT `PAYMENT_CAPTURED_EVENT`. ***
    //
    // This looks like the webhook's capture path, which does emit, so the
    // asymmetry is worth stating: the only caller of this method is M-11's
    // expiry sweep (`booking-slot-hold.service.ts` Tier 2), and it CONFIRMS THE
    // BOOKING ITSELF on `status === 'paid'` — that is the whole point of the
    // tier. Emitting here would add a second, concurrent `confirmPayment` on
    // the one path that already handles it. Harmless (the transaction takes
    // `SELECT ... FOR UPDATE` and the confirm is idempotent) but a self-inflicted
    // race, and it would make the sweep's `confirmed`/`stillHeld` return value
    // ambiguous about which caller did the work.
    //
    // If a SECOND caller ever appears — an admin "reconcile this payment now"
    // button is the obvious one — it must either confirm the booking itself, as
    // the sweep does, or this method must start emitting and the sweep's own
    // call must come out. Do not simply add the emit.
    return { status: 'paid', changed: true };
  }

  /**
   * What this payment SHOULD have been charged.
   *
   * *** THIS WAS THE DIVERGENT ONE. ***
   *
   * It recomputed the total via `calculateBill` while `payment.mapper.ts`,
   * `payment-webhook.service.ts` and `refund.service.ts` each summed the three
   * stored columns. Four derivations, and this one different from the other
   * three — agreeing only by construction, because every row was written from
   * `calculateBill`'s own output.
   *
   * A discount or a third component ends that coincidence, and because this
   * method GATES `reconcileWithGateway`'s amount check, the failure would have
   * been the worst kind: the sweep would have silently started refusing to mark
   * REAL CAPTURES paid, logging an amount mismatch on payments where the money
   * had actually arrived. All four now go through
   * `payment-money.util.ts#capturedTotalPaise`.
   */
  private async expectedTotalPaise(payment: PaymentRow): Promise<bigint> {
    return capturedTotalPaise(payment, await this.resolveQuoteTotal(payment));
  }

  /**
   * `price_quotes.total_payable` for a quoted payment, or `null` for a legacy one.
   *
   * Crosses to `modules/pricing` through its facade, never by reading its table
   * — `backend/README.md` §2. A quoted payment whose quote cannot be resolved
   * returns `null` here and `capturedTotalPaise` then THROWS, rather than
   * quietly re-deriving a different number from the legacy columns.
   */
  private async resolveQuoteTotal(payment: PaymentRow): Promise<string | null> {
    if (payment.priceQuoteId == null) return null;
    const totals = await this.pricing.getQuoteTotals([payment.priceQuoteId]);
    return totals[payment.priceQuoteId] ?? null;
  }
}
