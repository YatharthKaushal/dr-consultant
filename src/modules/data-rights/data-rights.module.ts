import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CarehubModule } from '../carehub/carehub.module';
import { ClarificationModule } from '../clarification/clarification.module';
import { ClinicalModule } from '../clinical/clinical.module';
import { ConsentModule } from '../consent/consent.module';
import { DoctorModule } from '../doctor/doctor.module';
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
import { DataRightsExecutionSweepService } from './data-rights-execution-sweep.service';
import { DataRightsFacade } from './data-rights.facade';
import { DataRightsService } from './data-rights.service';
import { DeletedAccountsAdminController } from './deleted-accounts-admin.controller';
import { DeletedAccountsRepository } from './deleted-accounts.repository';
import { DeletedAccountsService } from './deleted-accounts.service';

/**
 * M-21's execution half: "Execution of the data deletion requests raised in
 * M-03" (`docs/MODULES.md`). Built last in the build order, after every
 * module whose data it surveys.
 *
 * *** THIS MODULE OWNS NO TABLE AND NO SCHEMA FILE, WITH ONE ADDITIVE
 * EXCEPTION (account-deletion lifecycle round): `deleted_accounts`. ***
 * Otherwise exactly the `GovernanceModule` shape: every method on
 * `DataRightsService` composes across the facades below and stores nothing
 * of its own — `data_deletion_requests` itself is `ConsentModule`'s table,
 * reached only through `DataDeletionExecutionFacade`, never written to
 * directly here. `deleted_accounts` is different: it is the "another copy,
 * for safety" this module's own compliance function exists to produce, so
 * this module owns it directly through `DeletedAccountsRepository`/
 * `DeletedAccountsService` — see `data-rights.service.ts`'s header for the
 * full reasoning.
 *
 * Seventeen facades is not a mistake: this module's whole job is to touch
 * every table the M-21 survey identified (patient path) or the much
 * shorter doctor one, and each of those tables belongs to a different
 * owning module. `DoctorModule` is ADDITIVE (account-deletion lifecycle
 * round) — a doctor's own deletion request is the second, narrower half of
 * this feature. `IdentityModule` is NOT imported — `PatientFacade`/
 * `DoctorFacade`'s soft-delete methods already reach `IdentityFacade`
 * internally (`IdentityModule` is `@Global()` in any case), and
 * `DeletedAccountsService`'s own `restoreMobileNumber` call does too.
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
    DoctorModule,
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
  controllers: [DataRightsAdminController, DeletedAccountsAdminController],
  providers: [
    DataRightsService,
    DataRightsFacade,
    // ADDITIVE (account-deletion lifecycle round): the "another copy, for
    // safety" table this module owns directly (see `data-rights.service.ts`'s
    // header for why), and the grace-period sweep that drives execution
    // when no admin reviews a request in time.
    DeletedAccountsRepository,
    DeletedAccountsService,
    DataRightsExecutionSweepService,
  ],
})
export class DataRightsModule {}
