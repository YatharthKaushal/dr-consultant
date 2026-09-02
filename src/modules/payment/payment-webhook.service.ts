import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { PaymentEventRepository } from './payment-event.repository';
import { PaymentRepository } from './payment.repository';
import {
  PAYMENT_AUDIT_ENTITY_TYPES,
  PAYMENT_ERROR_CODES,
  RAZORPAY_EVENTS,
} from './payment.constants';
import { gatewayAmountToPaise, rupeesToPaise } from './payment-money.util';
import { RazorpayErrorClassifier } from './razorpay-error.classifier';
import type { RazorpayWebhookEnvelope } from './razorpay.types';
import { RefundRepository } from './refund.repository';
import { RefundService } from './refund.service';

/** What the controller reports back. `handled` distinguishes a fresh delivery from a replay; both answer 2xx. */
export interface WebhookResult {
  received: true;
  handled: boolean;
  /** `duplicate` = the unique constraint said we already have this event. */
  outcome: 'processed' | 'duplicate' | 'deferred' | 'failed';
}

/**
 * The webhook. FR-7.6 and SRS 6.1 make this the ONLY thing that may mark a
 * payment paid: "payment status is confirmed by gateway webhook, not by
 * client-side result alone"; "payment status is trusted only from verified
 * gateway webhooks."
 *
 * ── THE SIGNATURE IS THE ENTIRE AUTH BOUNDARY ─────────────────────────────
 *
 * The route is `@Public()`. There is no bearer token, no session, no IP
 * allow-list. If `verifySignature` is wrong, ANYONE can mark ANY consultation
 * paid by posting JSON. It is therefore:
 *
 *   - computed over the RAW BYTES, not over a re-serialised object. JSON
 *     round-tripping does not preserve key order or number formatting, so an
 *     HMAC over `JSON.stringify(parsed)` would reject valid deliveries and,
 *     worse, could be made to accept invalid ones.
 *   - compared with `crypto.timingSafeEqual`, never `===`. A plain string
 *     comparison returns early on the first differing byte and leaks the
 *     expected signature one byte at a time. *** Razorpay's own official SDK
 *     gets this wrong *** — `razorpay@2.9.8`'s `validateWebhookSignature` does
 *     `expectedSignature === signature`, which is why this module does not use
 *     it.
 *   - checked BEFORE the payload touches any table, so an unverified body can
 *     never reach `payment_events`. `payment-events.schema.ts` is explicit:
 *     "Only signature-verified payloads are ever inserted; an unverified body
 *     is rejected at the controller and never reaches this table."
 *
 * ── IDEMPOTENCY IS THE DATABASE'S JOB ─────────────────────────────────────
 *
 * Every verified delivery is inserted into `payment_events` keyed on
 * `x-razorpay-event-id`. A `23505` unique violation IS the "already handled"
 * branch — decided by Postgres, not by a preceding SELECT that two concurrent
 * deliveries could both pass. `payment-events.schema.ts`: "The unique
 * constraint IS the idempotency guarantee."
 *
 * ── ALWAYS 2xx ONCE VERIFIED AND RECORDED ─────────────────────────────────
 *
 * Razorpay retries on a non-2xx. Once an event is durably recorded, a handler
 * failure must NOT produce one: a retry storm on a poison event helps nobody
 * and the event is not lost — it is sitting in `payment_events` with
 * `processed_at` null and `processing_error` set, which is exactly the retry
 * sweep's feed. The only non-2xx this endpoint ever returns is 401 for a bad
 * signature.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);
  private readonly classifier = new RazorpayErrorClassifier();

  constructor(
    private readonly events: PaymentEventRepository,
    private readonly payments: PaymentRepository,
    private readonly refunds: RefundRepository,
    private readonly refundService: RefundService,
    private readonly audit: AuditService,
  ) {}

  /**
   * *** THE AUTH BOUNDARY. ***
   *
   * `HMAC-SHA256(rawBody, webhookSecret)`, hex, compared in constant time
   * against the `x-razorpay-signature` header.
   *
   * Every failure mode below returns false rather than throwing, so the caller
   * has exactly one rejection path and no branch can accidentally fall through
   * to "verified":
   *   - a missing or non-string header
   *   - a signature that is not valid hex, or is the wrong length (which would
   *     otherwise make `timingSafeEqual` throw on mismatched buffer lengths —
   *     an exception the caller might handle differently from a false)
   *   - an empty body
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
    if (typeof secret !== 'string' || secret.length === 0) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest();

    // Parse the header as hex ourselves. `Buffer.from(x, 'hex')` silently
    // truncates at the first non-hex character, so a malformed header could
    // otherwise produce a SHORT buffer that happens to prefix-match.
    if (!/^[0-9a-f]+$/i.test(signatureHeader)) return false;
    const provided = Buffer.from(signatureHeader, 'hex');

    // `timingSafeEqual` THROWS on differing lengths, which would itself be a
    // (coarse) timing signal and an unhandled exception. Checked first.
    if (provided.length !== expected.length) return false;

    return timingSafeEqual(provided, expected);
  }

  /** Rejects before anything is read or written. The only non-2xx this endpoint returns. */
  rejectUnverified(): never {
    throw new UnauthorizedException({
      code: PAYMENT_ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
      message: 'Invalid webhook signature.',
    });
  }

  /**
   * Records one VERIFIED delivery and processes it.
   *
   * Call order matters and is the whole design:
   *   1. record durably (the unique constraint decides duplicate vs fresh)
   *   2. process
   *   3. mark processed, or record the failure and leave `processed_at` null
   *
   * Never throws for a processing failure — the caller must answer 2xx.
   */
  async record(input: {
    eventId: string;
    rawBody: Buffer;
    signatureVerified: true;
  }): Promise<WebhookResult> {
    // *** PARSING IS PART OF PROCESSING, NOT A PRECONDITION. ***
    //
    // A body that verified against our secret but is not valid JSON is still a
    // delivery we must not lose and must not 500 on: Razorpay retries a
    // non-2xx, so throwing here would mean an infinite retry loop on a payload
    // that will never parse. It is recorded with the raw bytes as its payload,
    // marked failed for a human to look at, and answered 2xx like everything
    // else that got past the signature.
    const parsed = this.tryParseEnvelope(input.rawBody);
    const envelope = parsed.ok ? parsed.envelope : {};
    const eventType = parsed.ok && typeof envelope.event === 'string' ? envelope.event : 'unparseable';

    // Resolve the payment BEFORE the insert where we can, so the event row
    // carries its link from the start. A null here is fine and expected —
    // `payment_events.payment_id` is "nullable so an out-of-order or unmatched
    // event is still durably captured rather than dropped on the floor."
    const resolved = parsed.ok
      ? await this.resolvePaymentId(envelope)
      : { paymentId: null, gatewayOrderId: null };

    const event = await this.events.insertIfNew({
      gatewayEventId: input.eventId,
      eventType,
      paymentId: resolved.paymentId,
      gatewayOrderId: resolved.gatewayOrderId,
      // `payment_events.payload` is NOT NULL, so an unparseable body is stored
      // as the raw text it was — truncated, because a hostile or broken sender
      // could otherwise put an unbounded blob in the table. The signature
      // already proves it came from Razorpay, so this is evidence worth
      // keeping, not an attack surface.
      payload: parsed.ok ? envelope : { unparseable: input.rawBody.toString('utf8').slice(0, 4_000) },
    });

    if (event === null) {
      // *** THE REPLAY BRANCH, DECIDED BY THE DATABASE. ***
      // Not an error, and deliberately not re-processed: the first delivery
      // either handled it or left it for the sweep.
      this.logger.log(`Webhook ${input.eventId} (${eventType}) is a replay — no-op.`);
      return { received: true, handled: false, outcome: 'duplicate' };
    }

    // Audited as a `webhook` action. `audit_log`'s own enum carries `webhook`
    // for exactly this, and `audit.types.ts` names "raw payload for webhooks"
    // as a metadata use. Best-effort (no `tx`): the event is ALREADY durable
    // in `payment_events`, so failing the delivery over an audit-log insert
    // would trade a real guarantee for a redundant one.
    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'webhook',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.WEBHOOK,
      entityId: input.eventId,
      metadata: { eventType, paymentId: resolved.paymentId, gatewayOrderId: resolved.gatewayOrderId },
    });

    if (!parsed.ok) {
      this.logger.error(`Webhook ${input.eventId} verified but its body could not be parsed: ${parsed.reason}`);
      await this.events.markFailed(event.id, parsed.reason);
      return { received: true, handled: false, outcome: 'failed' };
    }

    try {
      const outcome = await this.process(eventType, envelope, event.id, resolved.paymentId);
      if (outcome === 'deferred') {
        // Recorded, not yet actionable — an event that arrived before its
        // payment row was resolvable. `processed_at` stays null so the sweep
        // picks it up. Still a 2xx.
        await this.events.markFailed(event.id, 'Payment could not be resolved yet; deferred for retry.');
        return { received: true, handled: false, outcome: 'deferred' };
      }
      await this.events.markProcessed(event.id);
      return { received: true, handled: true, outcome: 'processed' };
    } catch (error) {
      // *** A HANDLER FAILURE STILL ANSWERS 2xx. ***
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Webhook ${input.eventId} (${eventType}) failed during processing: ${message}`);
      await this.events.markFailed(event.id, message);
      return { received: true, handled: false, outcome: 'failed' };
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Dispatch. Returns `deferred` when the event is valid but not yet
   * actionable, which is a different thing from a failure and is recorded
   * differently.
   *
   * An event type we do not handle is marked processed with no state change —
   * it is durably recorded, and re-delivering it forever would achieve
   * nothing. Razorpay lets a merchant subscribe to dozens of events and a
   * dashboard change should not start a retry storm.
   */
  private async process(
    eventType: string,
    envelope: RazorpayWebhookEnvelope,
    eventRowId: number,
    resolvedPaymentId: string | null,
  ): Promise<'handled' | 'deferred'> {
    switch (eventType) {
      case RAZORPAY_EVENTS.PAYMENT_CAPTURED:
        return this.handlePaymentCaptured(envelope, eventRowId, resolvedPaymentId);
      case RAZORPAY_EVENTS.PAYMENT_FAILED:
        return this.handlePaymentFailed(envelope, resolvedPaymentId);
      case RAZORPAY_EVENTS.REFUND_PROCESSED:
        return this.handleRefundProcessed(envelope);
      case RAZORPAY_EVENTS.REFUND_FAILED:
        return this.handleRefundFailed(envelope);
      default:
        this.logger.log(`Webhook event type ${eventType} is recorded but not acted on.`);
        return 'handled';
    }
  }

  /**
   * *** THE CAPTURE. The only place a payment becomes `paid`. ***
   *
   * Three guards, in order:
   *   1. the payment must be resolvable — otherwise DEFER, do not fail;
   *   2. the captured amount must equal what we billed — a mismatch is
   *      recorded and refused, never silently accepted;
   *   3. `markPaidIfUnpaid` is guarded on `gateway_payment_id IS NULL`, so a
   *      replay that somehow got past the event-id check still cannot
   *      double-capture.
   */
  private async handlePaymentCaptured(
    envelope: RazorpayWebhookEnvelope,
    eventRowId: number,
    resolvedPaymentId: string | null,
  ): Promise<'handled' | 'deferred'> {
    const entity = envelope.payload?.payment?.entity;
    if (!entity?.id) throw new Error('payment.captured carried no payment entity id.');

    if (resolvedPaymentId === null) {
      this.logger.warn(`payment.captured for gateway payment ${entity.id} could not be matched to a payments row yet.`);
      return 'deferred';
    }

    const payment = await this.payments.findById(resolvedPaymentId);
    if (!payment) return 'deferred';

    // Link the event now that we know the row.
    await this.events.attachPaymentId(eventRowId, payment.id);

    if (payment.paidAt !== null) {
      this.logger.log(`Payment ${payment.id} was already captured — replayed capture is a no-op.`);
      return 'handled';
    }

    const expectedPaise =
      rupeesToPaise(payment.consultationFee) + rupeesToPaise(payment.convenienceFee) + rupeesToPaise(payment.gstAmount);
    const actualPaise = gatewayAmountToPaise(entity.amount ?? 0);

    if (actualPaise !== expectedPaise) {
      // NOT marked paid. An amount we did not bill is not payment for this
      // consultation, and quietly accepting it would let an underpayment
      // unlock a consult.
      this.logger.error(
        `Payment ${payment.id}: capture webhook says ${actualPaise} paise, bill was ${expectedPaise} paise. Refusing to mark paid.`,
      );
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'webhook',
        entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
        entityId: payment.id,
        consultationId: payment.consultationId,
        metadata: { outcome: 'amount_mismatch', expectedPaise: Number(expectedPaise), actualPaise: Number(actualPaise) },
      });
      throw new Error(`Captured amount ${actualPaise} does not match billed amount ${expectedPaise}.`);
    }

    const rows = await this.payments.markPaidIfUnpaid(payment.id, {
      gatewayPaymentId: entity.id,
      paymentMethod: entity.method ?? null,
      paidAt: new Date(),
    });

    if (rows === 0) {
      // Somebody else captured it between our read and our write —
      // reconciliation, or a concurrent delivery. The guard did its job.
      this.logger.log(`Payment ${payment.id} was captured concurrently — this delivery is a no-op.`);
      return 'handled';
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
      entityId: payment.id,
      consultationId: payment.consultationId,
      metadata: { outcome: 'captured', gatewayPaymentId: entity.id, method: entity.method ?? null },
    });

    this.logger.log(`Payment ${payment.id} captured (gateway payment ${entity.id}).`);
    return 'handled';
  }

  /**
   * A failed attempt. Guarded so it can never undo a capture: `payment.failed`
   * for one attempt and `payment.captured` for a later successful one can
   * arrive in either order.
   *
   * The failure reason stored is OUR classified kind, never the gateway's raw
   * description — `payments.failure_reason` is read back into admin screens.
   */
  private async handlePaymentFailed(
    envelope: RazorpayWebhookEnvelope,
    resolvedPaymentId: string | null,
  ): Promise<'handled' | 'deferred'> {
    const entity = envelope.payload?.payment?.entity;
    if (!entity) throw new Error('payment.failed carried no payment entity.');

    if (resolvedPaymentId === null) return 'deferred';

    // The flattened `error_*` fields on the entity are exactly what the
    // classifier's webhook branch reads.
    const failure = this.classifier.classify(entity);
    const rows = await this.payments.markFailedIfNotPaid(resolvedPaymentId, failure.kind.slice(0, 200));

    if (rows === 0) {
      this.logger.log(`payment.failed for ${resolvedPaymentId} ignored — the payment is already captured.`);
      return 'handled';
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYMENT,
      entityId: resolvedPaymentId,
      metadata: { outcome: 'failed', kind: failure.kind, detail: failure.detail },
    });
    return 'handled';
  }

  /**
   * A refund settled. This is the ONLY event that means refund money actually
   * moved (`enums.schema.ts`: "`processed` = the gateway confirmed it by
   * webhook — the only state that means money actually moved").
   *
   * Matched on `gateway_refund_id`, which is the per-refund idempotency key
   * `refunds.schema.ts` describes: "a replayed `refund.processed` webhook
   * finds the id already set and no-ops."
   */
  private async handleRefundProcessed(envelope: RazorpayWebhookEnvelope): Promise<'handled' | 'deferred'> {
    const entity = envelope.payload?.refund?.entity;
    if (!entity?.id) throw new Error('refund.processed carried no refund entity id.');

    const refund = await this.refunds.findByGatewayRefundId(entity.id);
    if (!refund) {
      // The gateway confirmed a refund we have no row for. This can be a
      // genuine race (our own `attachGatewayRefundId` has not committed yet),
      // so it DEFERS rather than failing — the sweep will find it once the
      // write lands.
      this.logger.warn(`refund.processed for gateway refund ${entity.id} has no matching refunds row yet.`);
      return 'deferred';
    }

    const rows = await this.refunds.markProcessedIfNot(refund.id);
    if (rows === 0) {
      this.logger.log(`Refund ${refund.id} was already processed — replay is a no-op.`);
      return 'handled';
    }

    // Now that a refund has settled, the payment may have become
    // `partially_refunded` or `refunded`.
    await this.refundService.recomputePaymentRefundStatus(refund.paymentId);

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.REFUND,
      entityId: refund.id,
      metadata: { outcome: 'processed', paymentId: refund.paymentId, gatewayRefundId: entity.id, amount: refund.amount },
    });

    this.logger.log(`Refund ${refund.id} settled (gateway refund ${entity.id}).`);
    return 'handled';
  }

  /** A refund the gateway could not complete. Guarded so it can never reverse one that already settled. */
  private async handleRefundFailed(envelope: RazorpayWebhookEnvelope): Promise<'handled' | 'deferred'> {
    const entity = envelope.payload?.refund?.entity;
    if (!entity?.id) throw new Error('refund.failed carried no refund entity id.');

    const refund = await this.refunds.findByGatewayRefundId(entity.id);
    if (!refund) return 'deferred';

    const rows = await this.refunds.markFailedIfNotProcessed(refund.id, 'Gateway reported the refund as failed.');
    if (rows === 0) {
      this.logger.warn(`refund.failed for ${refund.id} ignored — it is already processed.`);
      return 'handled';
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.REFUND,
      entityId: refund.id,
      metadata: { outcome: 'failed', paymentId: refund.paymentId, gatewayRefundId: entity.id },
    });
    return 'handled';
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Parses the verified body.
   *
   * *** DELIBERATELY NOT A DTO. *** The global `ValidationPipe` runs with
   * `whitelist: true`, which SILENTLY STRIPS every property without a
   * decorator — it would quietly empty `payload.payment.entity` and the
   * handler would see an event with no data rather than an error. The body is
   * taken raw and read defensively instead.
   */
  private tryParseEnvelope(
    rawBody: Buffer,
  ): { ok: true; envelope: RazorpayWebhookEnvelope } | { ok: false; reason: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, reason: 'Webhook body was not valid JSON.' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'Webhook body was not a JSON object.' };
    }
    return { ok: true, envelope: parsed as RazorpayWebhookEnvelope };
  }

  /**
   * Finds our `payments` row for this event, by whichever identifier the
   * event happens to carry.
   *
   * Three routes, most specific first: our own `gateway_payment_id` (set once
   * captured), the `order_id` on the payment entity, and — for refund events —
   * the refund's `payment_id`, which is Razorpay's payment id.
   *
   * Returning `null` is a normal outcome, not a failure.
   */
  private async resolvePaymentId(
    envelope: RazorpayWebhookEnvelope,
  ): Promise<{ paymentId: string | null; gatewayOrderId: string | null }> {
    const paymentEntity = envelope.payload?.payment?.entity;
    const refundEntity = envelope.payload?.refund?.entity;
    const gatewayOrderId = typeof paymentEntity?.order_id === 'string' ? paymentEntity.order_id : null;

    if (typeof paymentEntity?.id === 'string') {
      const byPayment = await this.payments.findByGatewayPaymentId(paymentEntity.id);
      if (byPayment) return { paymentId: byPayment.id, gatewayOrderId };
    }

    if (gatewayOrderId !== null) {
      const byOrder = await this.payments.findByGatewayOrderId(gatewayOrderId);
      if (byOrder) return { paymentId: byOrder.id, gatewayOrderId };
    }

    if (typeof refundEntity?.payment_id === 'string') {
      const byRefundPayment = await this.payments.findByGatewayPaymentId(refundEntity.payment_id);
      if (byRefundPayment) return { paymentId: byRefundPayment.id, gatewayOrderId };
    }

    if (typeof refundEntity?.id === 'string') {
      const refund = await this.refunds.findByGatewayRefundId(refundEntity.id);
      if (refund) return { paymentId: refund.paymentId, gatewayOrderId };
    }

    return { paymentId: null, gatewayOrderId };
  }
}
