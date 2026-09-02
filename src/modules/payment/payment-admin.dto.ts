import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PAYMENT_STATUSES, REFUND_STATUSES } from '../../schema/enums.schema';
import { PAYMENT_LIST_MAX_LIMIT, PAYMENT_RATE_BOUNDS } from './payment.constants';

/** A `numeric(10,2)` rupee amount as a decimal string. Numbers are refused on purpose — see `payment-money.util.ts`. */
const RUPEE_STRING = /^\d{1,8}(?:\.\d{1,2})?$/;

export class ListPaymentsDto {
  @IsOptional()
  @IsIn([...PAYMENT_STATUSES])
  status?: (typeof PAYMENT_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  consultationId?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'paidFrom must be an ISO 8601 timestamp.' })
  paidFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'paidTo must be an ISO 8601 timestamp.' })
  paidTo?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdFrom must be an ISO 8601 timestamp.' })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdTo must be an ISO 8601 timestamp.' })
  createdTo?: string;

  /** `true` = captured but not yet transferred, i.e. what the client still owes doctors. */
  @IsOptional()
  @Type(() => Boolean)
  payoutPending?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

export class ListRefundsDto {
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @IsOptional()
  @IsIn([...REFUND_STATUSES])
  status?: (typeof REFUND_STATUSES)[number];

  @IsOptional()
  @IsISO8601({}, { message: 'createdFrom must be an ISO 8601 timestamp.' })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdTo must be an ISO 8601 timestamp.' })
  createdTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

/**
 * An admin-initiated refund (FR-7.7). Requires `PAYMENTS_REFUND`, which the
 * `operations` role deliberately does not hold — "no money movement".
 */
export class CreateRefundDto {
  /**
   * A DECIMAL STRING, not a number. A JSON number for money is a float, and
   * `708.35` does not survive one. `payment-money.util.ts` refuses a number
   * outright; this keeps the HTTP layer consistent with it.
   */
  @IsString()
  @Matches(RUPEE_STRING, {
    message: 'amount must be a decimal rupee string with at most two decimal places, e.g. "708.00".',
  })
  amount!: string;

  /** Shown to the patient alongside the refund status (FR-7.7), so it must read as an explanation. */
  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * Marking a manual payout transferred.
 *
 * `payouts are manual this release` (SRS §2.4: "doctor payouts are reported in
 * the dashboard but paid manually by the client"). There is NO
 * `payout_reference` column and one must not be added — `payments.schema.ts`:
 * "the admin who marks a payout paid puts the reference in the `metadata` of
 * that `audit_log` row instead." `bankReference` below goes there.
 */
export class MarkPayoutPaidDto {
  @IsString()
  @Length(1, 120)
  bankReference!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  note?: string;
}

/**
 * The `payments.*` write surface (FR-7.5).
 *
 * There is deliberately NO free-form `{ key, value }` pair: an admin holding
 * `PAYMENTS_MANAGE_CONFIG` can only reach the two keys below, so one shared
 * `app_config` table never becomes one shared permission.
 * `payment-config.service.ts` re-checks ownership and bounds anyway — services
 * hold the rules, per `backend/README.md`, not just the HTTP layer.
 */
export class UpdatePaymentConfigDto {
  /** FR-7.3's 20 percent. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(PAYMENT_RATE_BOUNDS.min)
  @Max(PAYMENT_RATE_BOUNDS.max)
  convenienceFeePct?: number;

  /** FR-7.3's 18 percent. The agreed key name is `payments.gst_rate`. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(PAYMENT_RATE_BOUNDS.min)
  @Max(PAYMENT_RATE_BOUNDS.max)
  gstRate?: number;
}

/** CSV export window (FR-18.4, SRS 6.7). */
export class ExportPaymentsDto {
  @IsOptional()
  @IsIn([...PAYMENT_STATUSES])
  status?: (typeof PAYMENT_STATUSES)[number];

  @IsOptional()
  @IsISO8601({}, { message: 'createdFrom must be an ISO 8601 timestamp.' })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdTo must be an ISO 8601 timestamp.' })
  createdTo?: string;
}
