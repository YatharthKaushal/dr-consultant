import { IsDateString, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { ACCOUNT_STATUSES, GENDERS, type AccountStatus, type Gender } from '../../schema/enums.schema';

/** Partial update — every field optional, all present fields applied in one write. See patient.service.ts for the pending->active profile-completion rule this feeds. */
export class UpdatePatientProfileDto {
  /** Matches patients.full_name's varchar(160). */
  @IsOptional()
  @IsString()
  @Length(1, 160)
  fullName?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender;

  /** Matches patients.preferred_language's varchar(40). */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  preferredLanguage?: string;
}

export class UpdatePatientStatusDto {
  @IsIn(ACCOUNT_STATUSES)
  status!: AccountStatus;
}
