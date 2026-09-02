import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SEARCH_SOURCES } from '../../schema/enums.schema';

/**
 * FR-5.7's feedback loop. `maxResultCount: 0` is the query this endpoint
 * exists for: "which phrasings returned zero doctors", the input to editing
 * `concerns.matchPhrases` from the admin panel.
 */
export class ListSearchQueriesDto {
  /** Inclusive ceiling on `result_count`. Pass `0` for the zero-result view. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(32_767)
  maxResultCount?: number;

  @IsOptional()
  @IsIn([...SEARCH_SOURCES])
  source?: (typeof SEARCH_SOURCES)[number];

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  crisisGuardrailFired?: boolean;

  @IsOptional()
  @IsISO8601({}, { message: 'from must be an ISO 8601 timestamp.' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to must be an ISO 8601 timestamp.' })
  to?: string;

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
  @Max(100_000)
  offset?: number;
}

export class CrisisHelplineDto {
  @IsString()
  @Length(1, 160)
  name!: string;

  @IsString()
  @Length(1, 40)
  phone!: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  availability?: string;
}

export class CrisisGuidanceDto {
  @IsString()
  @Length(1, 2000)
  message!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CrisisHelplineDto)
  helplines!: CrisisHelplineDto[];
}

export class PopularSearchDto {
  @IsString()
  @Length(1, 80)
  label!: string;

  @IsString()
  @Length(1, 200)
  query!: string;
}

/**
 * The `search.*` write surface. There is deliberately NO free-form
 * `{ key, value }` pair here: an admin holding `SEARCH_MANAGE_MAPPING` can
 * only reach the five keys named below, so one shared `app_config` table
 * never becomes one shared permission. `search-config.service.ts` re-checks
 * ownership and bounds anyway — services hold the rules, per
 * `backend/README.md`, not just the HTTP layer.
 *
 * Every field is optional; only the ones present are written, and each
 * writes its own audited before/after.
 */
export class UpdateSearchConfigDto {
  /**
   * `@ArrayMinSize(1)`: an empty list would silently disable the FR-5.6
   * crisis guardrail. Turning the safety net off is not something an admin
   * should be able to do by saving an empty field.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(1, 120, { each: true })
  crisisKeywords?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CrisisGuidanceDto)
  crisisGuidance?: CrisisGuidanceDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PopularSearchDto)
  popularSearches?: PopularSearchDto[];

  /** THE KILL SWITCH. `false` serves every search from the deterministic matcher, with no change to the response shape. */
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxResults?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerHour?: number;
}
