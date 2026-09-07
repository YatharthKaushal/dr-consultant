import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DeletedAccountsService } from './deleted-accounts.service';
import { ListDeletedAccountsQueryDto } from './deleted-accounts.dto';

/**
 * *** "THE ADMIN WILL HAVE THE OPTION FOREVER TO RESTORE ANY DELETED
 * ACCOUNT." *** This is that surface. Gated on the SAME EXISTING
 * `compliance.manage_deletion_requests` permission every other route in
 * this feature uses — restoring an account is the same compliance-review
 * class of act as approving its deletion, not a new permission of its own.
 */
@Controller('admin/deleted-accounts')
@AccountType('admin')
export class DeletedAccountsAdminController {
  constructor(private readonly service: DeletedAccountsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  list(@Query() query: ListDeletedAccountsQueryDto) {
    return this.service.listForAdmin({
      accountType: query.accountType,
      restored: query.restored,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  getOne(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.getForAdmin(id);
  }

  /** *** THE UN-DO. NOTHING IN THIS CODEBASE EVER HARD-DELETES AN ACCOUNT, SO THIS STAYS POSSIBLE FOREVER. *** See `DeletedAccountsService#restore`'s own header. */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS)
  restore(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.restore(id, auth.accountId);
  }
}
