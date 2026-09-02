import { IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class CreateConcernDto {
  @IsUUID()
  specialtyId!: string;

  /** depression, anxiety, sleep, ... — unique per specialty, immutable after creation. */
  @IsString()
  @Length(1, 60)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  matchPhrases?: string[];

  /** `smallint` column — bounded to its Postgres range. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  matchWeight?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * General concern fields — deliberately does NOT include `matchPhrases`/
 * `matchWeight` (own endpoint/permission, `SEARCH_MANAGE_MAPPING` — see
 * `concern-admin.controller.ts`) nor `code` (immutable once created).
 * `specialtyId` here IS a general field: reassigning a concern to a
 * different specialty is a catalogue-organisation decision, not a
 * search-mapping one.
 */
export class UpdateConcernDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Validated against the target specialty existing, and against the (specialtyId, code) uniqueness constraint, in the service. */
  @IsOptional()
  @IsUUID()
  specialtyId?: string;
}

/**
 * `matchPhrases`/`matchWeight` ONLY — gated by `SEARCH_MANAGE_MAPPING`. This
 * split exists because `matchPhrases` IS the "symptom-to-specialty mapping,
 * synonyms" data that permission's own description names
 * (`permission.catalog.ts`) — a `content`/`operations` admin (who may hold
 * `SPECIALTIES_MANAGE` in some future bundle, or edit concerns for other
 * reasons) must never be able to touch it via the general concern-edit
 * endpoint, only whoever holds this specific permission.
 */
export class UpdateConcernMappingDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  matchPhrases?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  matchWeight?: number;
}
