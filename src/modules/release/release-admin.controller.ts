import { Body, Controller, Get, Put } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { ReleaseConfigService } from './release-config.service';
import { UpdateReleasePolicyDto } from './release.dto';

/** One permission gates both read and write — same shape `payment-admin.controller.ts#getConfig/updateConfig` uses for `PAYMENTS_MANAGE_CONFIG`. */
@Controller('admin/release-policy')
@AccountType('admin')
export class ReleaseAdminController {
  constructor(private readonly config: ReleaseConfigService) {}

  @Get()
  @RequirePermission(PERMISSIONS.RELEASE_MANAGE)
  getPolicy() {
    return this.config.getStored();
  }

  @Put()
  @RequirePermission(PERMISSIONS.RELEASE_MANAGE)
  updatePolicy(@CurrentUser() auth: AuthContext, @Body() dto: UpdateReleasePolicyDto) {
    return this.config.update(auth.accountId, dto);
  }
}
