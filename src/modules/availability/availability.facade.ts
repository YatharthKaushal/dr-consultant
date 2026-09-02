import { Injectable } from '@nestjs/common';
import type { AvailabilityContract, BookableSlot, SlotBookability, WeeklyAvailabilityRule } from './availability.contract';
import { toPublicWeeklyRule } from './availability.mapper';
import { AvailabilityRuleService } from './availability-rule.service';
import { AvailabilitySlotService } from './availability-slot.service';

@Injectable()
export class AvailabilityFacade implements AvailabilityContract {
  constructor(
    private readonly slotService: AvailabilitySlotService,
    private readonly ruleService: AvailabilityRuleService,
  ) {}

  async listBookableSlots(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BookableSlot[]> {
    return this.slotService.listBookableSlots(doctorId, fromUtc, toUtc);
  }

  async isSlotBookable(doctorId: string, startsAtUtc: Date): Promise<SlotBookability> {
    return this.slotService.isSlotBookable(doctorId, startsAtUtc);
  }

  async getWeeklyRules(doctorId: string): Promise<WeeklyAvailabilityRule[]> {
    const rows = await this.ruleService.listWeekly(doctorId);
    return rows.map(toPublicWeeklyRule);
  }
}
