import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { DOCTOR_DOCUMENT_TYPES, type DoctorDocumentType } from '../../schema/enums.schema';

/**
 * Self-editable fields ONLY (`PATCH /doctors/me`). Everything else on
 * `doctors` — qualification, registrationNumber, fee, verificationStatus,
 * listing, expert role — is admin-controlled; a doctor must never be able to
 * set their own verification status or fee. There is no `@IsOptional()`-less
 * required field here on purpose: both fields are independently patchable.
 */
export class UpdateOwnDoctorProfileDto {
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  bio?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];
}

export class CreateDoctorDocumentDto {
  @IsIn(DOCTOR_DOCUMENT_TYPES)
  documentType!: DoctorDocumentType;

  /**
   * The object-store key the caller already has from elsewhere — this module
   * owns the document METADATA/review workflow row, not the upload
   * mechanism (M-10 doesn't exist yet).
   */
  @IsString()
  @Length(1, 2048)
  storageKey!: string;

  @IsString()
  @Length(1, 255)
  fileName!: string;
}
