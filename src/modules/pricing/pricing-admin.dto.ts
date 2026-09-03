import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TAX_MODES, TAX_TREATMENTS } from '../../schema/enums.schema';
import { PRICING_QUOTE_TTL_BOUNDS } from './pricing.constants';

/** A `numeric(5,2)` percentage as a decimal string. Numbers are refused on purpose — see `shared/money/money.util.ts`. */
const PCT_STRING = /^\d{1,3}(?:\.\d{1,2})?$/;
/** A `numeric(10,2)` rupee amount as a decimal string. */
const RUPEE_STRING = /^\d{1,8}(?:\.\d{1,2})?$/;
/** Two digits. Membership in the compiled-in GST table is checked in the SERVICE, which owns the list. */
const STATE_CODE = /^\d{2}$/;
const PINCODE = /^\d{6}$/;

/**
 * One line of the component catalogue.
 *
 * *** THE DTO IS THE OUTER GUARD, NOT THE ONLY ONE. *** `PricingConfigService`
 * runs the whole catalogue through the ENGINE'S OWN `validateCatalogue` as well,
 * which is what catches the cross-line rules a per-field decorator cannot see: a
 * duplicate code, a forward reference, an exempt-and-inclusive combination.
 * Using a second, looser check in the service is how an admin screen comes to
 * accept a catalogue the pricing path then refuses — at checkout, for a patient.
 */
export class PricingComponentDto {
  @IsString()
  @Length(1, 40)
  code!: string;

  @IsString()
  @Length(1, 80)
  label!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(32_767)
  position!: number;

  /** Service accounting code for the invoice. Null until the client's CA supplies one. */
  @IsOptional()
  @IsString()
  @Length(1, 10)
  hsnSac?: string | null;

  @IsIn(['pass_through', 'percent_of'])
  basis!: 'pass_through' | 'percent_of';

  @IsOptional()
  @IsIn(['consultation_fee', 'fixed'])
  source?: 'consultation_fee' | 'fixed';

  @IsOptional()
  @IsString()
  @Matches(RUPEE_STRING, { message: 'fixedAmount must be a decimal rupee string, e.g. "50.00".' })
  fixedAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(PCT_STRING, { message: 'basisPct must be a decimal percentage, e.g. "20.00".' })
  basisPct?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  basisCodes?: string[];

  @IsIn([...TAX_TREATMENTS])
  taxTreatment!: (typeof TAX_TREATMENTS)[number];

  @IsIn([...TAX_MODES])
  taxMode!: (typeof TAX_MODES)[number];

  @IsString()
  @Matches(PCT_STRING, { message: 'taxRatePct must be a decimal percentage, e.g. "18.00".' })
  taxRatePct!: string;

  /** WHOSE money this line is. `doctor` lines sum to the payout — FR-7.4. */
  @IsIn(['doctor', 'platform'])
  payee!: 'doctor' | 'platform';

  /**
   * WHOSE money funds a discount on this line, or absent for "never discounted".
   *
   * *** SETTING THIS TO `doctor` MAKES FR-7.4'S "PLATFORM DEDUCTION 0" UNTRUE. ***
   * It needs the client's commercial sign-off, not just this permission.
   */
  @IsOptional()
  @IsIn(['platform', 'doctor'])
  discountBearer?: 'platform' | 'doctor' | null;
}

/** The org's own GST registration. Decides CGST+SGST versus IGST on every bill. */
export class PricingTaxProfileDto {
  @IsString()
  @Matches(STATE_CODE, { message: 'registeredStateCode must be a two-digit GST state code.' })
  registeredStateCode!: string;

  /** Null until the client supplies it. An invoice with no GSTIN is not a valid tax invoice. */
  @IsOptional()
  @IsString()
  @Length(15, 15)
  gstin?: string | null;

  @IsString()
  @Length(1, 200)
  legalName!: string;

  @IsString()
  @Matches(STATE_CODE, { message: 'defaultPlaceOfSupplyStateCode must be a two-digit GST state code.' })
  defaultPlaceOfSupplyStateCode!: string;
}

/**
 * The `pricing.*` write surface.
 *
 * There is deliberately NO free-form `{ key, value }` pair: an admin holding
 * `payments.manage_config` can only reach the three keys below, so one shared
 * `app_config` table never becomes one shared permission.
 * `pricing-config.service.ts` re-checks ownership and shape anyway — services
 * hold the rules, per `backend/README.md`, not just the HTTP layer.
 */
export class UpdatePricingConfigDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PricingComponentDto)
  components?: PricingComponentDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PricingTaxProfileDto)
  taxProfile?: PricingTaxProfileDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PRICING_QUOTE_TTL_BOUNDS.min)
  @Max(PRICING_QUOTE_TTL_BOUNDS.max)
  quoteTtlMinutes?: number;
}

/**
 * A price preview.
 *
 * *** `stateCode` IS REQUIRED AND `pincode` IS MERELY RECORDED. ***
 * `price_quotes.place_of_supply_pincode`'s own schema comment says it: "Optional,
 * and only ever a convenience for pre-selecting the state. The state code is
 * authoritative." A postal circle is not a state boundary, and using one to
 * decide a tax produces a wrong CGST/SGST-versus-IGST call on a real bill.
 * `GET /admin/pricing/state-for-pincode` exposes the prefix table as a
 * SUGGESTION the caller confirms.
 */
export class PreviewQuoteDto {
  @IsString()
  @Matches(RUPEE_STRING, {
    message: 'consultationFeeInr must be a decimal rupee string with at most two decimal places, e.g. "500.00".',
  })
  consultationFeeInr!: string;

  @IsString()
  @Matches(STATE_CODE, { message: 'placeOfSupplyStateCode must be a two-digit GST state code.' })
  placeOfSupplyStateCode!: string;

  /** Recorded only. Never authoritative. */
  @IsOptional()
  @IsString()
  @Matches(PINCODE, { message: 'placeOfSupplyPincode must be six digits.' })
  placeOfSupplyPincode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  discountCode?: string;
}
