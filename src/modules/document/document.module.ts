import { Module } from '@nestjs/common';
import { CONSULTATION_LOOKUP_PROVIDER, DOCUMENT_STORAGE_PORT } from './document.constants';
import { ConsultationLookupProvider } from './consultation-lookup.provider';
import { DocumentConsultationController } from './document-consultation.controller';
import { DocumentController } from './document.controller';
import { DocumentFacade } from './document.facade';
import { PatientFileRepository } from './patient-file.repository';
import { PatientFileService } from './patient-file.service';
import { ReportRequestRepository } from './report-request.repository';
import { ReportRequestService } from './report-request.service';
import { UnavailableDocumentStorageProvider } from './unavailable-document-storage.provider';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`/`AvailabilityModule`
 * /`SearchModule`, nothing outside this module resolves a DI token from
 * here; other modules consume `DocumentFacade` via normal constructor
 * injection after importing `DocumentModule`. No `imports` needed: `DATABASE`,
 * `AuditService` and `AppConfigService` are all `@Global()`, and this module
 * has no dependency on any other feature module's facade — its one
 * cross-module read (`consultations`) goes through the placeholder below,
 * not a facade call, because M-11 doesn't exist yet.
 *
 * ---------------------------------------------------------------------------
 * `DOCUMENT_STORAGE_PORT` is bound to `UnavailableDocumentStorageProvider` —
 * a placeholder, since `modules/storage` is being built in a parallel
 * worktree and does not exist here. *** POST-MERGE WIRING ***: once
 * `modules/storage` is merged, change ONE entry below:
 *
 *   imports:   [..., StorageModule]
 *   providers: [..., { provide: DOCUMENT_STORAGE_PORT, useExisting: StorageFacade }]
 *
 * exactly like `SEARCH_AI_PORT` was rebound to `AiFacade` post-M-09-merge
 * (see `search.module.ts`). `StorageFacade` must satisfy `DocumentStoragePort`
 * structurally — see `document-storage.contract.ts`. Nothing else in this
 * module, or its tests, needs to change.
 *
 * `CONSULTATION_LOOKUP_PROVIDER` is bound to `ConsultationLookupProvider` (a
 * placeholder reading `consultations` directly — M-11/Booking doesn't exist
 * yet, mirrors `availability.module.ts`'s `BUSY_INTERVAL_PROVIDER`). Swapped
 * for a `BookingFacade`-backed implementation once M-11 exists, with no
 * change to either service in this module.
 */
@Module({
  controllers: [DocumentController, DocumentConsultationController],
  providers: [
    PatientFileRepository,
    ReportRequestRepository,
    { provide: CONSULTATION_LOOKUP_PROVIDER, useClass: ConsultationLookupProvider },
    { provide: DOCUMENT_STORAGE_PORT, useClass: UnavailableDocumentStorageProvider },
    PatientFileService,
    ReportRequestService,
    DocumentFacade,
  ],
  exports: [DocumentFacade],
})
export class DocumentModule {}
