import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { PaymentAdminService } from './payment-admin.service';
import { PaymentConfigService } from './payment-config.service';
import {
  CreateRefundDto,
  ExportPaymentsDto,
  ListPaymentsDto,
  ListRefundsDto,
  MarkPayoutPaidDto,
  UpdatePaymentConfigDto,
} from './payment-admin.dto';
import { RefundService } from './refund.service';

/**
 * The admin panel's M-12 surface (FR-18.4).
 *
 * *** FOUR PERMISSIONS, AND THE SPLIT IS THE POINT. ***
 * All four already exist in `permission.catalog.ts` and are already bundled
 * into roles — none is added here.
 *
 *   `payments.read`           transactions, payment detail, payout status
 *   `payments.refund`         initiating a refund, marking a payout paid
 *   `payments.export`         CSV
 *   `payments.manage_config`  the convenience fee and GST rate
 *
 * The `operations` role holds ONLY `payments.read` — "no money movement". It
 * can see every transaction and every payout status and cannot refund a rupee,
 * cannot mark a payout paid, and cannot change a rate. That separation is
 * enforced here by using the narrowest permission each route actually needs,
 * never a single blanket `payments.*`.
 *
 * `payments.refund` — not a separate payout permission — gates marking a
 * payout paid: it is the "money movement" permission, marking a payout paid
 * asserts that money moved, and the catalogue has no `payments.payout` key to
 * use instead. Adding one was considered and rejected: the brief fixes the
 * permission set at the existing 52, and `finance` (the role that does payouts)
 * already holds `payments.refund`, while `operations` correctly does not.
 */
@Controller('admin/payments')
@AccountType('admin')
export class PaymentAdminController {
  constructor(
    private readonly admin: PaymentAdminService,
    private readonly refunds: RefundService,
    private readonly config: PaymentConfigService,
  ) {}

  /* ---- Read ---------------------------------------------------------- */

  /** FR-18.4's transactions list, with doctor payout status on every row. */
  @Get('transactions')
  @RequirePermission(PERMISSIONS.PAYMENTS_READ)
  listTransactions(@Query() query: ListPaymentsDto) {
    return this.admin.listPayments({
      status: query.status,
      consultationId: query.consultationId,
      paidFrom: query.paidFrom ? new Date(query.paidFrom) : undefined,
      paidTo: query.paidTo ? new Date(query.paidTo) : undefined,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      payoutPending: query.payoutPending,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** One payment in full: the bill, its refunds, and every gateway event we recorded for it. */
  @Get('transactions/:paymentId')
  @RequirePermission(PERMISSIONS.PAYMENTS_READ)
  getTransaction(@Param('paymentId', createUuidValidationPipe('paymentId')) paymentId: string) {
    return this.admin.getPaymentDetail(paymentId);
  }

  @Get('refunds')
  @RequirePermission(PERMISSIONS.PAYMENTS_READ)
  listRefunds(@Query() query: ListRefundsDto) {
    return this.admin.listRefunds({
      paymentId: query.paymentId,
      status: query.status,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /* ---- Money movement ------------------------------------------------- */

  /**
   * FR-7.7's admin-initiated refund. `PAYMENTS_REFUND`, which `operations`
   * deliberately lacks.
   *
   * `isAutomatic: false` and a real `initiatedByAdminId` — this is the human
   * path. The automatic in-policy path is M-11 calling
   * `PaymentFacade.createRefund` with `initiatedByAdminId: null`; see
   * `refund.service.ts` for the agreed policy split.
   *
   * Two admins refunding the same payment at the same moment are serialised by
   * the `SELECT ... FOR UPDATE` in `RefundService`, and the second one is
   * refused if the two together would exceed what was captured.
   */
  @Post('transactions/:paymentId/refunds')
  @RequirePermission(PERMISSIONS.PAYMENTS_REFUND)
  createRefund(
    @CurrentUser() auth: AuthContext,
    @Param('paymentId', createUuidValidationPipe('paymentId')) paymentId: string,
    @Body() dto: CreateRefundDto,
  ) {
    return this.refunds.createRefund({
      paymentId,
      amount: dto.amount,
      reason: dto.reason,
      initiatedByAdminId: auth.accountId,
      isAutomatic: false,
    });
  }

  /** What is still refundable, so the panel can show a ceiling before an admin types an amount. */
  @Get('transactions/:paymentId/refundable')
  @RequirePermission(PERMISSIONS.PAYMENTS_READ)
  async getRefundable(@Param('paymentId', createUuidValidationPipe('paymentId')) paymentId: string) {
    return { paymentId, refundableAmount: await this.refunds.getRefundableAmount(paymentId) };
  }

  /**
   * Records a manual doctor payout (SRS §2.4: payouts "are reported in the
   * dashboard but paid manually by the client").
   *
   * The bank reference goes into the AUDIT METADATA — there is no
   * `payout_reference` column and `payments.schema.ts` forbids adding one.
   */
  @Post('transactions/:paymentId/payout')
  @RequirePermission(PERMISSIONS.PAYMENTS_REFUND)
  markPayoutPaid(
    @CurrentUser() auth: AuthContext,
    @Param('paymentId', createUuidValidationPipe('paymentId')) paymentId: string,
    @Body() dto: MarkPayoutPaidDto,
  ) {
    return this.admin.markPayoutPaid(auth.accountId, paymentId, {
      bankReference: dto.bankReference,
      note: dto.note,
    });
  }

  /* ---- Export --------------------------------------------------------- */

  /**
   * FR-18.4 / SRS 6.7's CSV export. Sent as a file download rather than
   * through the JSON envelope, so `@Res()` is used directly — the
   * `ResponseInterceptor` would otherwise wrap the CSV in `{ success, data }`
   * and produce a file no spreadsheet can open.
   */
  @Get('export/transactions')
  @RequirePermission(PERMISSIONS.PAYMENTS_EXPORT)
  async exportTransactions(
    @CurrentUser() auth: AuthContext,
    @Query() query: ExportPaymentsDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.admin.exportPaymentsCsv(auth.accountId, {
      status: query.status,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
    this.sendCsv(reply, result.filename, result.content);
  }

  @Get('export/refunds')
  @RequirePermission(PERMISSIONS.PAYMENTS_EXPORT)
  async exportRefunds(
    @CurrentUser() auth: AuthContext,
    @Query() query: ExportPaymentsDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.admin.exportRefundsCsv(auth.accountId, {
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
    this.sendCsv(reply, result.filename, result.content);
  }

  /* ---- Configuration -------------------------------------------------- */

  /** The rates search actually bills at, each resolved against its compiled-in fallback — so the panel shows what is in force, not just what has a row. */
  @Get('config')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  getConfig() {
    return this.config.getResolved();
  }

  /**
   * FR-7.5: the convenience fee percentage and GST rate, editable from the
   * panel with no release. Each changed key writes its own audited
   * before/after and invalidates the config memo.
   */
  @Put('config')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdatePaymentConfigDto) {
    return this.config.update(auth.accountId, {
      convenienceFeePct: dto.convenienceFeePct,
      gstRate: dto.gstRate,
    });
  }

  /** `Content-Disposition: attachment` so a browser downloads rather than renders it. */
  private sendCsv(reply: FastifyReply, filename: string, content: string): void {
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }
}
