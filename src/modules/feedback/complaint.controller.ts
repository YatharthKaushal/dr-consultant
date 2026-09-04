import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { AddComplaintMessageDto, ListOwnComplaintsQueryDto, RaiseComplaintDto } from './feedback.dto';
import { ComplaintService } from './complaint.service';

/**
 * The patient's own complaints (FR-17.2): raising one, tracking it, and
 * adding a message to its thread. `consultationId` is optional on
 * `POST /complaints` — a complaint need not be about one consultation
 * (`complaints.schema.ts`'s own comment).
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or
 * body param, and delegates ownership to `ComplaintService`, which returns
 * the SAME 404 a stranger gets for a complaint that is not theirs —
 * `clarification.controller.ts`'s own header states this convention for the
 * identical reason.
 */
@Controller('complaints')
@AccountType('patient')
export class ComplaintController {
  constructor(private readonly complaints: ComplaintService) {}

  /** FR-17.2: raises a complaint, `open` from insert. */
  @Post()
  raise(@CurrentUser() auth: AuthContext, @Body() dto: RaiseComplaintDto) {
    return this.complaints.raiseComplaint(auth.accountId, dto);
  }

  /** Every complaint this patient has raised. */
  @Get()
  list(@CurrentUser() auth: AuthContext, @Query() query: ListOwnComplaintsQueryDto) {
    return this.complaints.listOwnComplaints(auth.accountId, query);
  }

  /** One of this patient's own complaints. Never includes an admin's internal-only message — see `feedback.mapper.ts#toComplaintPatientView`. */
  @Get(':id')
  getOne(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.complaints.getOwnComplaint(id, auth.accountId);
  }

  /** Adds the patient's own message to the thread — legal in any status, see `complaint.service.ts`'s header. `@HttpCode(OK)`: appends to a complaint that already exists rather than creating one. */
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  addMessage(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AddComplaintMessageDto,
  ) {
    return this.complaints.addPatientMessage(id, auth.accountId, dto);
  }
}
