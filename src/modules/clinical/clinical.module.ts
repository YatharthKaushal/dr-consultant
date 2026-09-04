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
import { BookingFacade } from '../booking/booking.facade';
import { CLINICAL_BOOKING_PORT } from './clinical.constants';

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
 * *** REBOUND. *** Now bound to `BookingFacade`, which satisfies
 * `ClinicalBookingPort` structurally: `ClinicalConsultationView` is a strict
 * subset of `BookingView`, and M-11 grew a `completeConsultation` sibling at
 * merge whose shape this port already named.
 *
 * `ConsultationCompletionProvider` — the placeholder that performed the guarded
 * UPDATE on `consultations` itself — HAS BEEN DELETED rather than kept unbound,
 * unlike every other null object in this codebase. Those are safe to keep: they
 * refuse, or they return nothing. This one WROTE ANOTHER MODULE'S TABLE, which
 * is precisely what `README.md` §2 forbids and what the port exists to stop. A
 * class like that left in the tree is a loaded gun, not a kill-switch.
 *
 * *** THE MOVE TO `completed` IS A THIRD SIBLING, NOT A WIDENING. *** M-14's
 * `transitionConsultationStatus` deliberately excludes `completed` so that no
 * caller can close a consultation and route around FR-11.5's completion gate —
 * the gate that lives in THIS module. */
@Module({
  imports: [BookingModule, CatalogueModule, DoctorModule, DocumentModule, InstantModule, PatientModule],
  controllers: [ClinicalController, ClinicalTemplateController, ClinicalAdminController],
  providers: [
    ClinicalRepository,
    ClinicalTemplateRepository,
    { provide: CLINICAL_BOOKING_PORT, useExisting: BookingFacade },
    ClinicalTemplateService,
    ClinicalPdfService,
    ClinicalService,
    ClinicalGateSweepService,
    ClinicalFacade,
  ],
  exports: [ClinicalFacade],
})
export class ClinicalModule {}
