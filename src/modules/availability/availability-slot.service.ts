import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { DoctorFacade } from '../doctor/doctor.facade';
import type { BookableSlot, BusyInterval, BusyIntervalProvider, EarliestBookableSlot, SlotBookability } from './availability.contract';
import {
  AVAILABILITY_CONFIG_FALLBACKS,
  AVAILABILITY_CONFIG_KEYS,
  AVAILABILITY_ERROR_CODES,
  BUSY_INTERVAL_PROVIDER,
  MAX_BATCH_DOCTOR_IDS,
} from './availability.constants';
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

  /**
   * ADDITIVE (M-09/search) — see `AvailabilityContract.getEarliestBookable
   * Slots`. FOUR queries total, regardless of how many doctors are asked
   * about: scheduling parameters, availability rules, scheduling settings,
   * busy intervals. Each is the batch form of what the single-doctor path
   * does one at a time; the slot expansion itself is the same pure
   * `computeBookableSlots` call, run per doctor over already-fetched data.
   *
   * Duplicate ids are collapsed before the reads and re-expanded on the way
   * out, so a caller that repeats an id pays nothing for it and still gets
   * one entry per element it asked about.
   */
  async getEarliestBookableSlots(doctorIds: readonly string[], fromUtc: Date, toUtc: Date): Promise<EarliestBookableSlot[]> {
    await this.assertValidRange(fromUtc, toUtc);
    if (doctorIds.length === 0) return [];

    if (doctorIds.length > MAX_BATCH_DOCTOR_IDS) {
      throw new BadRequestException({
        code: AVAILABILITY_ERROR_CODES.TOO_MANY_DOCTOR_IDS,
        message: `At most ${MAX_BATCH_DOCTOR_IDS} doctor ids may be looked up at once.`,
      });
    }

    const uniqueIds = [...new Set(doctorIds)];
    const params = await this.doctorFacade.getSchedulingParametersForMany(uniqueIds);
    const paramsByDoctor = new Map(params.map((entry) => [entry.doctorId, entry]));

    // Only doctors who could actually be booked are worth four more reads.
    const bookableIds = uniqueIds.filter((id) => paramsByDoctor.get(id)?.isVerifiedAndListed === true);
    if (bookableIds.length === 0) {
      return doctorIds.map((doctorId) => ({ doctorId, earliestStartsAt: null }));
    }

    const fromIsoDate = addDaysToIsoDate(utcToIstWallClock(fromUtc).date, -1);
    const toIsoDate = addDaysToIsoDate(utcToIstWallClock(toUtc).date, 1);

    const [rules, windowLimitsByDoctor, busyByDoctor] = await Promise.all([
      this.ruleRepo.listForRangeForMany(bookableIds, fromIsoDate, toIsoDate),
      this.settingsService.resolveWindowLimitsForMany(bookableIds),
      this.loadBusyIntervals(bookableIds, fromUtc, toUtc),
    ]);

    const rulesByDoctor = new Map<string, DoctorAvailabilityRow[]>();
    for (const rule of rules) {
      const existing = rulesByDoctor.get(rule.doctorId);
      if (existing) existing.push(rule);
      else rulesByDoctor.set(rule.doctorId, [rule]);
    }

    // One `now` for the whole batch, so two doctors are never compared
    // against min-notice cut-offs a few milliseconds apart.
    const now = new Date();
    const earliestByDoctor = new Map<string, Date | null>();
    for (const doctorId of bookableIds) {
      const doctorParams = paramsByDoctor.get(doctorId);
      const windowLimits = windowLimitsByDoctor.get(doctorId);
      if (!doctorParams || !windowLimits) {
        earliestByDoctor.set(doctorId, null);
        continue;
      }

      const slots = computeBookableSlots({
        doctorId,
        fromUtc,
        toUtc,
        now,
        rules: (rulesByDoctor.get(doctorId) ?? []).map(toEngineRule),
        schedulingParams: {
          consultationDurationMinutes: doctorParams.consultationDurationMinutes,
          bufferMinutes: doctorParams.bufferMinutes,
        },
        windowLimits,
        busyIntervals: busyByDoctor.get(doctorId) ?? [],
      });
      // `computeBookableSlots` already returns ascending by start.
      earliestByDoctor.set(doctorId, slots[0]?.startsAt ?? null);
    }

    return doctorIds.map((doctorId) => ({ doctorId, earliestStartsAt: earliestByDoctor.get(doctorId) ?? null }));
  }

  /** Uses the provider's batch form when it implements one, and otherwise falls back to the per-doctor call — see `BusyIntervalProvider.getBusyIntervalsForMany`. */
  private async loadBusyIntervals(doctorIds: string[], fromUtc: Date, toUtc: Date): Promise<Map<string, BusyInterval[]>> {
    if (this.busyIntervalProvider.getBusyIntervalsForMany) {
      const batched = await this.busyIntervalProvider.getBusyIntervalsForMany(doctorIds, fromUtc, toUtc);
      return new Map(batched.map((entry) => [entry.doctorId, entry.intervals]));
    }

    const perDoctor = await Promise.all(
      doctorIds.map(async (doctorId) => [doctorId, await this.busyIntervalProvider.getBusyIntervals(doctorId, fromUtc, toUtc)] as const),
    );
    return new Map(perDoctor);
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
