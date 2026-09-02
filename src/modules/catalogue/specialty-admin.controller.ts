import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreateSpecialtyDto, UpdateSpecialtyDto, UpdateSpecialtyTemplatesDto } from './specialty-admin.dto';
import { SpecialtyService } from './specialty.service';

/** Every route is admin-only, gated by its own permission — mirrors `doctor-admin.controller.ts`. */
@Controller('admin/specialties')
@AccountType('admin')
export class SpecialtyAdminController {
  constructor(private readonly service: SpecialtyService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SPECIALTIES_READ)
  list() {
    return this.service.adminList();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SPECIALTIES_READ)
  getDetail(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.adminGetById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.SPECIALTIES_MANAGE)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateSpecialtyDto) {
    return this.service.adminCreate(auth.accountId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SPECIALTIES_MANAGE)
  update(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: UpdateSpecialtyDto) {
    return this.service.adminUpdate(auth.accountId, id, dto);
  }

  /** `prescriptionTemplate`/`adviceTemplate` only — split permission, `SPECIALTIES_MANAGE_CLINICAL_TEMPLATES`. */
  @Patch(':id/templates')
  @RequirePermission(PERMISSIONS.SPECIALTIES_MANAGE_CLINICAL_TEMPLATES)
  updateTemplates(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateSpecialtyTemplatesDto,
  ) {
    return this.service.adminUpdateTemplates(auth.accountId, id, dto);
  }
}
