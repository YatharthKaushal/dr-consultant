import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { CreateConcernDto, UpdateConcernDto, UpdateConcernMappingDto } from './concern-admin.dto';
import { ListConcernsQueryDto } from './concern.dto';
import { ConcernService } from './concern.service';

/** Every route is admin-only, gated by its own permission — mirrors `doctor-admin.controller.ts`. */
@Controller('admin/concerns')
@AccountType('admin')
export class ConcernAdminController {
  constructor(private readonly service: ConcernService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SPECIALTIES_READ)
  list(@Query() query: ListConcernsQueryDto) {
    return this.service.adminList(query.specialtyId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SPECIALTIES_READ)
  getDetail(@Param('id') id: string) {
    return this.service.adminGetById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.SPECIALTIES_MANAGE)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateConcernDto) {
    return this.service.adminCreate(auth.accountId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SPECIALTIES_MANAGE)
  update(@CurrentUser() auth: AuthContext, @Param('id') id: string, @Body() dto: UpdateConcernDto) {
    return this.service.adminUpdate(auth.accountId, id, dto);
  }

  /** `matchPhrases`/`matchWeight` only — split permission, `SEARCH_MANAGE_MAPPING`. */
  @Patch(':id/mapping')
  @RequirePermission(PERMISSIONS.SEARCH_MANAGE_MAPPING)
  updateMapping(@CurrentUser() auth: AuthContext, @Param('id') id: string, @Body() dto: UpdateConcernMappingDto) {
    return this.service.adminUpdateMapping(auth.accountId, id, dto);
  }
}
