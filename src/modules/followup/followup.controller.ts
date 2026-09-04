import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { SubmitCheckinDto } from './followup.dto';
import { FollowupService } from './followup.service';

/**
 * The patient's own follow-up: daily check-ins, the Care Plan (FR-14.1) and
 * the follow-up-booking recommendation (FR-13.6), under `/consultations/:id/
 * ...` — the same shared prefix `clinical.controller.ts` and `document-
 * consultation.controller.ts` already add to; every route below has a
 * literal `followup`/`checkins`/`care-plan` third segment, so there is no
 * collision with either.
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or
 * body param, and delegates the ownership check to `FollowupService`'s
 * `...ForPatient` methods, which return the SAME 404 a stranger gets for a
 * consultation that is not theirs — the convention `clinical.controller.ts`'s
 * header states for the identical reason.
 */
@Controller('consultations')
@AccountType('patient')
export class FollowupController {
  constructor(private readonly followup: FollowupService) {}

  /** FR-13.1-13.5. `@HttpCode(CREATED)` is the default for `@Post`, which is right here: a genuinely new `checkin_responses` row. A same-day resubmission is refused with 409 — see `FollowupService#submitCheckin`. */
  @Post(':id/checkins')
  submitCheckin(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: SubmitCheckinDto,
  ) {
    return this.followup.submitCheckin({
      consultationId,
      checkinDate: dto.checkinDate,
      answers: dto.answers,
      actorPatientId: auth.accountId,
    });
  }

  @Get(':id/checkins')
  listCheckins(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.followup.listCheckinsForPatient(consultationId, auth.accountId);
  }

  /** `null` — not a 404 — when no pathway has been assigned yet: a consult that has not completed is a normal state, not an error. */
  @Get(':id/followup-assignment')
  getAssignment(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.followup.getAssignmentForPatient(consultationId, auth.accountId);
  }

  /** FR-13.6. `?urgent=true` asks for the "review is urgent" branch — see `FollowUpBookingRecommendation`'s own doc comment for exactly what this resolves and what it leaves to the caller. */
  @Get(':id/followup-booking-recommendation')
  recommendFollowUpBooking(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Query('urgent') urgent?: string,
  ) {
    return this.followup.recommendFollowUpBookingForPatient(consultationId, auth.accountId, urgent === 'true');
  }

  /** FR-14.1/FR-14.2 — the whole Care Plan, composed live. See `CarePlanView`'s header: stores nothing of its own. */
  @Get(':id/care-plan')
  getCarePlan(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.followup.getCarePlanForPatient(consultationId, auth.accountId);
  }
}
