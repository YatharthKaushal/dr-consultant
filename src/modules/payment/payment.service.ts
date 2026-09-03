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
import { toBreakdown } from './payment.mapper';
import {
  calculateBill,
  gatewayAmountToPaise,
  paiseToGatewayAmount,
  paiseToRupees,
} from './payment-money.util';
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
    private readonly config: PaymentConfigService,
    private readonly gateway: RazorpayClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * FR-7.2's bill, WITHOUT persisting anything. Booking shows this before
   * checkout, so the patient sees every component before they commit.
   *
   * Reads today's rates. The rates that end up ON the payment are snapshotted
   * at `createOrderForConsultation`, so a quote and an order created a
   * fortnight apart can legitimately differ — the bill prints the rate that
   * applied then, not today's.
   */
  async quote(consultationFeeInr: string): Promise<PaymentBreakdown> {
    const rates = await this.config.getRatesForBilling();
    const bill = calculateBill(consultationFeeInr, rates.convenienceFeePct, rates.gstPct);

    return {
      consultationFee: paiseToRupees(bill.consultationFeePaise),
      convenienceFeePct: rates.convenienceFeePct,
      convenienceFee: paiseToRupees(bill.convenienceFeePaise),
      gstPct: rates.gstPct,
      gstAmount: paiseToRupees(bill.gstPaise),
      totalPayable: paiseToRupees(bill.totalPayablePaise),
      currency: PAYMENT_DEFAULT_CURRENCY,
    };
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
   * The rates are SNAPSHOTTED onto the row here (`convenience_fee_pct`,
   * `gst_pct`), which is what `payments.schema.ts` means by "the rate in force
   * at checkout — app_config may have moved on since." A bill reprinted a year
   * later must show the rate that was actually charged.
   */
  async createOrderForConsultation(input: {
    consultationId: string;
    consultationFeeInr: string;
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

    const rates = await this.config.getRatesForBilling();
    const bill = calculateBill(input.consultationFeeInr, rates.convenienceFeePct, rates.gstPct);

    let payment: PaymentRow;
    try {
      payment = await this.payments.insert({
        consultationId: input.consultationId,
        currency: PAYMENT_DEFAULT_CURRENCY,
        consultationFee: paiseToRupees(bill.consultationFeePaise),
        convenienceFeePct: rates.convenienceFeePct,
        convenienceFee: paiseToRupees(bill.convenienceFeePaise),
        gstPct: rates.gstPct,
        gstAmount: paiseToRupees(bill.gstPaise),
      });
    } catch (error) {
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
    const order = await this.gateway.createOrder({
      amount: paiseToGatewayAmount(bill.totalPayablePaise),
      currency: PAYMENT_DEFAULT_CURRENCY,
      // `payments.id` as the receipt. Razorpay treats `receipt` as an
      // idempotency key and REJECTS a second create with the same value, which
      // makes a duplicated create for one payment row impossible at the
      // gateway as well as here. A uuid is 36 chars, inside Razorpay's 40-char
      // limit.
      receipt: payment.id,
      notes: { consultationId: input.consultationId, paymentId: payment.id },
    });

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
        amountPaise: paiseToGatewayAmount(bill.totalPayablePaise),
        convenienceFeePct: rates.convenienceFeePct,
        gstPct: rates.gstPct,
      },
    });

    return {
      paymentId: payment.id,
      gatewayOrderId: order.id,
      gatewayKeyId: this.gateway.getPublishableKeyId(),
      breakdown: toBreakdown({ ...payment, gatewayOrderId: order.id }),
    };
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
    const expectedPaise = this.expectedTotalPaise(payment);
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

  /** What this payment SHOULD have been charged, recomputed from its own snapshotted components. */
  private expectedTotalPaise(payment: PaymentRow): bigint {
    const bill = calculateBill(payment.consultationFee, payment.convenienceFeePct, payment.gstPct);
    return bill.totalPayablePaise;
  }
}
