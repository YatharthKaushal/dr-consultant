import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentFacade } from './consent.facade';
import { ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';
import { DataDeletionAdminController } from './data-deletion-admin.controller';
import { DataDeletionController } from './data-deletion.controller';
import { DataDeletionExecutionFacade } from './data-deletion-execution.facade';
import { DataDeletionRepository } from './data-deletion.repository';
import { DataDeletionService } from './data-deletion.service';
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
  controllers: [
    LegalDocumentController,
    LegalDocumentAdminController,
    ConsentController,
    DataDeletionController,
    DataDeletionAdminController,
  ],
  providers: [
    LegalDocumentRepository,
    ConsentRepository,
    DataDeletionRepository,
    LegalDocumentService,
    ConsentService,
    DataDeletionService,
    ConsentFacade,
    // *** ADDITIVE (M-21/data rights execution). *** A second, deliberately
    // separate facade — see `data-deletion-execution.contract.ts`'s header
    // for why this is not a widening of `ConsentFacade`/`ConsentContract`.
    DataDeletionExecutionFacade,
  ],
  exports: [ConsentFacade, DataDeletionExecutionFacade],
})
export class ConsentModule {}
