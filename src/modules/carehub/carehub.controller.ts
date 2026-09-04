import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CarehubService } from './carehub.service';
import { ListPublishedContentQueryDto } from './carehub.dto';

/**
 * The patient's own Care Hub surface: browse published content (FR-15.1,
 * 15.2, 15.3, 15.6, 15.7), mint a caregiver-guide share link (FR-15.5), and
 * read what a doctor recommended for one of their own consultations
 * (FR-15.4).
 *
 * *** `:consultationId` IS OWNERSHIP-CHECKED, NOT TRUSTED FROM THE PATH. ***
 * Same shape `booking.controller.ts` describes for its own routes: derived
 * from `@CurrentUser()` against the booking, and a consultation that is not
 * this patient's returns the same 404 a stranger gets — see
 * `carehub.service.ts#listRecommendationsForPatient`.
 */
@Controller('care-hub')
@AccountType('patient')
export class CarehubController {
  constructor(private readonly carehub: CarehubService) {}

  @Get('content')
  listPublished(@Query() query: ListPublishedContentQueryDto) {
    return this.carehub.listPublished(query);
  }

  @Get('content/:id')
  getPublishedById(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.getPublishedById(id);
  }

  /** FR-15.5. Mints a fresh token every call — "re-sending it" is just calling this again, no dedup, no stored row. */
  @Post('content/:id/share')
  @HttpCode(HttpStatus.OK)
  shareCaregiverGuide(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.mintShareLink(id, auth.accountId);
  }

  /** FR-15.4 — "the patient sees them tagged 'Recommended by your doctor'." */
  @Get('consultations/:consultationId/recommendations')
  listMyRecommendations(
    @CurrentUser() auth: AuthContext,
    @Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string,
  ) {
    return this.carehub.listRecommendationsForPatient(consultationId, auth.accountId);
  }
}
