import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { PaymentStatus, RefundStatus } from '../../schema/enums.schema';
import type { PaymentRow } from '../../schema/payments.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PricingFacade } from '../pricing/pricing.facade';
import { PaymentEventRepository } from './payment-event.repository';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import {
  PAYMENT_AUDIT_ENTITY_TYPES,
  PAYMENT_ERROR_CODES,
  PAYMENT_EXPORT_MAX_ROWS,
  PAYMENT_LIST_DEFAULT_LIMIT,
} from './payment.constants';
import { toCsvDocument } from '../../shared/csv/csv.util';
import {
  toPaymentAdminView,
  toPaymentEventView,
  toRefundView,
  type PaymentAdminView,
  type PaymentEventView,
  type RefundView,
} from './payment.mapper';
import { RefundRepository } from './refund.repository';

export interface PaginatedPayments {
  items: PaymentAdminView[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The admin panel's read and operational surface for M-12 — FR-18.4's
 * "transactions, doctor payouts, refunds and CSV export".
 *
 * Every money MUTATION here writes its audit transactionally or not at all;
 * reads are audited only where they are exports, because an export leaves the
 * building and SRS 6.7/§5.2 want a record of who took the data.
 */
@Injectable()
export class PaymentAdminService {
  private readonly logger = new Logger(PaymentAdminService.name);

  constructor(
    private readonly payments: PaymentRepository,
    private readonly refunds: RefundRepository,
    private readonly events: PaymentEventRepository,
    private readonly paymentService: PaymentService,
    private readonly audit: AuditService,
    /**
     * *** REQUIRED, NOT DECORATIVE: EVERY READ HERE NEEDS A QUOTE TOTAL. ***
     * See `resolveQuoteTotals`.
     */
    private readonly pricing: PricingFacade,
  ) {}

  /**
   * *** `price_quotes.total_payable` FOR A PAGE OF PAYMENTS, IN ONE QUERY. ***
   *
   * `toPaymentAdminView` -> `toBreakdown` -> `capturedTotalPaise`, and
   * `capturedTotalPaise` THROWS for a payment carrying a `price_quote_id` when
   * no total is supplied. That refusal is correct and deliberate — re-deriving a
   * quoted payment's total from the three legacy columns computes a DIFFERENT
   * number for any bill with a discount or an inclusive component — but it means
   * the caller must actually resolve it.
   *
   * *** THE BUG THIS CLOSES. *** All three reads below called
   * `toPaymentAdminView(row, refunds)` with the third argument omitted, so it
   * defaulted to `null`. `createOrderForConsultation` writes a `price_quote_id`
   * on EVERY payment it creates ("no call site can produce an unpriced
   * payment"), so the transactions list, the payment detail and the CSV export
   * each threw a raw `Error` — an unhandled 500 — for every payment written
   * since the pricing engine merged. The whole admin money surface was down for
   * current data and green only for legacy fixtures.
   *
   * Batched deliberately: `getQuoteTotals` takes a LIST because a per-row lookup
   * would put one query per row behind a paginated screen and behind a
   * 50 000-row export.
   *
   * Legacy rows (`price_quote_id IS NULL`) are not in the request at all — they
   * are priced by `calculateBill` and must keep being, so asking pricing about
   * them would be meaningless as well as wasteful.
   */
  private async resolveQuoteTotals(rows: readonly PaymentRow[]): Promise<Map<string, string | null>> {
    const quoteIds = [...new Set(rows.map((row) => row.priceQuoteId).filter((id): id is string => id != null))];
    if (quoteIds.length === 0) return new Map();

    const totals = await this.pricing.getQuoteTotals(quoteIds);
    return new Map(rows.map((row) => [row.id, row.priceQuoteId == null ? null : (totals[row.priceQuoteId] ?? null)]));
  }

  /** FR-18.4's transactions list. */
  async listPayments(filter: {
    status?: PaymentStatus;
    consultationId?: string;
    paidFrom?: Date;
    paidTo?: Date;
    createdFrom?: Date;
    createdTo?: Date;
    payoutPending?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PaginatedPayments> {
    const resolved = { ...filter, limit: filter.limit ?? PAYMENT_LIST_DEFAULT_LIMIT, offset: filter.offset ?? 0 };

    const [rows, total] = await Promise.all([
      this.payments.list(resolved),
      this.payments.countMatching(resolved),
    ]);

    // One query for every row's refunds, not one per row.
    const refundRows = await this.refunds.listByPaymentIds(rows.map((row) => row.id));
    const byPayment = new Map<string, typeof refundRows>();
    for (const refund of refundRows) {
      const list = byPayment.get(refund.paymentId) ?? [];
      list.push(refund);
      byPayment.set(refund.paymentId, list);
    }

    const quoteTotals = await this.resolveQuoteTotals(rows);

    return {
      items: rows.map((row) => toPaymentAdminView(row, byPayment.get(row.id) ?? [], quoteTotals.get(row.id) ?? null)),
      total,
      limit: resolved.limit,
      offset: resolved.offset,
    };
  }

  /** One payment in full, with its refunds and the gateway events we recorded for it. */
  async getPaymentDetail(paymentId: string): Promise<{
    payment: PaymentAdminView;
    refunds: RefundView[];
    events: PaymentEventView[];
  }> {
    const payment = await this.paymentService.getById(paymentId);
    const [refunds, events] = await Promise.all([
      this.refunds.listByPaymentId(paymentId),
      this.events.listByPaymentId(paymentId),
    ]);

    const quoteTotals = await this.resolveQuoteTotals([payment]);

    return {
      payment: toPaymentAdminView(payment, refunds, quoteTotals.get(payment.id) ?? null),
      refunds: refunds.map(toRefundView),
      events: events.map(toPaymentEventView),
    };
  }

  async listRefunds(filter: {
    paymentId?: string;
    status?: RefundStatus;
    createdFrom?: Date;
    createdTo?: Date;
    limit?: number;
    offset?: number;
  }): Promise<RefundView[]> {
    const rows = await this.refunds.list({
      ...filter,
      limit: filter.limit ?? PAYMENT_LIST_DEFAULT_LIMIT,
      offset: filter.offset ?? 0,
    });
    return rows.map(toRefundView);
  }

  /**
   * Marks a manual payout transferred.
   *
   * *** THE BANK REFERENCE GOES IN THE AUDIT METADATA. ***
   * `payments.schema.ts` is explicit: "No `payout_reference`: the admin who
   * marks a payout paid puts the reference in the `metadata` of that
   * `audit_log` row instead." No column is added for it, and none may be.
   *
   * Guarded twice: the payment must actually have been captured (you cannot
   * pay out money that never arrived), and `markPayoutPaidIfUnpaid` is
   * conditioned on `payout_paid_at IS NULL` so two admins recording the same
   * transfer cannot both succeed. The second one is told, rather than silently
   * overwriting the first one's timestamp.
   */
  async markPayoutPaid(
    actingAdminId: string,
    paymentId: string,
    input: { bankReference: string; note?: string },
  ): Promise<{ paymentId: string; payoutPaidAt: Date }> {
    const payment = await this.paymentService.getById(paymentId);

    if (payment.paidAt === null) {
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.PAYOUT_NOT_PAYABLE,
        message: 'This consultation has not been paid, so there is no payout to make.',
      });
    }

    const paidAt = new Date();
    const rows = await this.payments.markPayoutPaidIfUnpaid(paymentId, paidAt);

    if (rows === 0) {
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.PAYOUT_ALREADY_PAID,
        message: 'This payout has already been marked paid.',
      });
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.PAYOUT,
      entityId: paymentId,
      consultationId: payment.consultationId,
      metadata: {
        // *** The reference lives HERE, by design. ***
        bankReference: input.bankReference,
        note: input.note ?? null,
        doctorEarning: payment.consultationFee,
        payoutPaidAt: paidAt.toISOString(),
      },
    });

