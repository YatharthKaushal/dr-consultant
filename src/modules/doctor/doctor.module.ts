import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { IdentityModule } from '../identity/identity.module';
import { DoctorAdminController } from './doctor-admin.controller';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorDocumentService } from './doctor-document.service';
import { DoctorReliabilityService } from './doctor-reliability.service';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import { DoctorVerificationService } from './doctor-verification.service';
import { DoctorController } from './doctor.controller';
import { DoctorFacade } from './doctor.facade';
import { DoctorRepository } from './doctor.repository';
import { DoctorService } from './doctor.service';

/**
 * Not `@Global()` — unlike identity, nothing outside this module resolves a
 * DI token from here; other modules consume `DoctorFacade` via normal
 * constructor injection after importing `DoctorModule`.
 *
 * `IdentityModule` is imported for clarity even though it's `@Global()` (Nest
 * resolves global providers regardless of import graph) — `DoctorVerification
 * Service` injects `IdentityFacade` directly for `revokeAllSessions`.
 * `CatalogueModule` is a real (non-global) import — `DoctorService`/
 * `DoctorSpecialtyService` resolve `CatalogueFacade` from it to enrich
 * `doctor_specialties` rows instead of reading `specialties` directly.
 */
@Module({
  imports: [IdentityModule, CatalogueModule],
  controllers: [DoctorController, DoctorAdminController],
  providers: [
    DoctorRepository,
    DoctorSpecialtyRepository,
    DoctorDocumentRepository,
    DoctorService,
    DoctorVerificationService,
    DoctorSpecialtyService,
    DoctorDocumentService,
    DoctorReliabilityService,
    DoctorFacade,
  ],
  exports: [DoctorFacade],
})
export class DoctorModule {}
