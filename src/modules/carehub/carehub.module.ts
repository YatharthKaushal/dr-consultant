import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { CarehubAdminController } from './carehub-admin.controller';
import { CarehubDoctorController } from './carehub-doctor.controller';
import { CarehubShareController } from './carehub-share.controller';
import { CarehubController } from './carehub.controller';
import { CareHubFacade } from './carehub.facade';
import { CarehubRepository } from './carehub.repository';
import { CarehubService } from './carehub.service';

/**
 * M-18: Care Hub. Depends on M-02 (identity, via `shared/auth`, `@Global()`
 * — no import needed) and M-06 (catalogue) only, per `docs/MODULES.md`.
 *
 * `BookingModule` is imported too, but NOT as one of the two declared
 * dependencies — `docs/MODULES.md` lists M-18 depending on M-02/M-06 only.
 * It is here for exactly one narrow reason: the brief's own named seam for
 * the doctor-recommendation ownership check ("the cleanest existing seam is
 * `BookingFacade.getBooking(consultationId)`") — the same "does this
 * consultation exist, and whose is it" read `document`'s
 * `ConsultationLookupProvider` placeholder exists to avoid needing before
 * M-11 existed. M-11 exists now, so this module reads it directly rather
 * than inventing its own placeholder for a fact `BookingFacade` already
 * answers. No table this module owns depends on booking, and nothing here
 * writes through `BookingFacade` — a read-only dependency for one ownership
 * check, the same shape `ClinicalModule` takes on `CatalogueFacade` for its
 * own point-of-use reads.
 *
 * `DATABASE` and `AuditService` are `@Global()`, so neither needs an
 * `imports` entry.
 *
 * *** THIS MODULE DOES NOT REBIND `CARE_HUB_PORT`. *** That token lives in
 * `modules/followup`, which this module does not import and does not touch.
 * The coordinator rebinds it post-merge — see `carehub.facade.ts`.
 */
@Module({
  imports: [CatalogueModule, BookingModule],
  controllers: [CarehubController, CarehubDoctorController, CarehubShareController, CarehubAdminController],
  providers: [CarehubRepository, CarehubService, CareHubFacade],
  exports: [CareHubFacade],
})
export class CarehubModule {}
