import { Body, Controller, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { AffiliateService } from './affiliate.service';
import { PromotionAdminService } from './promotion-admin.service';
import { PromotionConfigService } from './promotion-config.service';
import { PromotionSweepService } from './promotion-sweep.service';
import { toCommissionSummary, toPartnerSummary, toSettlementSummary } from './promotion.mapper';
import { PromotionRepository } from './promotion.repository';
import {
  CreateInstrumentDto,
  CreatePartnerDto,
  CreateSettlementDto,
  ExportRedemptionsDto,
  ListCommissionsDto,
  ListInstrumentsDto,
  ListPartnersDto,
  SetInstrumentStatusDto,
  SetPartnerStatusDto,
  UpdateInstrumentDto,
  UpdatePartnerDto,
  UpdatePromotionConfigDto,
  VoidSettlementDto,
} from './promotion-admin.dto';
import { PROMOTION_LIST_DEFAULT_LIMIT } from './promotion.constants';

/**
 * The admin panel's M-13 surface.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * *** SIX PERMISSIONS, AND THE SPLIT IS THE POINT. ***
 *
 *   `promotions.read`     campaigns, redemptions, the configuration
 *   `promotions.manage`   creating, re-pricing, pausing, archiving a code
 *   `promotions.export`   the redemption CSV
 *   `affiliates.read`     partners, attributions, accrued commissions
 *   `affiliates.manage`   creating a partner and ACTIVATING one
 *   `affiliates.settle`   recording that a partner was PAID
 *
 * *** `operations` HOLDS ONLY THE TWO READS. *** That role is defined in
 * `permission.catalog.ts` as "no clinical reads, NO MONEY MOVEMENT", and a
 * discount is money leaving the platform — the same class of act as the refund
 * it already, deliberately, cannot raise. It can see every campaign and every
 * commission and change none of them.
 *
 * Enforced here by giving each route the NARROWEST permission it actually needs,
 * never a blanket `promotions.*`. `PaymentAdminController` states the same rule
 * for its four.
 * ══════════════════════════════════════════════════════════════════════════
 */
@Controller('admin/promotions')
@AccountType('admin')
export class PromotionAdminController {
  constructor(
    private readonly admin: PromotionAdminService,
    private readonly affiliates: AffiliateService,
    private readonly promotionRepo: PromotionRepository,
    private readonly config: PromotionConfigService,
    private readonly sweep: PromotionSweepService,
  ) {}

  /* ---- Instruments: read ---------------------------------------------- */

  @Get('instruments')
  @RequirePermission(PERMISSIONS.PROMOTIONS_READ)
  listInstruments(@Query() query: ListInstrumentsDto) {
    return this.admin.listInstruments({
      kind: query.kind,
      status: query.status,
      code: query.code,
      limit: query.limit ?? PROMOTION_LIST_DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    });
  }

  @Get('instruments/:instrumentId')
  @RequirePermission(PERMISSIONS.PROMOTIONS_READ)
  getInstrument(@Param('instrumentId', createUuidValidationPipe('instrumentId')) instrumentId: string) {
    return this.admin.getInstrument(instrumentId);
  }

  @Get('instruments/:instrumentId/redemptions')
  @RequirePermission(PERMISSIONS.PROMOTIONS_READ)
  listRedemptions(
    @Param('instrumentId', createUuidValidationPipe('instrumentId')) instrumentId: string,
    @Query() query: ListInstrumentsDto,
  ) {
    return this.admin.listRedemptions(instrumentId, query.limit ?? PROMOTION_LIST_DEFAULT_LIMIT, query.offset ?? 0);
  }

  /* ---- Instruments: write --------------------------------------------- */

  /**
   * Creates a coupon or a voucher. Born `draft` whatever the body says —
   * activating it is a second, separate, audited act.
   *
   * The `code` is normalised by `toStorableCode`, THE SAME FUNCTION the patient
   * resolver uses, which is what lets `discount_instruments.code` carry a plain
   * `UNIQUE` and still match case-insensitively.
   */
  @Post('instruments')
  @RequirePermission(PERMISSIONS.PROMOTIONS_MANAGE)
  createInstrument(@CurrentUser() auth: AuthContext, @Body() dto: CreateInstrumentDto) {
    return this.admin.createInstrument(auth.accountId, {
      code: dto.code,
      kind: dto.kind,
      label: dto.label,
      description: dto.description ?? null,
      isPubliclyListed: dto.isPubliclyListed ?? false,
      valueKind: dto.valueKind,
      flatAmount: dto.flatAmount ?? null,
      percentRate: dto.percentRate ?? null,
      maxDiscountAmount: dto.maxDiscountAmount ?? null,
      minOrderAmount: dto.minOrderAmount ?? '0.00',
      validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
      validTo: dto.validTo ? new Date(dto.validTo) : null,
      maxTotalRedemptions: dto.maxTotalRedemptions ?? null,
      maxDistinctRedeemers: dto.maxDistinctRedeemers ?? null,
      maxRedemptionsPerUser: dto.maxRedemptionsPerUser ?? 1,
      assignedPatientId: dto.assignedPatientId ?? null,
    });
  }

  /** Presentational and cap fields only. The VALUE rules are not editable — re-pricing is a new code, see `PromotionAdminService.updateInstrument`. */
  @Patch('instruments/:instrumentId')
  @RequirePermission(PERMISSIONS.PROMOTIONS_MANAGE)
  updateInstrument(
    @CurrentUser() auth: AuthContext,
    @Param('instrumentId', createUuidValidationPipe('instrumentId')) instrumentId: string,
    @Body() dto: UpdateInstrumentDto,
  ) {
    return this.admin.updateInstrument(auth.accountId, instrumentId, {
      label: dto.label,
      description: dto.description,
      isPubliclyListed: dto.isPubliclyListed,
      validTo: dto.validTo ? new Date(dto.validTo) : undefined,
      maxTotalRedemptions: dto.maxTotalRedemptions,
      maxDistinctRedeemers: dto.maxDistinctRedeemers,
    });
  }

  @Put('instruments/:instrumentId/status')
  @RequirePermission(PERMISSIONS.PROMOTIONS_MANAGE)
  setInstrumentStatus(
    @CurrentUser() auth: AuthContext,
    @Param('instrumentId', createUuidValidationPipe('instrumentId')) instrumentId: string,
    @Body() dto: SetInstrumentStatusDto,
  ) {
    return this.admin.setInstrumentStatus(auth.accountId, instrumentId, dto.status);
  }

  /* ---- Export ---------------------------------------------------------- */

  /**
   * The redemption CSV.
   *
   * Sent as a file download rather than through the JSON envelope, so `@Res()`
   * is used directly — the `ResponseInterceptor` would otherwise wrap the CSV in
   * `{ success, data }` and produce a file no spreadsheet can open.
   *
   * `promotions.export` and not `promotions.read`: a bulk extract of who
   * redeemed what is a financial extract, and `operations` holds neither this nor
   * `payments.export`.
   */
  @Get('export/redemptions')
  @RequirePermission(PERMISSIONS.PROMOTIONS_EXPORT)
  async exportRedemptions(
    @CurrentUser() auth: AuthContext,
    @Query() query: ExportRedemptionsDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.admin.exportRedemptionsCsv(auth.accountId, {
      instrumentId: query.instrumentId,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .send(result.content);
  }

  /* ---- Configuration --------------------------------------------------- */

  /** What is actually in force, each key resolved against its compiled-in fallback — so the panel shows the truth, not just what has a row. */
  @Get('config')
  @RequirePermission(PERMISSIONS.PROMOTIONS_READ)
  getConfig() {
    return this.config.getResolved();
  }

  /**
   * *** THIS ROUTE CARRIES `promotion.affiliate_enabled`, THE REGULATORY
   * SWITCH. ***
   *
   * Setting it `true` turns on doctor affiliate commissions. India's NMC
   * Professional Conduct Regulations 2023 prohibit a registered practitioner
   * from receiving a commission for referring or procuring a patient, and the
   * exposure lands on the DOCTOR. `PromotionConfigService.update` writes a
   * `legalSignOffRequired: true` audit row and logs a warning naming the admin
   * who did it.
   *
   * It also carries `promotion.referral_qualifying_statuses` — the key that
   * decides whether referral rewards ever mint at all. See
   * `PROMOTION_DEFAULT_QUALIFYING_STATUSES`.
   */
  @Put('config')
  @RequirePermission(PERMISSIONS.PROMOTIONS_MANAGE)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdatePromotionConfigDto) {
    return this.config.update(auth.accountId, {
      referralProgram: dto.referralProgram,
      referralQualifyingStatuses: dto.referralQualifyingStatuses,
      affiliateEnabled: dto.affiliateEnabled,
      affiliateAttributionDays: dto.affiliateAttributionDays,
      reservationGraceMinutes: dto.reservationGraceMinutes,
      codeAttemptsPerPatientPerHour: dto.codeAttemptsPerPatientPerHour,
      codeAttemptsPerIpPerHour: dto.codeAttemptsPerIpPerHour,
    });
  }

  /* ---- Operations ------------------------------------------------------ */

  /**
   * Runs one sweep pass by hand.
   *
   * The timer already does this every minute; this exists so an operator can
   * drain a backlog immediately after fixing whatever caused it, and so the
   * sweep is testable end to end without waiting on a clock — the same reason
   * booking exposes its own. `promotions.manage`, because a pass can RELEASE
   * reservations.
   */
  @Post('sweep')
  @RequirePermission(PERMISSIONS.PROMOTIONS_MANAGE)
  async runSweep() {
    const reservations = await this.sweep.sweepExpiredReservations();
    const qualifications = await this.sweep.sweepQualifications();
    return { reservations, qualifications };
  }

  /* ====================================================================== */
  /* Affiliates                                                             */
  /* ====================================================================== */

  @Get('affiliates/partners')
  @RequirePermission(PERMISSIONS.AFFILIATES_READ)
  async listPartners(@Query() query: ListPartnersDto) {
    const { rows, total } = await this.affiliates.listPartners({
      status: query.status,
      limit: query.limit ?? PROMOTION_LIST_DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    });
    const summaries = await Promise.all(rows.map((row) => this.summarisePartner(row.id, row)));
    return { rows: summaries, total };
  }

  @Get('affiliates/partners/:partnerId')
  @RequirePermission(PERMISSIONS.AFFILIATES_READ)
  async getPartner(@Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string) {
    const partner = await this.affiliates.getPartner(partnerId);
    return {
      partner: await this.summarisePartner(partnerId, partner),
      outstandingAmount: await this.affiliates.getOutstanding(partnerId),
    };
  }

  /**
   * Creates a partner arrangement. *** IT IS BORN `paused`, ALWAYS. ***
   * `CreatePartnerDto` has no `status` field, and `AffiliateService.createPartner`
   * re-asserts it rather than trusting the body.
   */
  @Post('affiliates/partners')
  @RequirePermission(PERMISSIONS.AFFILIATES_MANAGE)
  createPartner(@CurrentUser() auth: AuthContext, @Body() dto: CreatePartnerDto) {
    return this.affiliates.createPartner(auth.accountId, {
      doctorId: dto.doctorId,
      linkSlug: dto.linkSlug ?? null,
      commissionValueKind: dto.commissionValueKind,
      commissionRate: dto.commissionRate ?? null,
      commissionFlat: dto.commissionFlat ?? null,
      commissionBase: dto.commissionBase ?? 'net_platform_margin',
      commissionMax: dto.commissionMax ?? null,
      agreementReference: dto.agreementReference ?? null,
      note: dto.note ?? null,
    });
  }

  @Patch('affiliates/partners/:partnerId')
  @RequirePermission(PERMISSIONS.AFFILIATES_MANAGE)
  updatePartner(
    @CurrentUser() auth: AuthContext,
    @Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string,
    @Body() dto: UpdatePartnerDto,
  ) {
    return this.affiliates.updatePartner(auth.accountId, partnerId, {
      linkSlug: dto.linkSlug,
      commissionValueKind: dto.commissionValueKind,
      commissionRate: dto.commissionRate,
      commissionFlat: dto.commissionFlat,
      commissionBase: dto.commissionBase,
      commissionMax: dto.commissionMax,
      agreementReference: dto.agreementReference,
      note: dto.note,
    });
  }

  /**
   * Activating a partner while `promotion.affiliate_enabled` is `false` is
   * REFUSED with `PROMOTION_AFFILIATE_DISABLED`, not silently allowed-but-inert.
   * An admin who thinks they have switched a doctor on has made a commitment to
   * that doctor; discovering months later that nothing accrued is worse than a
   * clear refusal now.
   */
  @Put('affiliates/partners/:partnerId/status')
  @RequirePermission(PERMISSIONS.AFFILIATES_MANAGE)
  setPartnerStatus(
    @CurrentUser() auth: AuthContext,
    @Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string,
    @Body() dto: SetPartnerStatusDto,
  ) {
    return this.affiliates.setPartnerStatus(auth.accountId, partnerId, dto.status);
  }

  /** Mints a signed, self-expiring link token so a doctor can be handed a URL. `null` back means affiliates are off, or the partner is not active. */
  @Post('affiliates/partners/:partnerId/link')
  @RequirePermission(PERMISSIONS.AFFILIATES_MANAGE)
  async issueLink(@Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string) {
    const issued = await this.affiliates.issueAttributionLink(partnerId);
    if (!issued) return { issued: false as const };
    return { issued: true as const, token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  }

  @Get('affiliates/commissions')
  @RequirePermission(PERMISSIONS.AFFILIATES_READ)
  async listCommissions(@Query() query: ListCommissionsDto) {
    const { rows, total } = await this.affiliates.listCommissions({
      partnerId: query.partnerId,
      status: query.status,
      limit: query.limit ?? PROMOTION_LIST_DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    });
    return { rows: rows.map(toCommissionSummary), total };
  }

  /* ---- Settlement ------------------------------------------------------ */

  @Get('affiliates/partners/:partnerId/settlements')
  @RequirePermission(PERMISSIONS.AFFILIATES_READ)
  async listSettlements(
    @Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string,
    @Query() query: ListPartnersDto,
  ) {
    const rows = await this.affiliates.listSettlements(
      partnerId,
      query.limit ?? PROMOTION_LIST_DEFAULT_LIMIT,
      query.offset ?? 0,
    );
    return { rows: rows.map(toSettlementSummary) };
  }

  /**
   * Records that a human paid a partner. THE SYSTEM NEVER MOVES THE MONEY —
   * `off_system` is a first-class method because a bank transfer made outside
   * the platform is the EXPECTED case (`docs/SRS.md` §11).
   *
   * `affiliates.settle` is the narrowest and most dangerous of the six: it
   * asserts that money moved. Two admins settling one partner concurrently are
   * serialised by `WHERE ... AND settlement_id IS NULL`; the second claims zero
   * rows, the transaction rolls back, and no commission is ever paid twice.
   */
  @Post('affiliates/partners/:partnerId/settlements')
  @RequirePermission(PERMISSIONS.AFFILIATES_SETTLE)
  createSettlement(
    @CurrentUser() auth: AuthContext,
    @Param('partnerId', createUuidValidationPipe('partnerId')) partnerId: string,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.affiliates.settle(auth.accountId, {
      partnerId,
      method: dto.method,
      periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
      periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
      reference: dto.reference ?? null,
      note: dto.note ?? null,
    });
  }

  /** Voids a settlement, returning its commissions to `accrued` so they can be settled again. */
  @Post('affiliates/settlements/:settlementId/void')
  @RequirePermission(PERMISSIONS.AFFILIATES_SETTLE)
  voidSettlement(
    @CurrentUser() auth: AuthContext,
    @Param('settlementId', createUuidValidationPipe('settlementId')) settlementId: string,
    @Body() dto: VoidSettlementDto,
  ) {
    return this.affiliates.voidSettlement(auth.accountId, settlementId, dto.reason);
  }

  /* ---------------------------------------------------------------------- */

  /** A partner's affiliate codes live in `discount_instruments`, so the summary is assembled from two tables here rather than in the mapper. */
  private async summarisePartner(
    partnerId: string,
    partner: Awaited<ReturnType<AffiliateService['getPartner']>>,
  ) {
    const codes = await this.promotionRepo.listInstrumentsForPartner(partnerId);
    return toPartnerSummary(
      partner,
      codes.map((row) => ({ instrumentId: row.id, code: row.code, status: row.status })),
    );
  }
}
