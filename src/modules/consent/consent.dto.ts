import { IsIn, IsUUID } from 'class-validator';
import { LEGAL_DOCUMENT_TYPES, type LegalDocumentType } from '../../schema/enums.schema';

/**
 * Acceptance names the EXACT version by id, not the document type. The client
 * displayed one specific text and the user accepted that one — resolving "the
 * current privacy policy" server-side would happily record consent to a version
 * published while the screen was open, which nobody read.
 */
export class RecordConsentDto {
  @IsUUID()
  legalDocumentId!: string;
}

/** `GET /consents/status` — which document type the pre-consult screen is asking about. */
export class ConsentStatusQueryDto {
  @IsIn(LEGAL_DOCUMENT_TYPES)
  documentType!: LegalDocumentType;
}
