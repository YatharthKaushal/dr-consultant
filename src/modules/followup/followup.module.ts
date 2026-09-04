import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CarehubModule } from '../carehub/carehub.module';
import { CareHubFacade } from '../carehub/carehub.facade';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { ClinicalModule } from '../clinical/clinical.module';
import { IdentityFacade } from '../identity/identity.facade';
import { IdentityModule } from '../identity/identity.module';
import { NotificationFacade } from '../notification/notification.facade';
import { NotificationModule } from '../notification/notification.module';
import { ADMIN_DIRECTORY_PORT, CARE_HUB_PORT, FOLLOWUP_NOTIFICATION_PORT } from './followup.constants';
import { FollowupAlertAdminController } from './followup-alert-admin.controller';
import { FollowupAlertService } from './followup-alert.service';
import { FollowupClinicalListener } from './followup-clinical.listener';
import { FollowupPathwayAdminController } from './followup-pathway-admin.controller';
import { FollowupCheckinSweepService } from './followup-checkin-sweep.service';
import { FollowupController } from './followup.controller';
import { FollowupFacade } from './followup.facade';
import { FollowupPathwayRepository } from './followup-pathway.repository';
import { FollowupPathwayService } from './followup-pathway.service';
import { FollowupRepository } from './followup.repository';
import { FollowupService } from './followup.service';
import { UnavailableAdminDirectoryProvider } from './unavailable-admin-directory.provider';
import { UnavailableCareHubProvider } from './unavailable-care-hub.provider';

/**
 * M-16: Follow-Up and Patient Safety.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; a future module would consume
 * `FollowupFacade` via normal constructor injection after importing
 * `FollowupModule`.
 *
 * ---------------------------------------------------------------------------
 * *** THIS MODULE OWNS FOUR TABLES AND READS NOBODY ELSE'S. ***
 *
 * `followup_pathways`, `checkin_responses`, `safety_alerts` (the three named
 * in this module's build plan as pre-existing) and `followup_assignments`
 * (added by this worktree — see that schema file's header for the full
 * argument for why). Every other fact this module needs arrives through a
 * facade or a port:
 *
 *   `consultations`         `BookingFacade`, injected directly — M-11 is
 *                           already merged, the same reasoning
 *                           `clinical.module.ts` gives for the identical
 *                           choice.
 *   `clinical_records`      `ClinicalFacade`, injected directly — M-15 is
 *                           already merged. `getCarePlanInputs` was built
 *                           FOR this module (`clinical.contract.ts`'s own
 *                           header names M-16 as its one read consumer).
 *                           `CLINICAL_RECORD_FINALISED_EVENT` (also on that
 *                           facade's surface) is what calls `assignPathway`
 *                           now — see `followup-clinical.listener.ts`.
 *   `concerns`               `CatalogueFacade.getConcernById`, read only by
 *                           `followup-clinical.listener.ts` to resolve which
 *                           pathway a finalised consultation's concern maps
 *                           to.
 *   Notifications            `FOLLOWUP_NOTIFICATION_PORT`, bound directly to
 *                           the real `NotificationFacade` — M-08 is already
 *                           merged too, so unlike every "parallel worktree"
 *                           port in this codebase there is no placeholder
 *                           period to wait out.
 *   Care Hub content         `CARE_HUB_PORT`, bound to the real
 *                           `CareHubFacade` (M-18) — rebound post-merge,
 *                           `UnavailableCareHubProvider` stays in the tree
 *                           unbound as the kill-switch.
 *   Admins by permission     `ADMIN_DIRECTORY_PORT`, bound to the real
 *                           `IdentityFacade` — rebound post-merge,
 *                           `UnavailableAdminDirectoryProvider` stays in the
 *                           tree unbound as the kill-switch. See
 *                           `identity-access.repository.ts
 *                           #listAdminIdsWithPermission` for the query.
 *
 * ---------------------------------------------------------------------------
 * *** COORDINATOR POST-MERGE UPDATE — READ BEFORE TRUSTING THE PARAGRAPH THIS
 * REPLACED (IT'S STILL VISIBLE IN GIT HISTORY, AND IT NOW OVERSTATES THE GAP).
 * ***
 *
 * `followup.service.ts#assignPathway` DOES have a caller now:
 * `followup-clinical.listener.ts`, `@OnEvent(CLINICAL_RECORD_FINALISED_EVENT)`,
 * added post-merge along with the emit in `clinical.service.ts#finalise` and
 * a `getConcernById` read via `CatalogueFacade`. This module was otherwise
 * built to the letter of its guardrails — `src/modules/booking/*`,
 * `src/modules/identity/*` and `src/modules/notification/*` are still
 * untouched by it.
 *
 * ONE GAP REMAINS OPEN, DELIBERATELY, ACROSS THIS MERGE:
 *
 *   `followup.service.ts#recommendFollowUpBooking`   resolves WHO a follow-up
 *                                         should target; does not CREATE one
 *                                         — `BookingContract` has no method
 *                                         for it yet. Building "book the
 *                                         earliest available doctor" is real
 *                                         scheduling-search work, not a small
 *                                         additive method, and was judged not
 *                                         worth rushing alongside everything
 *                                         else in this merge.
 *
 * ALSO STILL OPEN, NOTED BUT NOT FIXED: the pathway pin lives ONLY in
 * `followup_assignments` (see that schema file's header), never mirrored onto
 * `consultations.followup_pathway_id`/`followup_starts_on`/`followup_status`
 * — booking's own columns, pre-modeled for exactly this. That table's header
 * and `booking.mapper.ts#toBookingView`'s comment both already say the right
 * fix is an additive `BookingContract` method (the `completeConsultation`
 * pattern). It works correctly as built; the duplication is a known,
 * flagged piece of tech debt for a future round, not a bug.
 *
 * Neither gap blocks this module's own done-when criteria (`docs/MODULES.md`:
 * "a red answer produces patient guidance and both alerts, an admin edit to a
 * question set reaches the app with no release, and the Care Plan composes
 * from the owning modules without copying their data").
 */
@Module({
  imports: [BookingModule, CarehubModule, CatalogueModule, ClinicalModule, IdentityModule, NotificationModule],
  controllers: [FollowupController, FollowupPathwayAdminController, FollowupAlertAdminController],
  providers: [
    FollowupRepository,
    FollowupPathwayRepository,
    { provide: FOLLOWUP_NOTIFICATION_PORT, useExisting: NotificationFacade },
    // Rebound from `UnavailableCareHubProvider` post-merge: `CareHubFacade`
    // (M-18) satisfies `CareHubPort` structurally with zero field renames,
    // exactly as that contract file's own header predicted. The provider
    // class stays in the tree, unbound, as the hard kill-switch every other
    // port in this codebase keeps for the same reason.
    { provide: CARE_HUB_PORT, useExisting: CareHubFacade },
    // Rebound from `UnavailableAdminDirectoryProvider` post-merge:
    // `IdentityFacade.listAdminIdsWithPermission` now exists (added for
    // exactly this seam — see `identity.contract.ts`). The provider class
    // stays in the tree, unbound, as the hard kill-switch every other port
    // in this codebase keeps for the same reason.
    { provide: ADMIN_DIRECTORY_PORT, useExisting: IdentityFacade },
    FollowupPathwayService,
    FollowupAlertService,
    FollowupService,
    FollowupCheckinSweepService,
    FollowupClinicalListener,
    FollowupFacade,
  ],
  exports: [FollowupFacade],
})
export class FollowupModule {}
