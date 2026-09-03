import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import type { DiscountInstrumentStatus, DiscountValueKind } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { toStorableCode } from './promotion-code.util';
import { toCsvDocument } from './promotion-csv.util';
import { PromotionRepository, type InstrumentListFilter } from './promotion.repository';
import { toInstrumentSummary } from './promotion.mapper';
import type { DiscountInstrumentSummary } from './promotion.contract';
import {
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_ERROR_CODES,
  PROMOTION_EXPORT_MAX_ROWS,
} from './promotion.constants';

export interface CreateInstrumentInput {
  code: string;
  kind: 'coupon' | 'voucher';
  label: string;
  description: string | null;
  isPubliclyListed: boolean;
  valueKind: DiscountValueKind;
  flatAmount: string | null;
  percentRate: string | null;
  maxDiscountAmount: string | null;
  minOrderAmount: string;
  validFrom: Date | null;
  validTo: Date | null;
  maxTotalRedemptions: number | null;
  maxDistinctRedeemers: number | null;
  maxRedemptionsPerUser: number;
  assignedPatientId: string | null;
}

/**
 * The admin panel's M-13 write surface: creating and re-pricing discount
 * instruments, and exporting redemptions.
 *
 * *** THE CODE WRITTEN HERE GOES THROUGH `toStorableCode`, THE SAME NORMALISER
 * THE PATIENT RESOLVER USES. *** That is the whole reason
 * `discount_instruments.code` can carry a plain `UNIQUE` and still be
 * case-insensitive without `citext` or a functional index. If these two ever
 * used different normalisation, an admin could create `SaveMe` and a patient
 * typing `saveme` would get "this code cannot be used" — a failure with no error
 * anywhere and no way to diagnose it from a log.
 *
 * *** WHAT CANNOT BE CREATED HERE, AND WHY. *** Only `coupon` and `voucher`. A
 * `referral` instrument is minted lazily for one patient, a `referral_reward` is
 * minted by the qualification sweep against an idempotency index, and an
 * `affiliate` code is created through the partner endpoints. Each carries
 * invariants in `discount_instruments_kind_shape_check` that a free-form admin
 * body cannot be trusted to satisfy — and a CHECK violation would surface as a
 * driver error naming a constraint, not as a message naming the field.
 */
