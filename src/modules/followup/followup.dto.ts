import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { FOLLOWUP_DEFAULT_PAGE_SIZE, FOLLOWUP_MAX_PAGE_SIZE } from './followup.constants';

/**
 * `POST /consultations/:id/checkins`.
 *
 * *** THE DTO IS THE FIRST LINE, NOT THE RULE — MATCHING `clinical.dto.ts`'s
 * OWN CONVENTION. *** `answers` is validated for real against the pinned
 * pathway version's question set in `followup-scoring.util.ts#validateAnswers`
 * (per-question required/allowed-value checks that no static DTO shape can
 * express, since the question set is admin-authored and versioned). This
 * class only guards the outer shape: an object, not a string or an array.
 */
export class SubmitCheckinDto {
  /** Defaults to today (IST) in the service. Present mainly for tests and the sweep's own reconciliation path — a patient's own client should never need to set this. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'checkinDate must be an ISO 8601 date (YYYY-MM-DD).' })
  checkinDate?: string;

  @IsObject()
  answers!: Record<string, string>;
}

/** `POST /admin/followup-pathways`. See `followup-scoring.util.ts#validateQuestions`/`validateRedFlagRules` for what actually validates `questions`/`redFlagRules` — this DTO only guards the outer shape. */
export class CreatePathwayVersionDto {
  /** depression_anxiety, sleep, substance_use, bipolar_psychosis, general — see `followup-pathways.schema.ts`'s own comment. Not an enum here: FR-19's multi-specialty readiness means new codes are an admin decision, not a redeploy. */
  @IsString()
  @Length(1, 60)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsInt()
  @Min(1)
  @Max(90)
  durationDays!: number;

  @IsArray()
  questions!: unknown[];

  @IsArray()
  redFlagRules!: unknown[];

  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

/** `POST /admin/safety-alerts/:id/close`. */
export class CloseAlertDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  closingNote?: string;
}

/** `GET /admin/safety-alerts`. Same shape `ListAdminBookingsQueryDto` uses. */
export class ListOpenAlertsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FOLLOWUP_MAX_PAGE_SIZE)
  limit?: number = FOLLOWUP_DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
