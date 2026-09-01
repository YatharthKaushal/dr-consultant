import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { IdentityAccessService } from './identity-access.service';
import { AssignRoleDto, CreateAdminDto, GrantPermissionDto, UpdateAdminDto } from './identity-admin.dto';

/** The RBAC+ABAC surface — every route is admin-only, gated by its own permission. */
@Controller('admin')
@AccountType('admin')
export class IdentityAdminController {
  constructor(private readonly access: IdentityAccessService) {}

  @Get('permissions')
  @RequirePermission(PERMISSIONS.ADMINS_READ)
  listPermissions() {
    return this.access.listPermissions();
  }

  @Get('roles')
  @RequirePermission(PERMISSIONS.ADMINS_READ)
  listRoles() {
    return this.access.listRoles();
  }

  @Get('admins')
  @RequirePermission(PERMISSIONS.ADMINS_READ)
  listAdmins() {
    return this.access.listAdmins();
  }

  @Post('admins')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  createAdmin(@CurrentUser() auth: AuthContext, @Body() dto: CreateAdminDto) {
    return this.access.createAdmin(auth.accountId, dto);
  }

  @Get('admins/:id/access')
  @RequirePermission(PERMISSIONS.ADMINS_READ)
  getAdminAccess(@Param('id') id: string) {
    return this.access.getAdminAccess(id);
  }

  @Patch('admins/:id')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  updateAdmin(@CurrentUser() auth: AuthContext, @Param('id') id: string, @Body() dto: UpdateAdminDto) {
    return this.access.updateAdmin(auth.accountId, id, dto);
  }

  @Post('admins/:id/roles')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRole(@CurrentUser() auth: AuthContext, @Param('id') id: string, @Body() dto: AssignRoleDto): Promise<void> {
    await this.access.assignRole(auth.accountId, id, dto.roleId);
  }

  @Delete('admins/:id/roles/:roleId')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRole(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.access.revokeRole(auth.accountId, id, roleId);
  }

  @Post('admins/:id/permissions')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async grantPermission(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Body() dto: GrantPermissionDto,
  ): Promise<void> {
    await this.access.grantPermission(auth.accountId, id, dto.permissionId, dto.reason);
  }

  @Delete('admins/:id/permissions/:permissionId')
  @RequirePermission(PERMISSIONS.ADMINS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ): Promise<void> {
    await this.access.revokePermission(auth.accountId, id, permissionId);
  }
}