@Injectable()
export class PromotionAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: PromotionRepository,
    private readonly audit: AuditService,
  ) {}

  async createInstrument(actingAdminId: string, input: CreateInstrumentInput): Promise<DiscountInstrumentSummary> {
    const code = toStorableCode(input.code);
    if (code === null) {
      throw new BadRequestException({
        code: PROMOTION_ERROR_CODES.CODE_INVALID,
        message:
          'code must contain 4-32 letters or digits once punctuation and spacing are removed (it is stored upper-cased, as A-Z0-9).',
      });
    }

    this.assertValueShape(input);
    this.assertKindShape(input);
    this.assertCapShape(input);

    try {
      return await this.db.transaction(async (tx) => {
        const created = await this.repo.insertInstrument(
          {
            code,
            kind: input.kind,
            // *** BORN `draft`, ALWAYS. *** `discount_instruments.status`
            // defaults to `draft` and this does not override it: a campaign is
            // reviewed and then activated as a second, separate, audited act.
            // The same discipline `AffiliateService.createPartner` applies to a
            // partner row, for the same reason — money leaving the platform
            // should take two decisions, not one.
            status: 'draft',
            label: input.label,
            description: input.description,
            isPubliclyListed: input.isPubliclyListed,
            valueKind: input.valueKind,
            flatAmount: input.flatAmount,
            percentRate: input.percentRate,
            maxDiscountAmount: input.maxDiscountAmount,
            minOrderAmount: input.minOrderAmount,
            ...(input.validFrom !== null ? { validFrom: input.validFrom } : {}),
            validTo: input.validTo,
            maxTotalRedemptions: input.maxTotalRedemptions,
            maxDistinctRedeemers: input.maxDistinctRedeemers,
            maxRedemptionsPerUser: input.maxRedemptionsPerUser,
            assignedPatientId: input.assignedPatientId,
            createdByAdminId: actingAdminId,
          },
          tx,
        );

        await this.audit.write(
          {
            actorType: 'admin',
            actorId: actingAdminId,
            action: 'create',
            entityType: PROMOTION_AUDIT_ENTITY_TYPES.INSTRUMENT,
            entityId: created.id,
            metadata: {
              code: created.code,
              kind: created.kind,
              status: created.status,
              valueKind: created.valueKind,
              flatAmount: created.flatAmount,
              percentRate: created.percentRate,
              maxDiscountAmount: created.maxDiscountAmount,
              minOrderAmount: created.minOrderAmount,
              isPubliclyListed: created.isPubliclyListed,
              caps: {
                total: created.maxTotalRedemptions,
                distinct: created.maxDistinctRedeemers,
                perUser: created.maxRedemptionsPerUser,
              },
            },
          },
          tx,
        );

        // Freshly created: no redemptions can exist yet, so the counts are
        // known to be zero without a query.
        return toInstrumentSummary(created, 0, 0);
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          code: PROMOTION_ERROR_CODES.CODE_ALREADY_EXISTS,
          // Names the NORMALISED form, because that is what collided — an admin
          // who typed `SAVE-ME` needs to be told `SAVEME` is taken, not that
          // `SAVE-ME` is.
          message: `The code ${code} is already in use.`,
        });
      }
      throw error;
    }
  }

  /**
   * Edits the presentational and cap fields of an existing instrument.
   *
   * *** THE VALUE RULES ARE NOT EDITABLE, AND THAT IS DELIBERATE. ***
   * `flat_amount`, `percent_rate` and `value_kind` are absent from this method's
   * input. Every redemption SNAPSHOTS them
   * (`discount-redemptions.schema.ts`: "an admin editing a campaign tomorrow
   * cannot restate what a redemption was worth today"), so editing them would
   * not corrupt history — but it WOULD mean one code was worth two different
   * things to two patients with no visible difference between them, which is a
   * support conversation nobody can win. Re-pricing is a new code.
   *
   * Caps CAN be raised, and that is safe: `discount_redemptions.
   * enforces_single_use_per_user` is a SNAPSHOT taken at insert time precisely
   * so raising a cap from 1 to 3 cannot retroactively unlock an already-reserved
   * row.
   */
  async updateInstrument(
    actingAdminId: string,
    instrumentId: string,
    update: {
      label?: string;
      description?: string;
      isPubliclyListed?: boolean;
      validTo?: Date;
      maxTotalRedemptions?: number;
      maxDistinctRedeemers?: number;
    },
  ): Promise<DiscountInstrumentSummary> {
    const existing = await this.requireInstrument(instrumentId);

    if (existing.status === 'archived') {
      throw new ConflictException({
        code: PROMOTION_ERROR_CODES.INSTRUMENT_NOT_EDITABLE,
        message: 'An archived instrument cannot be edited. Create a new code instead.',
      });
    }

    const changes = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
    // A no-op call writes nothing and audits nothing — no misleading audit
    // entry, the same discipline `payment-config.service.ts` uses.
    if (Object.keys(changes).length === 0) return this.getInstrument(instrumentId);

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.updateInstrument(instrumentId, changes, tx);
      if (!row) throw this.instrumentNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.INSTRUMENT,
          entityId: instrumentId,
          metadata: {
            code: row.code,
            before: {
              label: existing.label,
              isPubliclyListed: existing.isPubliclyListed,
              validTo: existing.validTo?.toISOString() ?? null,
              maxTotalRedemptions: existing.maxTotalRedemptions,
              maxDistinctRedeemers: existing.maxDistinctRedeemers,
            },
            after: {
              label: row.label,
              isPubliclyListed: row.isPubliclyListed,
              validTo: row.validTo?.toISOString() ?? null,
              maxTotalRedemptions: row.maxTotalRedemptions,
              maxDistinctRedeemers: row.maxDistinctRedeemers,
            },
          },
        },
        tx,
      );
      return row;
    });

    return this.summarise(updated);
  }

  /**
   * Moves an instrument's status.
   *
   * `draft` is editable and unusable; `active` is live; `paused` is a reversible
   * stop; `archived` is terminal. Deliberately NOT a boolean — "turn it off for
   * an hour" and "retire it" are different intentions and an admin should not
   * have to encode one as the other (`enums.schema.ts`).
   *
   * *** PAUSING TAKES EFFECT ON THE NEXT `reserve`, NOT ON LIVE RESERVATIONS. ***
   * `PromotionService.reserve` re-reads the status UNDER the instrument's row
   * lock, so a pause lands within one transaction — but a reservation ALREADY
   * taken stays valid until it expires or is released. That is correct: the
   * patient has been quoted a price and may be at the gateway. Pausing stops new
   * redemptions; it does not repudiate quoted ones.
   */
  async setInstrumentStatus(
    actingAdminId: string,
    instrumentId: string,
    status: DiscountInstrumentStatus,
  ): Promise<DiscountInstrumentSummary> {
    const existing = await this.requireInstrument(instrumentId);
    if (existing.status === status) return this.summarise(existing);

    if (existing.status === 'archived') {
      throw new ConflictException({
        code: PROMOTION_ERROR_CODES.INSTRUMENT_NOT_EDITABLE,
        message: 'An archived instrument is terminal and cannot be reactivated. Create a new code instead.',
      });
    }

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.updateInstrumentStatusIfIn(
        instrumentId,
        ['draft', 'active', 'paused'],
        status,
        tx,
      );
      if (!row) throw this.instrumentNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.INSTRUMENT,
          entityId: instrumentId,
          metadata: {
            change: 'status',
            code: row.code,
            before: existing.status,
            after: status,
            // Stated on the row so an auditor reading "paused" does not have to
            // infer what happened to the reservations that were already out.
            liveReservationsUnaffected: true,
          },
        },
        tx,
      );
      return row;
    });

    return this.summarise(updated);
  }

  async getInstrument(instrumentId: string): Promise<DiscountInstrumentSummary> {
    return this.summarise(await this.requireInstrument(instrumentId));
  }

  async listInstruments(filter: InstrumentListFilter): Promise<{ rows: DiscountInstrumentSummary[]; total: number }> {
    const normalisedCode = filter.code === undefined ? undefined : (toStorableCode(filter.code) ?? filter.code);
    const effective = { ...filter, code: normalisedCode };

    const [rows, total] = await Promise.all([
      this.repo.listInstruments(effective),
      this.repo.countInstruments(effective),
    ]);
    return { rows: await Promise.all(rows.map((row) => this.summarise(row))), total };
  }

  async listRedemptions(instrumentId: string, limit: number, offset: number) {
    await this.requireInstrument(instrumentId);
    return this.repo.listRedemptionsForInstrument(instrumentId, limit, offset);
  }

  /**
   * The CSV export (`promotions.export`).
   *
   * Ordered ASCENDING by creation so it reads as a ledger rather than as a
   * reversed screen, and hard-capped at `PROMOTION_EXPORT_MAX_ROWS` so an admin
   * cannot ask for a stream the process has to hold in memory — the same shape
   * as `PaymentAdminService`'s exports.
   *
   * The export itself is AUDITED. `docs/MODULES.md` §7 puts financial data under
   * a standing audit obligation, and a bulk extract of who redeemed what is
   * exactly the act an auditor would want a record of.
   */
  async exportRedemptionsCsv(
    actingAdminId: string,
    filter: { instrumentId?: string; createdFrom?: Date; createdTo?: Date },
  ): Promise<{ filename: string; content: string }> {
    const rows = await this.repo.listRedemptionsForExport({ ...filter, limit: PROMOTION_EXPORT_MAX_ROWS });

    const content = toCsvDocument(
      [
        'redemption_id',
        'instrument_id',
        'patient_id',
        'consultation_id',
        'payment_id',
        'status',
        'value_kind',
        'discountable_base',
        'discount_amount',
        'currency',
        'captured_consultation_fee',
        'captured_convenience_fee',
        'affiliate_partner_id',
        'attribution_source',
        'created_at',
        'consumed_at',
        'released_at',
        'release_reason',
      ],
      rows.map((row) => [
        row.id,
        row.instrumentId,
        row.patientId,
        row.consultationId,
        row.paymentId,
        row.status,
        row.valueKind,
        row.discountableBase,
        row.discountAmount,
        row.currency,
        row.capturedConsultationFee,
        row.capturedConvenienceFee,
        row.affiliatePartnerId,
        row.attributionSource,
        row.createdAt,
        row.consumedAt,
        row.releasedAt,
        row.releaseReason,
      ]),
    );

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'read',
      entityType: PROMOTION_AUDIT_ENTITY_TYPES.EXPORT,
      entityId: filter.instrumentId ?? 'all',
      metadata: {
        rowCount: rows.length,
        truncated: rows.length === PROMOTION_EXPORT_MAX_ROWS,
        createdFrom: filter.createdFrom?.toISOString() ?? null,
        createdTo: filter.createdTo?.toISOString() ?? null,
      },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `discount-redemptions-${stamp}.csv`, content };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Attaches the COUNTED usage figures.
   *
   * *** THIS IS A REPORT, NOT THE CAP ENFORCEMENT. *** The caps are enforced by
   * counting under the instrument's `SELECT ... FOR UPDATE` inside
   * `PromotionService.reserve`; this count is taken without a lock, for a screen.
   * There is no `redeemed_count` column to read instead, deliberately — see
   * `discount-instruments.schema.ts`.
   */
  private async summarise(row: DiscountInstrumentRow): Promise<DiscountInstrumentSummary> {
    const [redeemed, distinct] = await Promise.all([
      this.repo.countLiveRedemptions(row.id),
      this.repo.countDistinctRedeemers(row.id),
    ]);
    return toInstrumentSummary(row, redeemed, distinct);
  }

  private async requireInstrument(instrumentId: string): Promise<DiscountInstrumentRow> {
    const row = await this.repo.findInstrumentById(instrumentId);
    if (!row) throw this.instrumentNotFound();
    return row;
  }

  private instrumentNotFound(): NotFoundException {
    return new NotFoundException({
      code: PROMOTION_ERROR_CODES.INSTRUMENT_NOT_FOUND,
      message: 'Discount instrument not found.',
    });
  }

  /**
   * `discount_instruments_value_check`, enforced where the message can name the
   * field.
   *
   * The percentage branch is the one that matters: an uncapped percentage is
   * refused because `doctors.consultation_fee_inr` is admin-settable with no
   * ceiling, so "50% off" is an unbounded liability against a number somebody
   * can raise later.
   */
  private assertValueShape(input: CreateInstrumentInput): void {
    if (input.valueKind === 'flat') {
      if (input.flatAmount === null) throw this.invalid('A flat instrument needs flatAmount.');
      if (input.percentRate !== null || input.maxDiscountAmount !== null) {
        throw this.invalid('A flat instrument must not carry percentRate or maxDiscountAmount.');
      }
      return;
    }

    if (input.percentRate === null) throw this.invalid('A percentage instrument needs percentRate.');
    if (input.flatAmount !== null) throw this.invalid('A percentage instrument must not carry flatAmount.');
    if (input.maxDiscountAmount === null) {
      throw this.invalid(
        'maxDiscountAmount is REQUIRED for a percentage instrument: the consultation fee has no ceiling, so an uncapped percentage is an unbounded liability.',
      );
    }
    const rate = Number(input.percentRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      throw this.invalid('percentRate must be greater than 0 and at most 100.');
    }
    if (Number(input.maxDiscountAmount) <= 0) throw this.invalid('maxDiscountAmount must be greater than zero.');
  }

  /** The `coupon`/`voucher` half of `discount_instruments_kind_shape_check`. */
  private assertKindShape(input: CreateInstrumentInput): void {
    if (input.kind === 'voucher' && input.assignedPatientId === null) {
      throw this.invalid('A voucher must name the patient it is assigned to.');
    }
    if (input.kind === 'coupon' && input.assignedPatientId !== null) {
      throw this.invalid('A coupon is not assigned to a patient. Use kind "voucher" for that.');
    }
  }

  /** `discount_instruments_caps_check`, including the cross-field rule a CHECK states but an admin form will not. */
  private assertCapShape(input: CreateInstrumentInput): void {
    if (input.maxRedemptionsPerUser < 1) throw this.invalid('maxRedemptionsPerUser must be at least 1.');
    if (
      input.maxDistinctRedeemers !== null &&
      input.maxTotalRedemptions !== null &&
      input.maxDistinctRedeemers > input.maxTotalRedemptions
    ) {
      throw this.invalid(
        'maxDistinctRedeemers cannot exceed maxTotalRedemptions — more distinct people than total redemptions is unreachable.',
      );
    }
    if (input.validTo !== null && input.validFrom !== null && input.validTo <= input.validFrom) {
      throw this.invalid('validTo must be after validFrom.');
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: PROMOTION_ERROR_CODES.INSTRUMENT_INVALID, message });
  }
}
