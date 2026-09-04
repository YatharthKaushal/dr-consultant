import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CarehubModule } from '../carehub/carehub.module';
import { ClarificationModule } from '../clarification/clarification.module';
import { ClinicalModule } from '../clinical/clinical.module';
import { ConsentModule } from '../consent/consent.module';
import { DocumentModule } from '../document/document.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { FollowupModule } from '../followup/followup.module';
import { InstantModule } from '../instant/instant.module';
import { NotificationModule } from '../notification/notification.module';
import { PatientModule } from '../patient/patient.module';
import { PaymentModule } from '../payment/payment.module';
import { PricingModule } from '../pricing/pricing.module';
import { PromotionModule } from '../promotion/promotion.module';
import { SearchModule } from '../search/search.module';
import { VideoModule } from '../video/video.module';
import { DataRightsAdminController } from './data-rights-admin.controller';
import { DataRightsFacade } from './data-rights.facade';
import { DataRightsService } from './data-rights.service';

/**
 * M-21's execution half: "Execution of the data deletion requests raised in
 * M-03" (`docs/MODULES.md`). Built last in the build order, after every
 * module whose data it surveys.
 *
 * *** THIS MODULE OWNS NO TABLE AND NO SCHEMA FILE. *** Exactly the
 * `GovernanceModule` shape: every method on `DataRightsService` composes
 * across the facades below and stores nothing of its own — `data_deletion_
 * requests` itself is `ConsentModule`'s table, reached only through
 * `DataDeletionExecutionFacade`, never written to directly here.
 *
 * Sixteen facades is not a mistake: this module's whole job is to touch
 * every table the M-21 survey identified, and each of those tables belongs
 * to a different owning module. `IdentityModule` is NOT imported —
 * `PatientFacade.anonymizeForDeletion` already reaches `IdentityFacade`
 * internally (`IdentityModule` is `@Global()` in any case).
 *
 * Not `@Global()` — like `GovernanceModule`, nothing depends on this module;
 * it is the last one in the build order and exports nothing beyond what its
 * own controller needs, reached through DI within this module only.
 */
@Module({
  imports: [
    BookingModule,
    CarehubModule,
    ClarificationModule,
    ClinicalModule,
    ConsentModule,
    DocumentModule,
    FeedbackModule,
    FollowupModule,
    InstantModule,
    NotificationModule,
    PatientModule,
    PaymentModule,
    PricingModule,
    PromotionModule,
    SearchModule,
    VideoModule,
  ],
  controllers: [DataRightsAdminController],
  providers: [DataRightsService, DataRightsFacade],
})
export class DataRightsModule {}
