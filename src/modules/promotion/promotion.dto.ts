import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A `numeric(10,2)` rupee amount as a decimal string.
 *
 * NUMBERS ARE REFUSED ON PURPOSE, exactly as `payment-admin.dto.ts` refuses
 * them: `shared/money/money.util.ts` takes STRING IN, NOT NUMBER IN, because
 * accepting a `number` invites a caller to `parseFloat` first and hand us a
 * value that has already drifted.
 */
const RUPEE_STRING = /^\d{1,8}(?:\.\d{1,2})?$/;

/** One line of pricing's bill, as the patient-facing preview endpoint receives it. */
export class DiscountComponentDto {
  @IsString()
  @Length(1, 60)
  code!: string;

  @IsString()
  @Length(1, 120)
  label!: string;

  @Matches(RUPEE_STRING, { message: 'grossAmount must be an amount with at most two decimal places.' })
  grossAmount!: string;
}

/**
 * `POST /promotions/codes/preview`.
 *
 * *** THE `patientId` IS NOT IN THIS BODY. *** It is taken from the bearer token
 * in the controller. A body-supplied patient id on a discount endpoint would let
 * any authenticated patient burn another patient's per-user cap, and probe which
 * vouchers somebody else holds.
 */
export class PreviewCodeDto {
  // Deliberately loose: `promotion-code.util.ts` NORMALISES (upper-cases and
  // strips everything outside A-Z0-9) before validating, so `save-me` and
  // ` SaveMe ` must both survive the DTO to reach it. A strict pattern here
  // would refuse exactly the input the normaliser exists to accept.
  @IsString()
  @IsNotEmpty()
  @Length(1, 80)
  code!: string;

  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @Matches(RUPEE_STRING, { message: 'discountableAmount must be an amount with at most two decimal places.' })
  discountableAmount!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsIn(['scheduled', 'instant'])
  mode!: 'scheduled' | 'instant';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DiscountComponentDto)
  components?: DiscountComponentDto[];
}

/** `POST /promotions/affiliate/attribution` — the FIRST AUTHENTICATED request carrying a link token. */
export class RecordAttributionDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  token!: string;
}

/** Shared paging shape for this module's list endpoints. */
export class PromotionListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
