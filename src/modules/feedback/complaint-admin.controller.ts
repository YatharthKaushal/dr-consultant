import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import {
  AddComplaintAdminMessageDto,
  AssignComplaintDto,
  ListComplaintsAdminQueryDto,
  RejectComplaintDto,
  ResolveComplaintDto,
} from './feedback.dto';
import { ComplaintService } from './complaint.service';

/**
 * FR-18.8's complaint half: "complaint workflow and resolution tracking".
 *
 * Reads (`list`/`getOne`) are gated on `feedback.read`; every write
 * (`assign`/`addMessage`/`resolve`/`reject`) is gated on
 * `feedback.manage_complaints` — both permissions `permission.catalog.ts`
 * already seeded (bundled to `super_admin`; `manage_complaints` additionally
 * to `operations`) with no controller using either until now — the same
 * "a permission nothing checks is a promise nobody keeps" finding
 * `clarification-admin.controller.ts`'s own header states.
 */
@Controller('admin/complaints')
@AccountType('admin')
export class ComplaintAdminController {
  constructor(private readonly complaints: ComplaintService) {}

  /** The tracker's list — FR-18.8: filterable by status, by category, by assignee. */
  @Get()
  @RequirePermission(PERMISSIONS.FEEDBACK_READ)
  list(@Query() query: ListComplaintsAdminQueryDto) {
    return this.complaints.listForAdmin(query);
  }

  /** The tracker's detail read — the admin's full view, including any internal-only message. */
  @Get(':id')
  @RequirePermission(PERMISSIONS.FEEDBACK_READ)
  getOne(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.complaints.getForAdmin(id);
  }

  /** `open` -> `in_progress`. `@HttpCode(OK)`: transitions a complaint that already exists rather than creating one. */
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS)
  assign(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AssignComplaintDto,
  ) {
    return this.complaints.assignComplaint(id, dto.assignedToAdminId, auth.accountId);
  }

  /** An admin's reply on the thread — may be internal-only, never shown on the patient's own view. Legal in any status. */
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS)
  addMessage(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AddComplaintAdminMessageDto,
  ) {
    return this.complaints.addAdminMessage(id, auth.accountId, dto);
  }

  /** `in_progress` -> `resolved`. `resolvedAt` is set here and nowhere else. */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS)
  resolve(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: ResolveComplaintDto,
  ) {
    return this.complaints.resolveComplaint(id, auth.accountId, dto);
  }

  /** `in_progress` -> `rejected`. `resolvedAt` is NEVER set here — `rejected` is not resolved. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS)
  reject(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: RejectComplaintDto,
  ) {
    return this.complaints.rejectComplaint(id, auth.accountId, dto);
  }
}
