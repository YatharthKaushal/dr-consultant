import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { DoctorModule } from '../doctor/doctor.module';
import { DocumentModule } from '../document/document.module';
import { InstantModule } from '../instant/instant.module';
import { PatientModule } from '../patient/patient.module';
import { ClinicalAdminController } from './clinical-admin.controller';
import { ClinicalController } from './clinical.controller';
import { ClinicalFacade } from './clinical.facade';
import { ClinicalGateSweepService } from './clinical-gate-sweep.service';
import { ClinicalPdfService } from './clinical-pdf.service';
import { ClinicalRepository } from './clinical.repository';
import { ClinicalService } from './clinical.service';
import { ClinicalTemplateController } from './clinical-template.controller';
import { ClinicalTemplateRepository } from './clinical-template.repository';
import { ClinicalTemplateService } from './clinical-template.service';
import { CLINICAL_BOOKING_PORT } from './clinical.constants';
import { ConsultationCompletionProvider } from './consultation-completion.provider';

/**
 * M-15: Clinical Records.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; M-16 and M-17 will consume
 * `ClinicalFacade` via normal constructor injection after importing
 * `ClinicalModule`.
 *
 * ---------------------------------------------------------------------------
 * *** THIS MODULE OWNS TWO TABLES AND READS NOBODY ELSE'S. ***
 *
 * `clinical_records` and `doctor_clinical_templates`, and nothing else. Every
 * other fact it needs arrives through a facade:
 *
 *   `consultations`   `CLINICAL_BOOKING_PORT` (see below)
 *   `specialties`     `CatalogueFacade.getSpecialtyById` — THE PRESCRIBING
 *                     GATE, read from the consultation's booking-time snapshot
 *   `doctors`         `DoctorFacade.getPrescribingEligibility` for a doctor's
 *                     own TEMPLATES, `getPublicProfile` for the PDF
 *   `patients`        `PatientFacade.getProfileSummary` for the PDF
 *   `patient_files`   `DocumentFacade.writePrescriptionPdf`
 *   `doctors.blocked_by_consultation_id`
 *                     `InstantFacade.clearCompletionGate` — FR-10.5
 *
 * `DATABASE`, `AuditService` and `AppConfigService` are all `@Global()`, so
 * they need no `imports` entry. The one read of a table this module does not
 * own is `audit_log`, which no module owns; `clinical.repository.ts` argues it.
 *
 * ---------------------------------------------------------------------------
 * *** `CLINICAL_BOOKING_PORT` IS THE ONE THING THE COORDINATOR MUST LOOK AT. ***
 *
 * Bound to `ConsultationCompletionProvider`, which delegates its READ to the
 * real `BookingFacade` and performs ONE write — the move to `completed` —
 * itself, because `BookingContract` has no method that can express it
 * (`transitionInstantConsultation` is narrowed to three other target statuses
 * and refuses non-instant rows) and M-14 is being built in a parallel worktree
 * this one cannot import from.
 *
 * *** POST-MERGE: change one line here. *** Once `BookingFacade` carries a
 * `completeConsultation` matching `clinical-booking.contract.ts`:
 *
 *     { provide: CLINICAL_BOOKING_PORT, useExisting: BookingFacade }
 *
 * and `ConsultationCompletionProvider` can be deleted or kept unbound as the
 * placeholder this module was built and tested against — the same disposal
 * `document.module.ts` describes for `UnavailableDocumentStorageProvider` and
 * `instant.module.ts` for `UnavailableNotificationProvider`. Because TypeScript
 * is structural, a signature drift on either side surfaces at that binding as a
 * `tsc` error rather than a runtime surprise. Read
 * `clinical-booking.contract.ts` for the exact assumed signature.
 *
 * ---------------------------------------------------------------------------
 * *** NO IMPORT CYCLE, AND NONE POSSIBLE TODAY. ***
 *
 * This module imports six others and NOTHING imports it. `InstantModule`
 * already imports `BookingModule`/`DoctorModule`, and `DocumentModule` imports
 * `StorageModule`; adding this module on top of all of them closes no loop
 * because the dependency runs strictly one way. The first module to import
 * `ClinicalModule` will be M-16 — also one way.
 *
 * ---------------------------------------------------------------------------
 * *** THE SWEEP IS A PROVIDER, NOT A CRON JOB. ***
 *
 * `ClinicalGateSweepService` starts its own `setInterval` in `onModuleInit` and
 * clears it in `onApplicationShutdown`. `@nestjs/schedule` is NOT installed and
 * this module does not add it — `booking-slot-hold.service.ts` makes that
 * argument in full and this module copies it verbatim, down to the `.unref()`
 * and the re-entrancy guard.
 */
@Module({
  imports: [BookingModule, CatalogueModule, DoctorModule, DocumentModule, InstantModule, PatientModule],
  controllers: [ClinicalController, ClinicalTemplateController, ClinicalAdminController],
  providers: [
    ClinicalRepository,
    ClinicalTemplateRepository,
    { provide: CLINICAL_BOOKING_PORT, useClass: ConsultationCompletionProvider },
    ClinicalTemplateService,
    ClinicalPdfService,
    ClinicalService,
    ClinicalGateSweepService,
    ClinicalFacade,
  ],
  exports: [ClinicalFacade],
})
export class ClinicalModule {}
