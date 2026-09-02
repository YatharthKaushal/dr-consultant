import { IsArray, IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';

/**
 * `intakeForm`/`firstConsultForm` are jsonb `unknown` columns holding an
 * "ordered field list" (`specialties.schema.ts`) — validated only as an
 * array here, not deeply against an arbitrary form-schema shape, per the
 * task brief. Same for `requiredDocuments` (a plain string array).
 */
export class CreateSpecialtyDto {
  /** psychiatry, psychology, therapy, counselling, de_addiction, ... — immutable after creation. */
  @IsString()
  @Length(1, 60)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsBoolean()
  canPrescribe!: boolean;

  @IsOptional()
  @IsArray()
  intakeForm?: unknown[];

  @IsOptional()
  @IsArray()
  firstConsultForm?: unknown[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredDocuments?: string[];
}

/**
 * General specialty fields — deliberately does NOT include
 * `prescriptionTemplate`/`adviceTemplate` (own endpoint/permission,
 * `SPECIALTIES_MANAGE_CLINICAL_TEMPLATES` — see `specialty-admin.controller.ts`)
 * nor `code` (immutable once created, same reasoning `doctor.dto.ts` gives
 * for not letting a doctor self-edit their own auth-relevant fields).
 */
export class UpdateSpecialtyDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Flipping this to `false` while `prescriptionTemplate` is currently
   * non-null is rejected by the service (`CANNOT_DISABLE_PRESCRIBING_WITH_
   * TEMPLATE_SET`) — see `specialty.service.ts#adminUpdate`.
   */
  @IsOptional()
  @IsBoolean()
  canPrescribe?: boolean;

  @IsOptional()
  @IsArray()
  intakeForm?: unknown[];

  @IsOptional()
  @IsArray()
  firstConsultForm?: unknown[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredDocuments?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * `prescriptionTemplate`/`adviceTemplate` ONLY — gated by
 * `SPECIALTIES_MANAGE_CLINICAL_TEMPLATES`, deliberately split from
 * `UpdateSpecialtyDto`/`SPECIALTIES_MANAGE` (`permission.catalog.ts`'s own
 * description: "Edit a specialty's default prescription/advice templates").
 *
 * `null` is a valid, meaningful value for either field — it clears the
 * template. `class-validator`'s `@IsOptional()` skips the shape check for
 * BOTH `undefined` (field omitted — leave untouched) and `null` (field
 * explicitly cleared) — see `specialty.service.ts#adminUpdateTemplates` for
 * how the two are told apart.
 */
export class UpdateSpecialtyTemplatesDto {
  @IsOptional()
  @IsArray()
  prescriptionTemplate?: unknown[] | null;

  @IsOptional()
  @IsObject()
  adviceTemplate?: Record<string, unknown> | null;
}
