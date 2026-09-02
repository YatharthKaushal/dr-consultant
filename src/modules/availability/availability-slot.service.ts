import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { DoctorFacade } from '../doctor/doctor.facade';
import type { BookableSlot, BusyIntervalProvider, SlotBookability } from './availability.contract';
import { AVAILABILITY_CONFIG_FALLBACKS, AVAILABILITY_CONFIG_KEYS, AVAILABILITY_ERROR_CODES, BUSY_INTERVAL_PROVIDER } from './availability.constants';
import { AvailabilityRuleRepository } from './availability-rule.repository';
import { AvailabilitySettingsService } from './availability-settings.service';
import { computeBookableSlots, evaluateSlotBookability, type AvailabilityRuleData } from './availability-slot.engine';
import { addDaysToIsoDate, utcToIstWallClock } from './availability-time.util';
import type { DoctorAvailabilityRow } from '../../schema/doctor-availability.schema';

function toEngineRule(row: DoctorAvailabilityRow): AvailabilityRuleData {
  return {
    ruleType: row.ruleType,
    dayOfWeek: row.dayOfWeek,
    specificDate: row.specificDate,
    startTime: row.startTime,
    endTime: row.endTime,
  };
}

/**
 * Composes the slot engine's inputs from live data and calls it —
 * everything DB/HTTP-shaped lives here, everything decision-shaped lives in
 * `availability-slot.engine.ts`. Also where an unverified/unlisted doctor is
 * turned into an empty result (never an error — a patient browsing should
 * just see nothing bookable, same reasoning `doctor.service.ts#getListed
 * ProfileForCaller` uses for 404-not-403), and where an oversized `[from,
 * to)` range is rejected before it ever reaches the engine.
 */
@Injectable()
export class AvailabilitySlotService {
  constructor(
    private readonly ruleRepo: AvailabilityRuleRepository,
    private readonly settingsService: AvailabilitySettingsService,
    private readonly doctorFacade: DoctorFacade,
    private readonly appConfig: AppConfigService,
    @Inject(BUSY_INTERVAL_PROVIDER) private readonly busyIntervalProvider: BusyIntervalProvider,
  ) {}

  async listBookableSlots(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BookableSlot[]> {
    await this.assertValidRange(fromUtc, toUtc);

    const params = await this.doctorFacade.getSchedulingParameters(doctorId);
    if (!params || !params.isVerifiedAndListed) {
      return [];
    }

    const windowLimits = await this.settingsService.resolveWindowLimits(doctorId);

    const fromIsoDate = addDaysToIsoDate(utcToIstWallClock(fromUtc).date, -1);
    const toIsoDate = addDaysToIsoDate(utcToIstWallClock(toUtc).date, 1);
    const [rules, busyIntervals] = await Promise.all([
      this.ruleRepo.listForRange(doctorId, fromIsoDate, toIsoDate),
      this.busyIntervalProvider.getBusyIntervals(doctorId, fromUtc, toUtc),
    ]);

    return computeBookableSlots({
      doctorId,
      fromUtc,
      toUtc,
      now: new Date(),
      rules: rules.map(toEngineRule),
      schedulingParams: { consultationDurationMinutes: params.consultationDurationMinutes, bufferMinutes: params.bufferMinutes },
      windowLimits,
      busyIntervals,
    });
  }

  async isSlotBookable(doctorId: string, startsAtUtc: Date): Promise<SlotBookability> {
    const params = await this.doctorFacade.getSchedulingParameters(doctorId);
    if (!params || !params.isVerifiedAndListed) {
      return { bookable: false, reason: 'doctor_not_bookable' };
    }

    const windowLimits = await this.settingsService.resolveWindowLimits(doctorId);
    const isoDate = utcToIstWallClock(startsAtUtc).date;
    const slotEndUtc = new Date(startsAtUtc.getTime() + params.consultationDurationMinutes * 60_000);

    const [rules, busyIntervals] = await Promise.all([
      this.ruleRepo.listForRange(doctorId, isoDate, isoDate),
      this.busyIntervalProvider.getBusyIntervals(doctorId, startsAtUtc, slotEndUtc),
    ]);

    return evaluateSlotBookability({
      startsAtUtc,
      now: new Date(),
      rules: rules.map(toEngineRule),
      schedulingParams: { consultationDurationMinutes: params.consultationDurationMinutes, bufferMinutes: params.bufferMinutes },
      windowLimits,
      busyIntervals,
    });
  }

  private async assertValidRange(fromUtc: Date, toUtc: Date): Promise<void> {
    if (toUtc.getTime() <= fromUtc.getTime()) {
      throw new BadRequestException({ code: AVAILABILITY_ERROR_CODES.INVALID_RANGE, message: '`to` must be after `from`.' });
    }

    const maxDays = await this.appConfig.getNumber(AVAILABILITY_CONFIG_KEYS.MAX_SLOT_QUERY_DAYS, AVAILABILITY_CONFIG_FALLBACKS.MAX_SLOT_QUERY_DAYS);
    const rangeDays = (toUtc.getTime() - fromUtc.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > maxDays) {
      throw new BadRequestException({
        code: AVAILABILITY_ERROR_CODES.RANGE_TOO_LARGE,
        message: `The requested range spans more than the maximum of ${maxDays} days.`,
      });
    }
  }
}
