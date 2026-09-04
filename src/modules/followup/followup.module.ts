import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { ClinicalModule } from '../clinical/clinical.module';
import { NotificationFacade } from '../notification/notification.facade';
import { NotificationModule } from '../notification/notification.module';
import { ADMIN_DIRECTORY_PORT, CARE_HUB_PORT, FOLLOWUP_NOTIFICATION_PORT } from './followup.constants';
import { FollowupAlertAdminController } from './followup-alert-admin.controller';
import { FollowupAlertService } from './followup-alert.service';
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
 *   Notifications            `FOLLOWUP_NOTIFICATION_PORT`, bound directly to
 *                           the real `NotificationFacade` — M-08 is already
 *                           merged too, so unlike every "parallel worktree"
 *                           port in this codebase there is no placeholder
 *                           period to wait out.
 *   Care Hub content         `CARE_HUB_PORT`, bound to
 *                           `UnavailableCareHubProvider` — M-18 does not
 *                           exist yet. Returns `[]`.
 *   Admins by permission     `ADMIN_DIRECTORY_PORT`, bound to
 *                           `UnavailableAdminDirectoryProvider` — no
 *                           existing facade lists admins by permission; see
 *                           that contract's header for the gap and what
 *                           closes it.
 *
 * ---------------------------------------------------------------------------
 * *** WHAT THIS MODULE DID NOT TOUCH, AND WHY IT MATTERS. ***
 *
 * `src/modules/booking/*`, `src/modules/clinical/*`, `src/modules/identity/*`
 * and `src/modules/notification/*` are all UNCHANGED by this worktree — this
 * module's guardrails scoped every change to `src/modules/followup/`,
 * `src/schema/` and this file's own registration in `app.module.ts`. Two
 * consequences of that are load-bearing and are documented at their actual
 * call sites, not just here:
 *
 *   `followup.service.ts#assignPathway`   the pathway pin lives ONLY in
 *                                         `followup_assignments`, never
 *                                         mirrored onto
 *                                         `consultations.followup_pathway_id`
 *                                         (booking's column, unreachable
 *                                         without an additive
 *                                         `BookingContract` method this
 *                                         worktree does not add).
 *
 *   `followup.service.ts#recommendFollowUpBooking`   resolves WHO a follow-up
 *                                         should target; does not CREATE one
 *                                         — `BookingContract` has no method
 *                                         for it yet.
 *
 * Neither blocks this module's own done-when criteria (`docs/MODULES.md`:
 * "a red answer produces patient guidance and both alerts, an admin edit to a
 * question set reaches the app with no release, and the Care Plan composes
 * from the owning modules without copying their data" — none of the three
 * needs either gap closed). Both are the coordinator's to close post-merge.
 */
@Module({
  imports: [BookingModule, ClinicalModule, NotificationModule],
  controllers: [FollowupController, FollowupPathwayAdminController, FollowupAlertAdminController],
  providers: [
    FollowupRepository,
    FollowupPathwayRepository,
    { provide: FOLLOWUP_NOTIFICATION_PORT, useExisting: NotificationFacade },
    { provide: CARE_HUB_PORT, useClass: UnavailableCareHubProvider },
    { provide: ADMIN_DIRECTORY_PORT, useClass: UnavailableAdminDirectoryProvider },
    FollowupPathwayService,
    FollowupAlertService,
    FollowupService,
    FollowupCheckinSweepService,
    FollowupFacade,
  ],
  exports: [FollowupFacade],
})
export class FollowupModule {}
