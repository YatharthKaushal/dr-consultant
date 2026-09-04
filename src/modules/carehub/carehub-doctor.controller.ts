import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { AddRecommendationsDto } from './carehub.dto';
import { CarehubService } from './carehub.service';

/**
 * FR-15.4: "the doctor can select specific tools after a consult."
 *
 * *** `/consultations` IS A SHARED PREFIX. *** `clinical.controller.ts` and
 * `document-consultation.controller.ts` already own routes there and both
 * warn the next builder that the prefix is shared; every route below has a
 * literal `care-hub/recommendations` third segment, so there is no
 * ambiguity with either.
 *
 * Every route derives the doctor from `@CurrentUser()`, never a path param,
 * and a consultation that is not this doctor's returns the same 404 a
 * stranger gets — `BookingFacade.getBooking` checked against the caller, the
 * same seam `report-request.service.ts#raise` uses.
 */
@Controller('consultations')
@AccountType('doctor')
export class CarehubDoctorController {
  constructor(private readonly carehub: CarehubService) {}

  @Get(':id/care-hub/recommendations')
  list(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.carehub.listRecommendationsForDoctor(consultationId, auth.accountId);
  }

  /** Adds a batch of items. Already-recommended items are silently no-ops (`content_recommendations`' unique index). */
  @Post(':id/care-hub/recommendations')
  @HttpCode(HttpStatus.OK)
  add(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: AddRecommendationsDto,
  ) {
    return this.carehub.addRecommendations(consultationId, auth.accountId, dto);
  }

  @Delete(':id/care-hub/recommendations/:contentItemId')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Param('contentItemId', createUuidValidationPipe('contentItemId')) contentItemId: string,
  ) {
    return this.carehub.removeRecommendation(consultationId, auth.accountId, contentItemId);
  }
}
