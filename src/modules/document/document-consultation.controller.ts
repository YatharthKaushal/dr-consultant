import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreateReportRequestDto } from './document.dto';
import { PatientFileService } from './patient-file.service';
import { ReportRequestService } from './report-request.service';

/**
 * Doctor self-service under `/consultations/:id/...`: raise/cancel a report
 * request, list requests raised in one consultation, and read the patient's
 * document history (rule 6). Every route derives doctor identity from
 * `@CurrentUser()`, never a path/body param, and verifies the caller is the
 * TREATING doctor for `:id` (or, for the history read, has SOME relationship
 * with the patient) before returning anything — see the service layer for
 * exactly what "treating" and "relationship" mean.
 *
 * `/consultations` is a shared route prefix: M-11 (Booking) does not exist
 * yet, but WILL eventually own its own routes directly under it (e.g.
 * `GET /consultations/:id` for booking details, `POST /consultations` to
 * create one). Nothing here collides with that today — every route below
 * has a literal third segment (`report-requests`, `documents`) — but the
 * M-11 builder should be aware this module already owns part of the prefix.
 */
@Controller('consultations')
@AccountType('doctor')
export class DocumentConsultationController {
  constructor(
    private readonly files: PatientFileService,
    private readonly reportRequests: ReportRequestService,
  ) {}

  @Post(':id/report-requests')
  raise(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: CreateReportRequestDto,
  ) {
    return this.reportRequests.raise(auth.accountId, consultationId, dto);
  }

  @Patch(':id/report-requests/:reqId/cancel')
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Param('reqId', createUuidValidationPipe('reqId')) reportRequestId: string,
  ) {
    return this.reportRequests.cancel(auth.accountId, consultationId, reportRequestId);
  }

  @Get(':id/report-requests')
  listForConsultation(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.reportRequests.listForConsultation(auth.accountId, consultationId);
  }

  /** Rule 6 — see `patient-file.service.ts#listForDoctorHistory` for the full relationship test. */
  @Get(':id/documents')
  listDocumentHistory(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.files.listForDoctorHistory(auth.accountId, consultationId);
  }
}
