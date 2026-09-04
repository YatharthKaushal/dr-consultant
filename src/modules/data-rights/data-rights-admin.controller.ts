import { Controller, Get, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DataRightsFacade } from './data-rights.facade';

/**
 * M-21's execution half, the admin side. Gated on the SAME EXISTING
 * `compliance.manage_deletion_requests` permission M-03's own
 * `DataDeletionAdminController` uses (`permission.catalog.ts`) — this
 * module adds no permission of its own.
 *
 * *** TWO ROUTES, TWO EXPLICIT ADMIN ACTIONS, NOTHING AUTOMATIC. ***
 * `GET :id/preview` computes and returns what WOULD happen — writes
 * nothing. `POST :id/execute` is a SEPARATE call that actually performs it.
 * There is no route, sweep, scheduler or event listener anywhere in this
 * codebase that can reach `DataRightsService#executeForRequest` other than
 * this one explicit, admin-initiated `POST`. Nested under the same
 * `admin/data-deletion-requests` resource `DataDeletionAdminController`
 * already serves (`GET /`, `GET /:id`, `PATCH /:id/review`) — these two
 * routes are the next two actions on that same resource, not a new one.
 */
@Controller('admin/data-deletion-requests')
@AccountType('admin')
export class DataRightsAdminController {
  constructor(private readonly dataRights: DataRightsFacade) {}

  /** Read-only. Safe to call repeatedly, e.g. to refresh row counts before deciding to execute. */
  @Get(':id/preview')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  preview(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.dataRights.previewExecution(id);
  }

  /** The one place in this codebase that actually deletes or anonymizes a patient's data. Refuses unless the request is currently `approved`. */
  @Post(':id/execute')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  execute(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.dataRights.executeForRequest(id, auth.accountId);
  }
}
