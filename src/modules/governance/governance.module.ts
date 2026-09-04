import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { ClinicalModule } from '../clinical/clinical.module';
import { DoctorModule } from '../doctor/doctor.module';
import { FollowupModule } from '../followup/followup.module';
import { PatientModule } from '../patient/patient.module';
import { GOVERNANCE_COMPLAINTS_PORT } from './governance-complaints.contract';
import { GovernanceAdminController } from './governance-admin.controller';
import { GovernanceEnrichmentService } from './governance-enrichment.service';
import { GovernanceExportService } from './governance-export.service';
import { GovernanceQualityService } from './governance-quality.service';
import { GovernanceQueueService } from './governance-queue.service';
import { UnavailableComplaintsProvider } from './unavailable-complaints.provider';

/**
 * M-20: Governance and Quality.
 *
 * *** THIS MODULE OWNS NO TABLE AND NO SCHEMA FILE. *** `docs/MODULES.md`'s
 * "Data owned: queue views, quality metrics, escalation records" is a READ
 * layer, not storage — every method on every service in this module composes
 * across `BookingFacade`/`ClinicalFacade`/`FollowupFacade`/`DoctorFacade`/
 * `PatientFacade` and stores nothing of its own, the same discipline
 * `followup.service.ts#getCarePlan`'s header states for the Care Plan.
 *
 * Not `@Global()` — nothing depends on `GovernanceModule` (it is the last
 * module before M-21/Audit in `docs/MODULES.md`'s build order, and nothing
 * downstream is named as reading it), so unlike `IdentityModule` there is no
 * reason for it to be resolvable outside its own import graph. It exports
 * nothing either, for the same reason: no `<domain>.facade.ts` exists here
 * because no consumer needs one yet — every read this module offers is
 * reached through `GovernanceAdminController`, not through DI.
 *
 * ── Five facades in, one is a real cross-module dependency this build
 *    decided NOT to take ──────────────────────────────────────────────────
 *
 * `BookingModule`, `ClinicalModule`, `FollowupModule` and `DoctorModule` are
 * imported for `BookingFacade`/`ClinicalFacade`/`FollowupFacade`/
 * `DoctorFacade`, injected directly — all four are already-merged modules,
 * the same reasoning `followup.module.ts`'s header gives for injecting
 * `BookingFacade`/`ClinicalFacade` directly rather than through a port.
 * `PatientModule` is imported too, for `PatientFacade.getProfileSummary` —
 * not named in this module's build task's facade list, but already-merged,
 * read-only, and exactly what `GovernanceEnrichmentService` needs to put a
 * patient's name on a queue row; adding it cost nothing a port would have.
 *
 * `ClarificationModule`/`ClarificationFacade` is DELIBERATELY NOT imported.
 * `ClarificationContract` exposes exactly one method,
 * `getCaseSummary(caseId)`, single-case-shaped, and this module has no case
 * id to hand it from any of its own queues or dashboard numbers — the case
 * clarification tracker FR-18.5 names is already fully served at
 * `admin/clarification-cases`, whose own header names M-20 by number and
 * says the tracker does not need to move here. See
 * `governance-queue.service.ts`'s header for the complete account.
 *
 * ── The one M-19 (Feedback and Complaints) seam ──────────────────────────
 *
 * `modules/feedback` is being built in a PARALLEL WORKTREE and does not
 * exist here. `GOVERNANCE_COMPLAINTS_PORT` is bound to the null object,
 * `UnavailableComplaintsProvider` (every `ComplaintStatus` at `0`), exactly
 * the pattern `pricing.module.ts` documents for `DISCOUNT_PORT`.
 *
 * *** THE COORDINATOR REBINDS THIS ONE LINE POST-MERGE: ***
 *   `{ provide: GOVERNANCE_COMPLAINTS_PORT, useExisting: <the M-19 facade> }`
 * — importing the feedback module here first, the same one-line handover
 * every other port in this codebase gets.
 */
@Module({
  imports: [BookingModule, ClinicalModule, DoctorModule, FollowupModule, PatientModule],
  controllers: [GovernanceAdminController],
  providers: [
    GovernanceEnrichmentService,
    GovernanceQueueService,
    GovernanceQualityService,
    GovernanceExportService,
    // *** THE ONE LINE THE M-19 HANDOVER CHANGES. ***
    { provide: GOVERNANCE_COMPLAINTS_PORT, useClass: UnavailableComplaintsProvider },
  ],
})
export class GovernanceModule {}
