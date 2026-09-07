import { Module } from '@nestjs/common';
import { NotificationFacade } from '../notification/notification.facade';
import { NotificationModule } from '../notification/notification.module';
import { ConsentController } from './consent.controller';
import { ConsentFacade } from './consent.facade';
import { ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';
import { DATA_DELETION_NOTIFICATION_PORT } from './data-deletion.constants';
import { DataDeletionAdminController } from './data-deletion-admin.controller';
import { DataDeletionController } from './data-deletion.controller';
import { DataDeletionExecutionFacade } from './data-deletion-execution.facade';
import { DataDeletionRepository } from './data-deletion.repository';
import { DataDeletionService } from './data-deletion.service';
import { DataDeletionPageController } from './data-deletion-page.controller';
import { LegalDocumentAdminController } from './legal-document-admin.controller';
import { LegalDocumentController } from './legal-document.controller';
import { LegalDocumentPublicController } from './legal-document-public.controller';
import { LegalDocumentRepository } from './legal-document.repository';
import { LegalDocumentService } from './legal-document.service';

/**
 * Not `@Global()` — like `CatalogueModule`, nothing outside this module
 * resolves a DI token from here; M-14 imports `ConsentModule` and binds the
 * exported `ConsentFacade` to its own port.
 *
 * `DATABASE` and `AuditService` are both `@Global()` (`DatabaseModule`,
 * `AuditModule`), so no `imports` are needed beyond `NotificationModule` —
 * ADDITIVE (notify-on-status-change round), for `DataDeletionService`'s own
 * `DATA_DELETION_NOTIFICATION_PORT` binding below.
 */
@Module({
  imports: [NotificationModule],
  controllers: [
    LegalDocumentController,
    LegalDocumentAdminController,
    LegalDocumentPublicController,
    ConsentController,
    DataDeletionController,
    DataDeletionAdminController,
    DataDeletionPageController,
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
    // ADDITIVE (notify-on-status-change round) — see
    // `data-deletion-notification.contract.ts`'s header for why this
    // indirection exists even though `NotificationFacade` is real and
    // already imported above.
    { provide: DATA_DELETION_NOTIFICATION_PORT, useExisting: NotificationFacade },
  ],
  exports: [ConsentFacade, DataDeletionExecutionFacade],
})
export class ConsentModule {}
