import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { ListSlotsQueryDto, UpdateSchedulingSettingsDto } from './availability.dto';
import { toPublicAvailabilityRule } from './availability.mapper';
import { AvailabilityRuleService } from './availability-rule.service';
import { AvailabilitySettingsService } from './availability-settings.service';
import { AvailabilitySlotService } from './availability-slot.service';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';

/** Every route is admin-only, gated by `availability.read`/`availability.manage` — mirrors `doctor-admin.controller.ts`. Reads a target doctor's rules/settings/slots; nothing here lets an admin write a doctor's weekly schedule or individual overrides/blocks — that stays doctor self-service (FR-10.1's "the doctor sets"), only the platform-default OVERRIDE (`doctor_scheduling_settings`) is admin-editable. */
@Controller('admin/doctors/:id')
@AccountType('admin')
export class AvailabilityAdminController {
  constructor(
    private readonly ruleService: AvailabilityRuleService,
    private readonly settingsService: AvailabilitySettingsService,
    private readonly slotService: AvailabilitySlotService,
  ) {}

  @Get('availability')
  @RequirePermission(PERMISSIONS.AVAILABILITY_READ)
  async getRules(@Param('id', createUuidValidationPipe('id')) id: string) {
    const rows = await this.ruleService.listAll(id);
    return rows.map(toPublicAvailabilityRule);
  }

  @Get('slots')
  @RequirePermission(PERMISSIONS.AVAILABILITY_READ)
  getSlots(@Param('id', createUuidValidationPipe('id')) id: string, @Query() query: ListSlotsQueryDto) {
    return this.slotService.listBookableSlots(id, new Date(query.from), new Date(query.to));
  }

  @Get('availability/settings')
  @RequirePermission(PERMISSIONS.AVAILABILITY_READ)
  getSettings(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.settingsService.getOwnSettings(id);
  }

  @Patch('availability/settings')
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  updateSettings(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: UpdateSchedulingSettingsDto) {
    return this.settingsService.updateSettings(id, 'admin', auth.accountId, dto);
  }
}
