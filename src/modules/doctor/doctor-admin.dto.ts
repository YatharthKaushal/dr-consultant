import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  DOCTOR_SENIORITY_LEVELS,
  DOCTOR_VERIFICATION_STATUSES,
  type DoctorSeniority,
  type DoctorVerificationStatus,
} from '../../schema/enums.schema';

export class CreateDoctorDto {
  @IsPhoneNumber('IN')
  mobileNumber!: string;

  @IsString()
  @Length(1, 160)
  fullName!: string;
}

/**
 * Admin-editable PROFILE fields only. Fee, listing, verification status and
 * expert role each have their own endpoint/permission (`DOCTORS_MANAGE_FEE`,
 * `DOCTORS_MANAGE_LISTING`, `DOCTORS_VERIFY`, `DOCTORS_MANAGE_EXPERT_ROLE`) —
 * deliberately not accepted here even though this is also admin-only, so a
 * single `DOCTORS_UPDATE` grant can never silently reach into those other
 * permissions' territory.
 */
export class UpdateDoctorDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  qualification?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  registrationNumber?: string;

  /** `smallint` column — bounded to its Postgres range. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  yearsOfExperience?: number;

  /** `smallint` column — bounded to its Postgres range. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  consultationDurationMinutes?: number;

  /** `smallint` column — bounded to its Postgres range. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  bufferMinutes?: number;
}

export class UpdateDoctorVerificationDto {
  @IsIn(DOCTOR_VERIFICATION_STATUSES)
  status!: DoctorVerificationStatus;
}

export class UpdateDoctorListingDto {
  @IsOptional()
  @IsBoolean()
  isListed?: boolean;

  @IsOptional()
  @IsBoolean()
  allowInstantConsult?: boolean;
}

export class UpdateDoctorFeeDto {
  /**
   * `numeric(10, 2)` column — true ceiling is 99999999.99, but nothing in
   * the SRS names a real fee ceiling for a consultation, so this is capped
   * well below that at a clearly-generous-but-finite ₹10,00,000 (1,000,000)
   * to reject an obvious fat-fingered/overflow value before it reaches
   * Postgres as a `numeric field overflow`. `maxDecimalPlaces: 2` matches
   * the column's `scale`.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  consultationFeeInr!: number;
}

export class UpdateDoctorExpertRoleDto {
  @IsIn(DOCTOR_SENIORITY_LEVELS)
  seniorityLevel!: DoctorSeniority;
}

export class AssignDoctorSpecialtyDto {
  @IsUUID()
  specialtyId!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

const DOCUMENT_REVIEW_DECISIONS = ['approved', 'rejected'] as const;
type DocumentReviewDecision = (typeof DOCUMENT_REVIEW_DECISIONS)[number];

export class ReviewDoctorDocumentDto {
  @IsIn(DOCUMENT_REVIEW_DECISIONS)
  reviewStatus!: DocumentReviewDecision;

  /** Required when `reviewStatus === 'rejected'` — enforced in the service, since it depends on the sibling field's value. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  rejectionReason?: string;
}
