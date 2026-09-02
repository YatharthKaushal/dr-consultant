import { Module } from '@nestjs/common';
import { StorageFacade } from '../storage/storage.facade';
import { StorageModule } from '../storage/storage.module';
import { CONSULTATION_LOOKUP_PROVIDER, DOCUMENT_STORAGE_PORT } from './document.constants';
import { ConsultationLookupProvider } from './consultation-lookup.provider';
import { DocumentConsultationController } from './document-consultation.controller';
import { DocumentController } from './document.controller';
import { DocumentFacade } from './document.facade';
import { PatientFileRepository } from './patient-file.repository';
import { PatientFileService } from './patient-file.service';
import { ReportRequestRepository } from './report-request.repository';
import { ReportRequestService } from './report-request.service';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`/`AvailabilityModule`
 * /`SearchModule`, nothing outside this module resolves a DI token from
 * here; other modules consume `DocumentFacade` via normal constructor
 * injection after importing `DocumentModule`. `DATABASE`, `AuditService` and
 * `AppConfigService` are all `@Global()`, so no `imports` entry is needed for
 * those — `StorageModule` is a real import, because `DOCUMENT_STORAGE_PORT`
 * resolves `StorageFacade` from it (below). This module's one OTHER
 * cross-module read (`consultations`) goes through the placeholder below,
 * not a facade call, because M-11 doesn't exist yet.
 *
 * ---------------------------------------------------------------------------
 * `DOCUMENT_STORAGE_PORT` is bound to the real `StorageFacade` (M-10 merge).
 * `StorageFacade` satisfies `DocumentStoragePort` structurally (see
 * `document-storage.contract.ts`) — no adapter, no cast — so a signature
 * drift on either side surfaces here as a `tsc` error rather than a runtime
 * surprise. `UnavailableDocumentStorageProvider` stays in the tree, unbound:
 * it is the null-object this module was built and tested against, and it is
 * what you rebind here to take storage out of the request path at the DI
 * level — the harder kill-switch, one level below `StorageFacade`'s own
 * provider-priority/`isActive` admin controls.
 *
 * `CONSULTATION_LOOKUP_PROVIDER` is bound to `ConsultationLookupProvider` (a
 * placeholder reading `consultations` directly — M-11/Booking doesn't exist
 * yet, mirrors `availability.module.ts`'s `BUSY_INTERVAL_PROVIDER`). Swapped
 * for a `BookingFacade`-backed implementation once M-11 exists, with no
 * change to either service in this module.
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentController, DocumentConsultationController],
  providers: [
    PatientFileRepository,
    ReportRequestRepository,
    { provide: CONSULTATION_LOOKUP_PROVIDER, useClass: ConsultationLookupProvider },
    { provide: DOCUMENT_STORAGE_PORT, useExisting: StorageFacade },
    PatientFileService,
    ReportRequestService,
    DocumentFacade,
  ],
  exports: [DocumentFacade],
})
export class DocumentModule {}
