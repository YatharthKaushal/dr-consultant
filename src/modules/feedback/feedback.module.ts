import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { ComplaintAdminController } from './complaint-admin.controller';
import { ComplaintController } from './complaint.controller';
import { ComplaintRepository } from './complaint.repository';
import { ComplaintService } from './complaint.service';
import { FeedbackAdminController } from './feedback-admin.controller';
import { FeedbackController } from './feedback.controller';
import { FeedbackFacade } from './feedback.facade';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';

/**
 * M-19: Feedback and Complaints.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; M-20 (Governance and Quality, unbuilt)
 * will consume `FeedbackFacade` via normal constructor injection after
 * importing `FeedbackModule`, the same handover every prior module in this
 * codebase documents for its own facade.
 *
 * ---------------------------------------------------------------------------
 * *** THIS MODULE OWNS TWO TABLES AND READS NOBODY ELSE'S. ***
 *
 * `feedback` (added by this worktree — see that schema file's header) and
 * `complaints` (pre-existing since the first migration, unused until now —
 * see `complaints.schema.ts`'s own header). Every other fact this module
 * needs arrives through a facade:
 *
 *   `consultations`   `BookingFacade`, injected directly — M-11 is already
 *                     merged, the same reasoning `followup.module.ts`'s and
 *                     `carehub.module.ts`'s own headers give for the
 *                     identical choice. `docs/MODULES.md` lists M-19
 *                     depending on M-02/M-11 only, so no other feature
 *                     module is imported here.
 *
 * `DATABASE` and `AuditService` are `@Global()`, so neither needs an
 * `imports` entry. `shared/auth`'s decorators (`@AccountType`,
 * `@RequirePermission`, `@CurrentUser`) are available the same way, per
 * `doctor.module.ts`'s own header note on `@Global()` providers.
 * ---------------------------------------------------------------------------
 */
@Module({
  imports: [BookingModule],
  controllers: [FeedbackController, FeedbackAdminController, ComplaintController, ComplaintAdminController],
  providers: [FeedbackRepository, FeedbackService, ComplaintRepository, ComplaintService, FeedbackFacade],
  exports: [FeedbackFacade],
})
export class FeedbackModule {}
