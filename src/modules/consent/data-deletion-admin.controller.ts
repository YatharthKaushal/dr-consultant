import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DEFAULT_DATA_DELETION_PAGE_SIZE } from './data-deletion.constants';
import { ListDataDeletionRequestsQueryDto, ReviewDataDeletionRequestDto } from './data-deletion.dto';
import { DataDeletionService } from './data-deletion.service';

/**
 * FR-2.5, the admin side: gated on the EXISTING `compliance.manage_deletion_requests`
 * permission (`permission.catalog.ts`) — this module adds no permission of its
 * own.
 *
 * *** EXECUTION IS NOT HERE, AND NEVER WILL BE THROUGH THIS CONTROLLER. ***
 * `PATCH :id/review` moves a request through `requested -> in_review ->
 * approved`/`rejected` only. Actually deleting (or lawfully retaining) the
 * patient's data — the `executed`/`failed` states, `executed_at`,
 * `execution_outcome` — is M-21's job, which does not exist yet. See
 * `DataDeletionService#reviewRequest`'s header comment.
 */
@Controller('admin/data-deletion-requests')
@AccountType('admin')
export class DataDeletionAdminController {
  constructor(private readonly service: DataDeletionService) {}

  /** The queue, optionally narrowed to one status — `?status=requested` is the pending queue itself. */
  @Get()
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  list(@Query() query: ListDataDeletionRequestsQueryDto) {
    return this.service.listForAdmin({
      status: query.status,
      limit: query.limit ?? DEFAULT_DATA_DELETION_PAGE_SIZE,
      offset: query.offset ?? 0,
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  getOne(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.getForAdmin(id);
  }

  /** Sets `status`, `reviewedByAdminId` (from `@CurrentUser()`), `reviewedAt` and an optional `reviewNote`. Never `executedAt`/`executionOutcome` — see the class header. */
  @Patch(':id/review')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  review(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: ReviewDataDeletionRequestDto,
  ) {
    return this.service.reviewRequest(auth.accountId, id, { status: dto.status, reviewNote: dto.reviewNote ?? null });
  }
}
