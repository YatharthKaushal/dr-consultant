import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ExecuteDataDeletionRequestDto } from './data-rights.dto';
import { DataRightsFacade } from './data-rights.facade';

/**
 * M-21's execution half, the admin side. Gated on the SAME EXISTING
 * `compliance.manage_deletion_requests` permission M-03's own
 * `DataDeletionAdminController` uses (`permission.catalog.ts`) — this
 * module adds no permission of its own.
 *
 * *** TWO ROUTES, TWO EXPLICIT ADMIN ACTIONS. *** `GET :id/preview`
 * computes and returns what WOULD happen — writes nothing, and reports any
 * `openObligations` an admin should read before deciding. `POST :id/execute`
 * is the separate call that actually performs it — the ONLY other caller
 * that can ever reach `DataRightsService#executeForRequest` is the
 * grace-period sweep (`data-rights-execution-sweep.service.ts`), which
 * never sets `override` (see that method's own doc comment for why the
 * override is admin-only by construction, not by convention). Nested under
 * the same `admin/data-deletion-requests` resource
 * `DataDeletionAdminController` already serves (`GET /`, `GET /:id`,
 * `PATCH /:id/review`) — these two routes are the next two actions on that
 * same resource, not a new one.
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

  /**
   * The one place an ADMIN reaches the code that actually deletes or
   * anonymizes an account's data. Refuses unless the request is currently
   * `approved`, and ADDITIVELY (open-obligations round) refuses when the
   * account has an open consultation, unless the body sets
   * `override: true` — an admin who has read the preview's
   * `openObligations` and decided to proceed anyway. No body at all is the
   * common case and behaves exactly as before this round.
   */
  @Post(':id/execute')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  execute(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: ExecuteDataDeletionRequestDto) {
    return this.dataRights.executeForRequest(id, { actorType: 'admin', actorId: auth.accountId }, { override: dto?.override });
  }
}
