import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';

/** `"HH:MM"` or `"HH:MM:SS"`, 24-hour, IST wall-clock — matches the `time` column's own accepted input shape. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class WeeklyRuleItemDto {
  /** 0 (Sunday) through 6 (Saturday). */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:MM or HH:MM:SS.' })
  startTime!: string;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:MM or HH:MM:SS.' })
  endTime!: string;
}

/**
 * The WHOLE week, replaced atomically (FR-10.1's "sets weekly... slots") —
 * there is no per-day PATCH. `@ArrayMaxSize(50)` is generous headroom over
 * the realistic ceiling (7 days x a handful of split shifts each) while
 * still bounding the request body.
 */
export class ReplaceWeeklyScheduleDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeeklyRuleItemDto)
  rules!: WeeklyRuleItemDto[];
}

export class CreateOverrideDto {
  @IsISO8601({ strict: true }, { message: 'specificDate must be an ISO 8601 date (YYYY-MM-DD).' })
  specificDate!: string;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:MM or HH:MM:SS.' })
  startTime!: string;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:MM or HH:MM:SS.' })
  endTime!: string;
}

/** `startTime`/`endTime` both omitted = a full-day block; both present = a partial-day block. Exactly one of the two is rejected by `availability-rule.service.ts`, not here — the DTO layer can't express "both or neither" cleanly. */
export class CreateBlockDto {
  @IsISO8601({ strict: true }, { message: 'specificDate must be an ISO 8601 date (YYYY-MM-DD).' })
  specificDate!: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:MM or HH:MM:SS.' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:MM or HH:MM:SS.' })
  endTime?: string;
}

/**
 * Every field optional AND nullable — `undefined` (omitted) leaves the
 * column untouched, explicit `null` clears the override back to "inherit
 * the platform default" (same `@IsOptional()`-covers-both-undefined-and-
 * null pattern `UpdateSpecialtyTemplatesDto` uses). Bounds mirror
 * `availability-settings.service.ts`'s own defensive re-check.
 */
export class UpdateSchedulingSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  minNoticeMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  bookingHorizonDays?: number | null;

  /** Reserved for a future feature — not yet read by the slot engine. See `doctor-scheduling-settings.schema.ts`. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  slotIntervalMinutes?: number | null;
}

/** `from`/`to` bound a `[from, to)` slot lookup — full ISO 8601 timestamps (not bare dates), since a slot's identity is a UTC instant. */
export class ListSlotsQueryDto {
  @IsISO8601({}, { message: 'from must be an ISO 8601 timestamp.' })
  from!: string;

  @IsISO8601({}, { message: 'to must be an ISO 8601 timestamp.' })
  to!: string;
}
