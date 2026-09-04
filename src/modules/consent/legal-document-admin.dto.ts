import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { LEGAL_DOCUMENT_TYPES, type LegalDocumentType } from '../../schema/enums.schema';

/**
 * A new version is a NEW ROW — there is deliberately no update DTO. Once a
 * version exists, the only thing an admin may change about it is whether it is
 * the current one (`POST :id/publish`), because its text is the evidence of
 * what everyone who accepted it accepted.
 */
export class CreateLegalDocumentDto {
  @IsIn(LEGAL_DOCUMENT_TYPES)
  documentType!: LegalDocumentType;

  /**
   * Client-set (`legal-documents.schema.ts`) and unique per type. Constrained
   * to a printable, sortable token rather than free text: this string is what a
   * patient is shown as "you accepted v2.1", and what
   * `ConsentCheck.acceptedVersion` compares in the app's copy.
   */
  @IsString()
  @Length(1, 20)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'version may contain letters, digits, dots, dashes and underscores only.',
  })
  version!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  /** The legal text itself. `text` column — no upper bound beyond the sanity limit here. */
  @IsString()
  @Length(1, 200_000)
  body!: string;

  /**
   * Publish in the same transaction as the insert. Defaults to false: writing a
   * version and making it the one every patient must accept are different
   * decisions, and the safe default is "not yet live".
   */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

/** The optional `documentType` filter on the admin history list. */
export class ListLegalDocumentsQueryDto {
  @IsOptional()
  @IsIn(LEGAL_DOCUMENT_TYPES)
  documentType?: LegalDocumentType;
}
