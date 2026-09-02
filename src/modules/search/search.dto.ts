import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { GUIDED_AGE_BANDS, GUIDED_SUPPORT_PREFERENCES } from './guided-intake.service';

/**
 * `search_queries.query_text` is `varchar(500)`. The DTO caps at 400 —
 * DELIBERATELY BELOW the column — so a valid request can never be the thing
 * that truncates a stored row, and so the cap can be raised later without a
 * migration. 400 characters is far more than any real symptom description
 * and small enough to bound what reaches a billed model.
 */
const MAX_QUERY_LENGTH = 400;

/** Bounds shared by every filter DTO here. Languages/specialties are small sets; the caps exist to bound the request body and the resulting SQL `IN` lists. */
const MAX_LANGUAGES = 10;
const MAX_LANGUAGE_LENGTH = 40;

export class DiscoverSearchDto {
  @IsString()
  @Length(1, MAX_QUERY_LENGTH)
  queryText!: string;

  /** FR-5.10 — the client transcribes speech before calling; this only records HOW the query arrived. */
  @IsOptional()
  @IsBoolean()
  isVoiceInput?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LANGUAGES)
  @IsString({ each: true })
  @Length(1, MAX_LANGUAGE_LENGTH, { each: true })
  languages?: string[];

  /** `doctors.consultation_fee_inr` is `numeric(10,2)`; a string keeps it exact, and a float would round a fee. */
  @IsOptional()
  @IsNumberString({ no_symbols: false }, { message: 'maxFeeInr must be a decimal number.' })
  maxFeeInr?: string;

  /** FR-4.4's availability filter. Capped at the platform booking horizon's outer bound. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  availableWithinDays?: number;

  /** `search.max_results` still caps this — a request cannot raise the ceiling, only lower it. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** FR-5.5's concern guide. Structured facets, fed into the SAME pipeline — see `guided-intake.service.ts`. */
export class GuidedSearchDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsUUID('4', { each: true })
  concernIds?: string[];

  @IsBoolean()
  forSelf!: boolean;

  @IsOptional()
  @IsIn([...GUIDED_AGE_BANDS])
  ageBand?: (typeof GUIDED_AGE_BANDS)[number];

  @IsOptional()
  @IsIn([...GUIDED_SUPPORT_PREFERENCES])
  supportPreference?: (typeof GUIDED_SUPPORT_PREFERENCES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LANGUAGES)
  @IsString({ each: true })
  @Length(1, MAX_LANGUAGE_LENGTH, { each: true })
  languages?: string[];

  @IsOptional()
  @IsNumberString({ no_symbols: false }, { message: 'maxFeeInr must be a decimal number.' })
  maxFeeInr?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  availableWithinDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListRecentSearchesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class ListConcernsQueryDto {
  @IsOptional()
  @IsUUID()
  specialtyId?: string;
}

/** FR-4.4's filter and sort surface for the plain doctor listing. */
export class ListDoctorsQueryDto {
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LANGUAGES)
  @IsString({ each: true })
  @Length(1, MAX_LANGUAGE_LENGTH, { each: true })
  languages?: string[];

  @IsOptional()
  @IsNumberString({ no_symbols: false }, { message: 'maxFeeInr must be a decimal number.' })
  maxFeeInr?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  availableWithinDays?: number;

  @IsOptional()
  @IsIn(['relevance', 'fee_asc', 'availability'])
  sort?: 'relevance' | 'fee_asc' | 'availability';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}
