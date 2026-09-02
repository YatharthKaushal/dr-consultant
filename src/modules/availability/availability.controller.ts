import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { toPublicBlockRule, toPublicOverrideRule, toPublicWeeklyRule } from './availability.mapper';
import { CreateBlockDto, CreateOverrideDto, ListSlotsQueryDto, ReplaceWeeklyScheduleDto, UpdateSchedulingSettingsDto } from './availability.dto';
import { AvailabilityRuleService } from './availability-rule.service';
import { AvailabilitySettingsService } from './availability-settings.service';
import { AvailabilitySlotService } from './availability-slot.service';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';

/**
 * Doctor self-service: weekly schedule, date-wise overrides, blocked dates,
 * scheduling settings, and the doctor's own bookable slots — one controller
 * under `doctors/me`, mirroring `doctor.controller.ts`'s own `@Controller
 * ('doctors')` with explicit sub-paths (a bare `@Controller('doctors/me/
 * availability')` alongside a separate `doctors/me/slots` controller would
 * split what is really one self-service surface into two). Every route
 * derives doctor identity from `@CurrentUser()` — never a path param, per
 * the task brief's "never accept a doctor id as a path param on a
 * self-service route."
 */
@Controller('doctors/me')
@AccountType('doctor')
export class AvailabilityController {
  constructor(
    private readonly ruleService: AvailabilityRuleService,
    private readonly settingsService: AvailabilitySettingsService,
    private readonly slotService: AvailabilitySlotService,
  ) {}

  @Get('availability/weekly')
  async getWeekly(@CurrentUser() auth: AuthContext) {
    const rows = await this.ruleService.listWeekly(auth.accountId);
    return rows.map(toPublicWeeklyRule);
  }

  /** Atomic whole-week replace — see `availability-rule.service.ts#replaceWeekly`. */
  @Put('availability/weekly')
  async replaceWeekly(@CurrentUser() auth: AuthContext, @Body() dto: ReplaceWeeklyScheduleDto) {
    const rows = await this.ruleService.replaceWeekly(auth.accountId, 'doctor', auth.accountId, dto.rules);
    return rows.map(toPublicWeeklyRule);
  }

  @Post('availability/overrides')
  async addOverride(@CurrentUser() auth: AuthContext, @Body() dto: CreateOverrideDto) {
    const row = await this.ruleService.addOverride(auth.accountId, 'doctor', auth.accountId, dto);
    return toPublicOverrideRule(row);
  }

  @Delete('availability/overrides/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOverride(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string): Promise<void> {
    await this.ruleService.removeOverride(auth.accountId, 'doctor', auth.accountId, id);
  }

  @Post('availability/blocks')
  async addBlock(@CurrentUser() auth: AuthContext, @Body() dto: CreateBlockDto) {
    const row = await this.ruleService.addBlock(auth.accountId, 'doctor', auth.accountId, dto);
    return toPublicBlockRule(row);
  }

  @Delete('availability/blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeBlock(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string): Promise<void> {
    await this.ruleService.removeBlock(auth.accountId, 'doctor', auth.accountId, id);
  }

  @Get('availability/settings')
  getSettings(@CurrentUser() auth: AuthContext) {
    return this.settingsService.getOwnSettings(auth.accountId);
  }

  @Patch('availability/settings')
  updateSettings(@CurrentUser() auth: AuthContext, @Body() dto: UpdateSchedulingSettingsDto) {
    return this.settingsService.updateSettings(auth.accountId, 'doctor', auth.accountId, dto);
  }

  @Get('slots')
  getOwnSlots(@CurrentUser() auth: AuthContext, @Query() query: ListSlotsQueryDto) {
    return this.slotService.listBookableSlots(auth.accountId, new Date(query.from), new Date(query.to));
  }
}
