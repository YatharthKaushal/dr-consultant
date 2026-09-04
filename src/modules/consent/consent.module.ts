import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentFacade } from './consent.facade';
import { ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';
import { LegalDocumentAdminController } from './legal-document-admin.controller';
import { LegalDocumentController } from './legal-document.controller';
import { LegalDocumentRepository } from './legal-document.repository';
import { LegalDocumentService } from './legal-document.service';

/**
 * Not `@Global()` — like `CatalogueModule`, nothing outside this module
 * resolves a DI token from here; M-14 imports `ConsentModule` and binds the
 * exported `ConsentFacade` to its own port.
 *
 * `DATABASE` and `AuditService` are both `@Global()` (`DatabaseModule`,
 * `AuditModule`), so no `imports` are needed.
 */
@Module({
  controllers: [LegalDocumentController, LegalDocumentAdminController, ConsentController],
  providers: [LegalDocumentRepository, ConsentRepository, LegalDocumentService, ConsentService, ConsentFacade],
  exports: [ConsentFacade],
})
export class ConsentModule {}
