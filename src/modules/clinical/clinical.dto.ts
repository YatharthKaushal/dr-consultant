import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { RISK_CATEGORIES, type RiskCategory } from '../../schema/enums.schema';
import { MAX_MEDICINE_LINES, MEDICINE_FIELD_LIMITS } from './clinical.constants';

/**
 * One medicine line: FR-9.5's "medicine, dose, frequency, duration and
 * instructions", and `docs/MODULES.md`'s M-15 wording for the same five fields.
 *
 * *** THE DTO IS THE FIRST LINE, NOT THE RULE. *** `clinical-medicine.util.ts`
 * re-validates every line in the service, because two of the three ways
 * medicines enter this module (applying a doctor template, applying a
 * specialty's admin-authored template) are `jsonb` reads that never touch a
 * DTO at all. See that file's header.
 */
export class MedicineLineDto {
  @IsString()
  @Length(1, MEDICINE_FIELD_LIMITS.NAME)
  name!: string;

  @IsString()
  @Length(1, MEDICINE_FIELD_LIMITS.DOSE)
  dose!: string;

  @IsString()
  @Length(1, MEDICINE_FIELD_LIMITS.FREQUENCY)
  frequency!: string;

  @IsString()
  @Length(1, MEDICINE_FIELD_LIMITS.DURATION)
  duration!: string;

  @IsOptional()
  @IsString()
  @Length(0, MEDICINE_FIELD_LIMITS.INSTRUCTIONS)
  instructions?: string;
}

/**
 * `PUT /consultations/:id/clinical-record` — the whole draft, every time.
 *
 * `PUT`, not `PATCH`, and the body carries the complete state of a
 * single-valued sub-resource: the consultation has exactly one clinical record
 * (`clinical_records.consultation_id` is UNIQUE), and a doctor's notes form
 * submits all of it. The same reasoning `availability.controller.ts` and
 * `instant-doctor.controller.ts` both give for `PUT`.
 *
 * *** `chiefComplaint` AND `riskCategory` ARE REQUIRED HERE, NOT AT
 * FINALISATION. *** Both are `NOT NULL` in `clinical_records`, so there is no
 * such thing as a draft without them — the row cannot be inserted. FR-11.1's
 * other mandatory fields (clinical history, diagnosis, referral) are nullable
 * columns and are the doctor's to fill in as the consultation goes; the
 * COMPLETION GATE (FR-11.5) is what refuses to close a case without the parts
 * that matter, and it lives in `clinical.service.ts#finalise`.
 *
 * `doctorId` is deliberately ABSENT — it always comes from `@CurrentUser()`,
 * never the body, so a doctor cannot write notes in somebody else's name.
 */
export class SaveClinicalRecordDto {
  @IsString()
  @Length(1, 4000)
  chiefComplaint!: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  clinicalHistory?: string;

  @IsOptional()
  @IsString()
  @Length(1, 4000)
  diagnosis?: string;

  /** Defaults to `true` in the column: a diagnosis is provisional unless the doctor says otherwise. */
  @IsOptional()
  @IsBoolean()
  isDiagnosisProvisional?: boolean;

  @IsIn([...RISK_CATEGORIES], { message: `riskCategory must be one of: ${RISK_CATEGORIES.join(', ')}.` })
  riskCategory!: RiskCategory;

  /** Set = an in-person or emergency referral was advised, and this is it. There is no separate boolean — see `clinical-records.schema.ts`. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  referralNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDICINE_LINES)
  @ValidateNested({ each: true })
  @Type(() => MedicineLineDto)
  medicines?: MedicineLineDto[];

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceCovered?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceHomePractice?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceNextFocus?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceWarningSigns?: string;

  /** FR-11.3's 3-to-5-line summary. Length is bounded, but "3 to 5 lines" is a clinical instruction, not a parser rule — the gate checks presence, not line count. */
  @IsOptional()
  @IsString()
  @Length(1, 4000)
  caseSummary?: string;
}

/** `POST /consultations/:id/clinical-record/apply-template` — copies one of the doctor's own templates into the draft. */
export class ApplyTemplateDto {
  @IsUUID('4', { message: 'templateId must be a valid UUID.' })
  templateId!: string;
}

/**
 * `POST /doctors/me/clinical-templates` (FR-9.6).
 *
 * *** DELIBERATELY NO `diagnosis` AND NO `chiefComplaint`. ***
 * `doctor-clinical-templates.schema.ts`: "FR-9.6 scopes this to cutting down
 * prescription/advice entry time; a pre-fillable diagnosis is a clinical-safety
 * hazard, not a convenience, and must be written fresh every consultation."
 * That is a rule about what a template may CONTAIN, so it is enforced by the
 * shape of this DTO and by the columns the table does not have — there is
 * nowhere for either field to go.
 */
export class SaveClinicalTemplateDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /** Optional context tag. When set, the composite FK requires it be one of this doctor's own specialties. `null`/absent = a general-purpose template. */
  @IsOptional()
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDICINE_LINES)
  @ValidateNested({ each: true })
  @Type(() => MedicineLineDto)
  medicines?: MedicineLineDto[];

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceCovered?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceHomePractice?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceNextFocus?: string;

  @IsOptional()
  @IsString()
  @Length(1, 8000)
  adviceWarningSigns?: string;
}

/** `GET /doctors/me/clinical-templates?specialtyId=` — the picker's optional narrowing. */
export class ListClinicalTemplatesQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId?: string;
}
