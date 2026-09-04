import { Controller, Get, Param } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { LegalDocumentService, parseLegalDocumentType } from './legal-document.service';

/**
 * FR-2.4: the patient reads the privacy policy, the terms of use and the refund
 * policy in the app (M-03 adds the reconsult policy, and the teleconsultation
 * consent text itself, which is the screen consent is given on).
 *
 * No logic here — parse, authorise via decorators, delegate. Reads are
 * authenticated like every other route in this codebase; the app fetches them
 * after sign-in, and `@Public()` is reserved for the routes that genuinely
 * cannot have a token (`identity`'s OTP pair).
 *
 * `doctor_agreement` is filtered out for patients by the service, not here —
 * the audience rule is a property of the document type, not of one endpoint.
 */
@Controller('legal-documents')
@AccountType('patient', 'doctor', 'admin')
export class LegalDocumentController {
  constructor(private readonly service: LegalDocumentService) {}

  /** Every published document this account type may read, without bodies. */
  @Get()
  listCurrent(@CurrentUser() auth: AuthContext) {
    return this.service.listCurrentForAccountType(auth.accountType);
  }

  /** The current version of one type, in full. 404 when nothing is published for it. */
  @Get(':documentType')
  getCurrent(@CurrentUser() auth: AuthContext, @Param('documentType') documentType: string) {
    return this.service.getCurrentForAccountType(parseLegalDocumentType(documentType), auth.accountType);
  }
}
