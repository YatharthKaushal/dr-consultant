import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { SubmitFeedbackDto } from './feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * The patient's own post-consult feedback (FR-17.1), under
 * `/consultations/:id/...` — the same shared prefix `followup.controller.ts`
 * and `clinical.controller.ts` already add to; `feedback` is a literal third
 * segment, so there is no collision with either.
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or
 * body param, and delegates the ownership check to `FeedbackService`, which
 * returns the SAME 404 a stranger gets for a consultation that is not
 * theirs — `followup.controller.ts`'s own header states this convention for
 * the identical reason.
 */
@Controller('consultations')
@AccountType('patient')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** FR-17.1. A second submission for the same consultation is refused with 409 — see `FeedbackService#submitFeedback`. */
  @Post(':id/feedback')
  submit(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: SubmitFeedbackDto,
  ) {
    return this.feedback.submitFeedback(consultationId, auth.accountId, dto);
  }

  /** `null` — not a 404 — when this patient has not submitted feedback for this consultation yet: a normal state, not an error. */
  @Get(':id/feedback')
  getOwn(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.feedback.getOwnFeedback(consultationId, auth.accountId);
  }
}
