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
import type { RefundRow } from '../../schema/refunds.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PaymentRepository } from './payment.repository';
import { PAYMENT_AUDIT_ENTITY_TYPES, PAYMENT_ERROR_CODES } from './payment.constants';
import {
  MoneyFormatError,
  paiseToGatewayAmount,
  paiseToRupees,
  rupeesToPaise,
  sumRupees,
} from './payment-money.util';
import { RefundRepository } from './refund.repository';
import { RazorpayClient } from './razorpay.client';

export interface CreateRefundInput {
  paymentId: string;
  amount: string;
  reason: string;
  /** `null` = automatic, raised by the cancellation policy with no human involved. */
  initiatedByAdminId: string | null;
  isAutomatic: boolean;
}

/**
 * Refunds. The single most dangerous surface in this module, and the one whose
 * rules are enforced in code rather than in the schema.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 * *** The sum of a payment's refunds must never exceed what was captured. ***
 *
 * `refunds.schema.ts` states both the rule and the mechanism: "The sum of
 * `processed` rows for a payment is what must never exceed what was captured —
 * enforced in the service inside a `SELECT ... FOR UPDATE` on the payment,
 * because a CHECK constraint cannot see sibling rows."
 *
 * A CHECK constraint sees one row. A unique index cannot express a sum. So the
 * guarantee is: every refund is created inside a transaction that first takes
 * a row lock on the PAYMENT, and the total is read under that lock. Two
 * concurrent refunds therefore serialise — the second blocks until the first
 * commits, then reads a total that already includes it. Without the lock both
 * would read the same stale total, both would pass, and the payment would be
 * over-refunded. `refund.invariant.integration.spec.ts` proves this against a
 * real database with genuinely concurrent callers.
 *
 * The total counts `pending` and `processing` rows as well as `processed`
 * (`RefundRepository.listCommittedAmounts`). Counting only settled refunds
 * would let a second refund be approved while a first was still in flight at
 * the gateway, and the two together could exceed the capture.
 *
 * ── WHY THE GATEWAY CALL IS OUTSIDE THE LOCK ──────────────────────────────
 *
 * The transaction commits the `pending` row and releases the lock BEFORE
 * Razorpay is called. Holding a row lock across a network call to a payment
 * gateway — up to 20 seconds — would block every other refund and every
 * capture on that payment for the duration, and one hung gateway call would
 * stall the queue.
 *
 * That is safe precisely because the committed `pending` row already counts
 * against the invariant. The window between "row committed" and "gateway
 * called" can only ever cause a refund to be REFUSED that might have been
 * allowed, never allowed one that should have been refused. Erring towards
 * refusing is the only acceptable direction for money leaving the platform.
 *
 * ── THE ROW BEFORE THE CALL ───────────────────────────────────────────────
 *
 * `refunds.schema.ts`: "the row is created BEFORE the gateway call (so a crash
 * mid-call leaves evidence rather than a silent gap), then updated with the id
 * the gateway returns." A process that dies mid-call leaves a `pending` row
 * with no `gateway_refund_id` — visible, queryable, and resolvable by a human
 * or a sweep. It never leaves a refund that happened with no record of it.
 *
 * ── POLICY: WHO MAY RAISE ONE ─────────────────────────────────────────────
 *
 * *** DELIBERATE DEVIATION FROM FR-7.7, AGREED WITH THE USER. ***
 *
 * `docs/SRS.md` FR-7.7 read literally says "Refunds are initiated from the
 * admin panel and their status is visible to the patient." Taken strictly that
 * would make every cancellation wait for a human, including the ones that are
 * unambiguously inside the published refund policy.
 *
 * The agreed behaviour instead: a cancellation that falls INSIDE policy is
 * refunded automatically (`isAutomatic: true`, `initiatedByAdminId: null`);
 * anything outside policy or ambiguous goes to the admin queue and is raised
 * by a human holding `PAYMENTS_REFUND`. `refunds.schema.ts` anticipates
 * exactly this by keeping BOTH `is_automatic` and `initiated_by_admin_id`:
 * "the FK answers 'who', the boolean answers 'was a human involved at all'".
 *
 * FR-7.7's substance — the patient can see refund status — is unaffected.
 *
 * *** M-11 OWNS CANCELLATION. *** This module does not decide whether a
 * cancellation is in policy and does not implement cancellation at all; it
 * exposes `createRefund` through `PaymentFacade` so M-11 can call it once M-11
 * has made that decision.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly payments: PaymentRepository,
    private readonly refunds: RefundRepository,
    private readonly gateway: RazorpayClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a refund: reserve under lock, call the gateway, record the answer.
   *
   * Returns as soon as the gateway has answered. A refund is `processing`
   * until a verified `refund.processed` webhook settles it — Razorpay's own
   * refund status is `pending | processed | failed`, and only `processed`
   * means money actually moved (`enums.schema.ts`).
   */
  async createRefund(input: CreateRefundInput): Promise<{ refundId: string; status: string }> {
    const amountPaise = this.parseAmount(input.amount);

    /* ---- PHASE 1: reserve, under the payment's row lock ---------------- */
    const reserved = await this.db.transaction(async (tx) => {
      // *** THE LOCK. Everything below is serialised per payment. ***
      const payment = await this.payments.findByIdForUpdate(input.paymentId, tx);
      if (!payment) {
        throw new NotFoundException({
          code: PAYMENT_ERROR_CODES.PAYMENT_NOT_FOUND,
          message: 'Payment not found.',
        });
      }

      // Only money that actually arrived can go back.
      if (payment.paidAt === null || payment.gatewayPaymentId === null) {
        throw new ConflictException({
          code: PAYMENT_ERROR_CODES.PAYMENT_NOT_CAPTURED,
          message: 'This payment has not been captured, so there is nothing to refund.',
        });
      }

      const capturedPaise = this.capturedPaise(payment);
      // Read UNDER THE LOCK. This is the value a concurrent caller must not be
      // able to read stale.
      const committedPaise = sumRupees(await this.refunds.listCommittedAmounts(input.paymentId, tx));
      const remainingPaise = capturedPaise > committedPaise ? capturedPaise - committedPaise : 0n;

      if (amountPaise > remainingPaise) {
        // *** THE INVARIANT, ENFORCED. ***
        throw new ConflictException({
          code: PAYMENT_ERROR_CODES.REFUND_EXCEEDS_CAPTURED,
          message: `This refund would exceed what was captured. At most ${paiseToRupees(remainingPaise)} can still be refunded.`,
        });
      }

      const refund = await this.refunds.create(
        {
          paymentId: input.paymentId,
          amount: paiseToRupees(amountPaise),
          reason: input.reason.slice(0, 200),
          initiatedByAdminId: input.initiatedByAdminId,
          isAutomatic: input.isAutomatic,
        },
        tx,
      );

      // *** TRANSACTIONAL AUDIT. *** `docs/MODULES.md` §7: "Every module
      // touching clinical or financial data writes audit entries from its
      // first release." `AuditService` sets the rule for RBAC changes — "the
      // write commits or rolls back with the state change it audits" — and
      // money is stricter, not looser. A refund must never exist un-audited,
      // so this is `write(entry, tx)` and never best-effort.
      await this.audit.write(
        {
          actorType: input.initiatedByAdminId === null ? 'system' : 'admin',
          actorId: input.initiatedByAdminId,
          action: 'create',
          entityType: PAYMENT_AUDIT_ENTITY_TYPES.REFUND,
          entityId: refund.id,
          consultationId: payment.consultationId,
          metadata: {
            paymentId: payment.id,
            amount: refund.amount,
            reason: refund.reason,
            isAutomatic: input.isAutomatic,
            capturedAmount: paiseToRupees(capturedPaise),
            alreadyCommitted: paiseToRupees(committedPaise),
          },
        },
        tx,
      );

      return { refund, gatewayPaymentId: payment.gatewayPaymentId, paymentId: payment.id };
    });

    /* ---- PHASE 2: the gateway call, OUTSIDE the lock ------------------- */
    let gatewayRefundId: string;
    let gatewayStatus: string | undefined;
    try {
      const result = await this.gateway.createRefund(reserved.gatewayPaymentId, {
        amount: paiseToGatewayAmount(amountPaise),
        speed: 'normal',
        notes: { refundId: reserved.refund.id, paymentId: reserved.paymentId },
      });
      gatewayRefundId = result.id;
      gatewayStatus = result.status;
    } catch (error) {
      // The gateway refused, or we never heard back. Record it on the row that
      // already exists and re-throw the already-classified exception.
      await this.recordGatewayFailure(reserved.refund, error);
      throw error;
    }

    // Razorpay says `processed` only when the money has already moved;
    // otherwise it is still settling. Our `processing` means "the gateway
    // accepted it" — a state Razorpay has no word for.
    const settled = gatewayStatus === 'processed';
    const attached = await this.refunds.attachGatewayRefundId(
      reserved.refund.id,
      gatewayRefundId,
      settled ? 'processed' : 'processing',
    );

    if (attached === 0) {
      // A `refund.processed` webhook beat us to this row. Harmless — it set
      // the same id — but worth a line, because it means the gateway answered
      // our webhook endpoint before it answered our own HTTP call.
      this.logger.warn(`Refund ${reserved.refund.id}: gateway id was already set (a webhook arrived first).`);
    }

    if (settled) {
      await this.recomputePaymentRefundStatus(reserved.paymentId);
    }

    const current = await this.refunds.findById(reserved.refund.id);
    return { refundId: reserved.refund.id, status: current?.status ?? (settled ? 'processed' : 'processing') };
  }

  /**
   * Recomputes `payments.status` from the SETTLED refunds.
   *
   * `refunded` when everything captured has gone back, `partially_refunded`
   * when some of it has. `partially_refunded` "only became a representable
   * state once one payment could carry many refunds" (`enums.schema.ts`).
   *
   * Driven by `processed` rows only: a refund still in flight has not moved
   * money, and calling the payment `refunded` before it settles would show the
   * patient a refund they have not received.
   *
   * Never writes the `@deprecated` inline `payments.refund_*` columns.
   */
  async recomputePaymentRefundStatus(paymentId: string): Promise<void> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.paidAt === null) return;

    const settledPaise = sumRupees(await this.refunds.listProcessedAmounts(paymentId));
    if (settledPaise === 0n) return;

    const capturedPaise = this.capturedPaise(payment);
    const next = settledPaise >= capturedPaise ? 'refunded' : 'partially_refunded';

    if (payment.status === next) return;
    await this.payments.setRefundStatus(paymentId, next);

    this.logger.log(
      `Payment ${paymentId} -> ${next} (${paiseToRupees(settledPaise)} of ${paiseToRupees(capturedPaise)} refunded).`,
    );
  }

  async getById(refundId: string): Promise<RefundRow> {
    const row = await this.refunds.findById(refundId);
    if (!row) {
      throw new NotFoundException({
        code: PAYMENT_ERROR_CODES.REFUND_NOT_FOUND,
        message: 'Refund not found.',
      });
    }
    return row;
  }

  async listByPaymentId(paymentId: string): Promise<RefundRow[]> {
    return this.refunds.listByPaymentId(paymentId);
  }

  /** What is still refundable on a payment, for the admin screen and for M-11's policy check. */
  async getRefundableAmount(paymentId: string): Promise<string> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.paidAt === null) return '0.00';
    const capturedPaise = this.capturedPaise(payment);
    const committedPaise = sumRupees(await this.refunds.listCommittedAmounts(paymentId));
    return paiseToRupees(capturedPaise > committedPaise ? capturedPaise - committedPaise : 0n);
  }

  /* ---------------------------------------------------------------------- */

  /**
   * What was actually captured, recomputed from the payment's own stored
   * components rather than from a total column — there is no total column, by
   * design (`payment-money.util.ts`).
   */
  private capturedPaise(payment: {
    consultationFee: string;
    convenienceFee: string;
    gstAmount: string;
  }): bigint {
    return (
      rupeesToPaise(payment.consultationFee) +
      rupeesToPaise(payment.convenienceFee) +
      rupeesToPaise(payment.gstAmount)
    );
  }

  private parseAmount(amount: string): bigint {
    let paise: bigint;
    try {
      paise = rupeesToPaise(amount);
    } catch (error) {
      if (error instanceof MoneyFormatError) {
        throw new BadRequestException({
          code: PAYMENT_ERROR_CODES.REFUND_AMOUNT_INVALID,
          message: 'Refund amount must be a positive amount with at most two decimal places.',
        });
      }
      throw error;
    }
    if (paise === 0n) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.REFUND_AMOUNT_INVALID,
        message: 'Refund amount must be greater than zero.',
      });
    }
    return paise;
  }

  /**
   * Marks a refund failed after the gateway refused it, and audits the
   * failure.
   *
   * Best-effort by construction: this runs in a `catch`, and the caller is
   * about to re-throw the real error. If recording the failure ALSO fails,
   * losing the original exception would be strictly worse than losing the
   * status update — the row already exists as evidence either way, and the
   * sweep will find it.
   */
  private async recordGatewayFailure(refund: RefundRow, error: unknown): Promise<void> {
    const detail = extractDetail(error);
    try {
      await this.refunds.markFailedIfNotProcessed(refund.id, detail);
      await this.audit.write({
        actorType: refund.initiatedByAdminId === null ? 'system' : 'admin',
        actorId: refund.initiatedByAdminId,
        action: 'update',
        entityType: PAYMENT_AUDIT_ENTITY_TYPES.REFUND,
        entityId: refund.id,
        metadata: { paymentId: refund.paymentId, outcome: 'gateway_rejected', detail },
      });
    } catch (recordingError) {
      const message = recordingError instanceof Error ? recordingError.message : String(recordingError);
      this.logger.error(`Refund ${refund.id} failed at the gateway AND the failure could not be recorded: ${message}`);
    }
  }
}

/** A short, storable reason from an already-classified `HttpException`. `varchar(200)`, and never shown verbatim to a patient. */
function extractDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string') return code.slice(0, 200);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
