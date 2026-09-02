import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PATIENT_FILE_CATEGORIES, type PatientFileCategory } from '../../schema/enums.schema';

/**
 * `GET /documents/me?category=`. Accepts any `PATIENT_FILE_CATEGORIES` value
 * (not just `PATIENT_UPLOADABLE_CATEGORIES`) — this is a LISTING filter over
 * files that already exist, not an upload-time allowlist, so a patient can
 * still filter to e.g. `prescription_pdf` once a future M-15 writes one
 * against their record. `clarification_attachment` will simply always come
 * back empty for a patient-scoped list, since those rows carry
 * `patient_id: null` by the schema's own CHECK constraint.
 */
export class ListOwnDocumentsQueryDto {
  @IsOptional()
  @IsIn(PATIENT_FILE_CATEGORIES)
  category?: PatientFileCategory;
}

/** `POST /consultations/:id/report-requests`. `title`/`reason` match `report_requests.schema.ts`'s own column lengths (`varchar(160)` / `text`). */
export class CreateReportRequestDto {
  @IsString()
  @Length(1, 160)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(1, 4000)
  reason?: string;
}