    this.logger.log(`Payout for payment ${paymentId} marked paid by admin ${actingAdminId}.`);
    return { paymentId, payoutPaidAt: paidAt };
  }

  /**
   * The transactions CSV (FR-18.4, SRS 6.7).
   *
   * Audited as an `export` action: the data leaves the building, and SRS 5.2
   * requires a record of who accessed financial records. `audit_log`'s own
   * action enum carries `export` for exactly this.
   *
   * Row-capped rather than streamed. A cap is honest about the memory this
   * costs; an uncapped export of a growing table eventually takes the process
   * down, and an admin who needs more than 50,000 rows needs a date window,
   * not a bigger buffer.
   */
  async exportPaymentsCsv(
    actingAdminId: string,
    filter: { status?: PaymentStatus; createdFrom?: Date; createdTo?: Date },
  ): Promise<{ filename: string; content: string; rowCount: number }> {
    const rows = await this.payments.listForExport({ ...filter, limit: PAYMENT_EXPORT_MAX_ROWS, offset: 0 });
    const refundRows = await this.refunds.listByPaymentIds(rows.map((row) => row.id));

    const settledByPayment = new Map<string, string[]>();
    for (const refund of refundRows) {
      if (refund.status !== 'processed') continue;
      const list = settledByPayment.get(refund.paymentId) ?? [];
      list.push(refund.amount);
      settledByPayment.set(refund.paymentId, list);
    }

    const header = [
      'payment_id',
      'consultation_id',
      'status',
      'currency',
      'consultation_fee',
      'convenience_fee_pct',
      'convenience_fee',
      'gst_pct',
      'gst_amount',
      'total_payable',
      'payment_method',
      'gateway_order_id',
      'gateway_payment_id',
      'paid_at',
      'refunded_amount',
      // FR-7.4: the doctor keeps the whole consultation fee.
      'doctor_earning',
      'platform_deduction',
      'payout_status',
      'payout_paid_at',
      'created_at',
    ];

    const quoteTotals = await this.resolveQuoteTotals(rows);

    const body = rows.map((row) => {
      const view = toPaymentAdminView(
        row,
        refundRows.filter((refund) => refund.paymentId === row.id),
        quoteTotals.get(row.id) ?? null,
      );
      return [
        view.id,
        view.consultationId,
        view.status,
        view.breakdown.currency,
        view.breakdown.consultationFee,
        view.breakdown.convenienceFeePct,
        view.breakdown.convenienceFee,
        view.breakdown.gstPct,
        view.breakdown.gstAmount,
        view.breakdown.totalPayable,
        view.paymentMethod,
        view.gatewayOrderId,
        view.gatewayPaymentId,
        view.paidAt,
        view.refundedAmount,
        view.payout.doctorEarning,
        view.payout.platformDeduction,
        view.payout.payoutStatus,
        view.payout.payoutPaidAt,
        view.createdAt,
      ];
    });

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'export',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.EXPORT,
      entityId: 'payments',
      metadata: {
        rowCount: body.length,
        status: filter.status ?? null,
        createdFrom: filter.createdFrom?.toISOString() ?? null,
        createdTo: filter.createdTo?.toISOString() ?? null,
        truncated: body.length >= PAYMENT_EXPORT_MAX_ROWS,
      },
    });

    return {
      filename: `payments-${new Date().toISOString().slice(0, 10)}.csv`,
      content: toCsvDocument(header, body),
      rowCount: body.length,
    };
  }

  /** The refunds CSV. Separate from the transactions one because a payment can carry many refunds and a flat join would repeat every payment row. */
  async exportRefundsCsv(
    actingAdminId: string,
    filter: { createdFrom?: Date; createdTo?: Date },
  ): Promise<{ filename: string; content: string; rowCount: number }> {
    const rows = await this.refunds.list({ ...filter, limit: PAYMENT_EXPORT_MAX_ROWS, offset: 0 });

    const header = [
      'refund_id',
      'payment_id',
      'amount',
      'status',
      'reason',
      'is_automatic',
      'initiated_by_admin_id',
      'gateway_refund_id',
      'created_at',
      'updated_at',
    ];

    const body = rows.map((row) => [
      row.id,
      row.paymentId,
      row.amount,
      row.status,
      // User-supplied text: `toCsvField` defuses a leading `=` so it cannot
      // execute as a formula in the admin's spreadsheet.
      row.reason,
      row.isAutomatic,
      row.initiatedByAdminId,
      row.gatewayRefundId,
      row.createdAt,
      row.updatedAt,
    ]);

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'export',
      entityType: PAYMENT_AUDIT_ENTITY_TYPES.EXPORT,
      entityId: 'refunds',
      metadata: { rowCount: body.length, truncated: body.length >= PAYMENT_EXPORT_MAX_ROWS },
    });

    return {
      filename: `refunds-${new Date().toISOString().slice(0, 10)}.csv`,
      content: toCsvDocument(header, body),
      rowCount: body.length,
    };
  }
}
