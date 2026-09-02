import { BadRequestException } from '@nestjs/common';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { BusyIntervalProvider } from './availability.contract';
import { AvailabilityRuleRepository } from './availability-rule.repository';
import { AvailabilitySettingsService } from './availability-settings.service';
import { AvailabilitySlotService } from './availability-slot.service';

function createDeps(options: { withBatchBusyProvider?: boolean } = {}) {
  const ruleRepo = {
    listForRange: jest.fn().mockResolvedValue([]),
    listForRangeForMany: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AvailabilityRuleRepository>;

  const settingsService = {
    resolveWindowLimits: jest.fn().mockResolvedValue({ minNoticeMinutes: 0, bookingHorizonDays: 30 }),
    resolveWindowLimitsForMany: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<AvailabilitySettingsService>;

  const doctorFacade = {
    getSchedulingParameters: jest.fn(),
    getSchedulingParametersForMany: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorFacade>;

  const appConfig = {
    getNumber: jest.fn().mockResolvedValue(62),
  } as unknown as jest.Mocked<AppConfigService>;

  const busyIntervalProvider = {
    getBusyIntervals: jest.fn().mockResolvedValue([]),
    // The batch form is OPTIONAL on the interface; both branches are covered.
    ...(options.withBatchBusyProvider === false ? {} : { getBusyIntervalsForMany: jest.fn().mockResolvedValue([]) }),
  } as unknown as jest.Mocked<BusyIntervalProvider>;

  const service = new AvailabilitySlotService(ruleRepo, settingsService, doctorFacade, appConfig, busyIntervalProvider);
  return { service, ruleRepo, settingsService, doctorFacade, appConfig, busyIntervalProvider };
}

/** A verified-and-listed doctor's scheduling parameters. */
function bookableParams(doctorId: string) {
  return { doctorId, consultationDurationMinutes: 30, bufferMinutes: 5, isVerifiedAndListed: true };
}

/** Every weekday 09:00-17:00 IST, so any window inside the range yields slots. */
function weeklyRuleRows(doctorId: string) {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    id: `${doctorId}-${dayOfWeek}`,
    doctorId,
    ruleType: 'weekly',
    dayOfWeek,
    specificDate: null,
    startTime: '09:00:00',
    endTime: '17:00:00',
    createdAt: new Date(),
  }));
}

describe('AvailabilitySlotService', () => {
  describe('listBookableSlots', () => {
    it('returns an empty list (not an error) when the doctor does not exist', async () => {
      const { service, doctorFacade } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue(null);

      const result = await service.listBookableSlots('doctor-1', new Date('2026-09-07T00:00:00Z'), new Date('2026-09-08T00:00:00Z'));

      expect(result).toEqual([]);
    });

    it('returns an empty list (not an error) when the doctor exists but is not verified-and-listed', async () => {
      const { service, doctorFacade } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue({
        consultationDurationMinutes: 30,
        bufferMinutes: 5,
        isVerifiedAndListed: false,
      });

      const result = await service.listBookableSlots('doctor-1', new Date('2026-09-07T00:00:00Z'), new Date('2026-09-08T00:00:00Z'));

      expect(result).toEqual([]);
    });

    it('rejects an inverted range (to before from) as INVALID_RANGE, before even reading the doctor', async () => {
      const { service, doctorFacade } = createDeps();

      await expect(
        service.listBookableSlots('doctor-1', new Date('2026-09-08T00:00:00Z'), new Date('2026-09-07T00:00:00Z')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(doctorFacade.getSchedulingParameters).not.toHaveBeenCalled();
    });

    it('rejects a range larger than the configured max (RANGE_TOO_LARGE)', async () => {
      const { service, appConfig, doctorFacade } = createDeps();
      appConfig.getNumber.mockResolvedValue(10);

      await expect(
        service.listBookableSlots('doctor-1', new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(doctorFacade.getSchedulingParameters).not.toHaveBeenCalled();
    });

    it('computes slots for a verified-and-listed doctor using resolved window limits and busy intervals', async () => {
      const { service, doctorFacade, ruleRepo, busyIntervalProvider, settingsService } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue({
        consultationDurationMinutes: 30,
        bufferMinutes: 5,
        isVerifiedAndListed: true,
      });
      ruleRepo.listForRange.mockResolvedValue([
        { id: 'r1', doctorId: 'doctor-1', ruleType: 'weekly', dayOfWeek: 1, specificDate: null, startTime: '09:00:00', endTime: '10:00:00', createdAt: new Date() } as never,
      ]);

      const result = await service.listBookableSlots('doctor-1', new Date('2026-09-07T00:00:00Z'), new Date('2026-09-08T00:00:00Z'));

      expect(settingsService.resolveWindowLimits).toHaveBeenCalledWith('doctor-1');
      expect(busyIntervalProvider.getBusyIntervals).toHaveBeenCalled();
      expect(result.every((s) => s.doctorId === 'doctor-1')).toBe(true);
    });
  });

  describe('isSlotBookable', () => {
    it('returns doctor_not_bookable when the doctor does not exist', async () => {
      const { service, doctorFacade } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue(null);

      const result = await service.isSlotBookable('doctor-1', new Date('2026-09-07T03:30:00Z'));

      expect(result).toEqual({ bookable: false, reason: 'doctor_not_bookable' });
    });

    it('returns doctor_not_bookable when the doctor exists but is not verified-and-listed', async () => {
      const { service, doctorFacade } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue({
        consultationDurationMinutes: 30,
        bufferMinutes: 5,
        isVerifiedAndListed: false,
      });

      const result = await service.isSlotBookable('doctor-1', new Date('2026-09-07T03:30:00Z'));

      expect(result).toEqual({ bookable: false, reason: 'doctor_not_bookable' });
    });

    it('delegates to the engine for a verified-and-listed doctor', async () => {
      const { service, doctorFacade, ruleRepo } = createDeps();
      doctorFacade.getSchedulingParameters.mockResolvedValue({
        consultationDurationMinutes: 30,
        bufferMinutes: 5,
        isVerifiedAndListed: true,
      });
      ruleRepo.listForRange.mockResolvedValue([]);

      const result = await service.isSlotBookable('doctor-1', new Date('2026-09-07T03:30:00Z'));

      // No rules at all -> outside_working_hours, per the engine's own contract.
      expect(result).toEqual({ bookable: false, reason: 'outside_working_hours' });
    });
  });

  /* ------------------------------------------------------------------------ */
  /* ADDITIVE (M-09/search)                                                    */
  /* ------------------------------------------------------------------------ */

  describe('getEarliestBookableSlots', () => {
    const FROM = new Date('2026-09-07T00:00:00Z');
    const TO = new Date('2026-09-21T00:00:00Z');

    it('returns an empty list for no doctor ids, without touching any dependency', async () => {
      const { service, doctorFacade } = createDeps();

      await expect(service.getEarliestBookableSlots([], FROM, TO)).resolves.toEqual([]);
      expect(doctorFacade.getSchedulingParametersForMany).not.toHaveBeenCalled();
    });

    it('rejects an inverted range before reading anything', async () => {
      const { service, doctorFacade } = createDeps();

      await expect(service.getEarliestBookableSlots(['d1'], TO, FROM)).rejects.toBeInstanceOf(BadRequestException);
      expect(doctorFacade.getSchedulingParametersForMany).not.toHaveBeenCalled();
    });

    it('rejects more doctor ids than the batch cap allows', async () => {
      const { service } = createDeps();
      const tooMany = Array.from({ length: 201 }, (_, index) => `d${index}`);

      await expect(service.getEarliestBookableSlots(tooMany, FROM, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns null for every doctor when none is verified-and-listed, without further reads', async () => {
      const { service, doctorFacade, ruleRepo } = createDeps();
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue([
        { ...bookableParams('d1'), isVerifiedAndListed: false },
      ]);

      await expect(service.getEarliestBookableSlots(['d1', 'd2'], FROM, TO)).resolves.toEqual([
        { doctorId: 'd1', earliestStartsAt: null },
        { doctorId: 'd2', earliestStartsAt: null },
      ]);
      expect(ruleRepo.listForRangeForMany).not.toHaveBeenCalled();
    });

    it('makes exactly ONE batched read of each dependency, whatever the doctor count', async () => {
      const { service, doctorFacade, ruleRepo, settingsService, busyIntervalProvider } = createDeps();
      const ids = ['d1', 'd2', 'd3'];
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue(ids.map(bookableParams));
      settingsService.resolveWindowLimitsForMany.mockResolvedValue(
        new Map(ids.map((id) => [id, { minNoticeMinutes: 0, bookingHorizonDays: 30 }])),
      );
      ruleRepo.listForRangeForMany.mockResolvedValue(ids.flatMap(weeklyRuleRows) as never);

      await service.getEarliestBookableSlots(ids, FROM, TO);

      expect(doctorFacade.getSchedulingParametersForMany).toHaveBeenCalledTimes(1);
      expect(ruleRepo.listForRangeForMany).toHaveBeenCalledTimes(1);
      expect(settingsService.resolveWindowLimitsForMany).toHaveBeenCalledTimes(1);
      expect(busyIntervalProvider.getBusyIntervalsForMany).toHaveBeenCalledTimes(1);
      // The per-doctor forms are never used on this path.
      expect(ruleRepo.listForRange).not.toHaveBeenCalled();
      expect(busyIntervalProvider.getBusyIntervals).not.toHaveBeenCalled();
    });

    it('returns each doctor’s EARLIEST slot, grouping rules by doctor', async () => {
      const { service, doctorFacade, ruleRepo, settingsService } = createDeps();
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue([bookableParams('d1'), bookableParams('d2')]);
      settingsService.resolveWindowLimitsForMany.mockResolvedValue(
        new Map([
          ['d1', { minNoticeMinutes: 0, bookingHorizonDays: 30 }],
          ['d2', { minNoticeMinutes: 0, bookingHorizonDays: 30 }],
        ]),
      );
      // Only d1 has any availability configured.
      ruleRepo.listForRangeForMany.mockResolvedValue(weeklyRuleRows('d1') as never);

      const result = await service.getEarliestBookableSlots(['d1', 'd2'], FROM, TO);

      expect(result).toHaveLength(2);
      expect(result[0]?.doctorId).toBe('d1');
      expect(result[0]?.earliestStartsAt).toBeInstanceOf(Date);
      expect(result[1]).toEqual({ doctorId: 'd2', earliestStartsAt: null });
    });

    it('returns one entry per REQUESTED id, in the order given, even with duplicates', async () => {
      const { service, doctorFacade, ruleRepo, settingsService } = createDeps();
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue([bookableParams('d1')]);
      settingsService.resolveWindowLimitsForMany.mockResolvedValue(
        new Map([['d1', { minNoticeMinutes: 0, bookingHorizonDays: 30 }]]),
      );
      ruleRepo.listForRangeForMany.mockResolvedValue(weeklyRuleRows('d1') as never);

      const result = await service.getEarliestBookableSlots(['d1', 'unknown', 'd1'], FROM, TO);

      expect(result.map((entry) => entry.doctorId)).toEqual(['d1', 'unknown', 'd1']);
      // The de-duplicated set is what reaches the reads.
      expect(doctorFacade.getSchedulingParametersForMany).toHaveBeenCalledWith(['d1', 'unknown']);
      expect(result[1]?.earliestStartsAt).toBeNull();
      expect(result[0]?.earliestStartsAt).toEqual(result[2]?.earliestStartsAt);
    });

    it('excludes a slot occupied by a busy interval', async () => {
      const { service, doctorFacade, ruleRepo, settingsService, busyIntervalProvider } = createDeps();
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue([bookableParams('d1')]);
      settingsService.resolveWindowLimitsForMany.mockResolvedValue(
        new Map([['d1', { minNoticeMinutes: 0, bookingHorizonDays: 30 }]]),
      );
      ruleRepo.listForRangeForMany.mockResolvedValue(weeklyRuleRows('d1') as never);

      const withoutBusy = await service.getEarliestBookableSlots(['d1'], FROM, TO);
      const firstSlot = withoutBusy[0]?.earliestStartsAt as Date;

      (busyIntervalProvider.getBusyIntervalsForMany as jest.Mock).mockResolvedValue([
        { doctorId: 'd1', intervals: [{ startsAt: firstSlot, endsAt: new Date(firstSlot.getTime() + 30 * 60_000) }] },
      ]);

      const withBusy = await service.getEarliestBookableSlots(['d1'], FROM, TO);

      expect(withBusy[0]?.earliestStartsAt?.getTime()).toBeGreaterThan(firstSlot.getTime());
    });

    it('FALLS BACK to the per-doctor busy-interval call when the provider implements no batch form', async () => {
      const { service, doctorFacade, ruleRepo, settingsService, busyIntervalProvider } = createDeps({
        withBatchBusyProvider: false,
      });
      doctorFacade.getSchedulingParametersForMany.mockResolvedValue([bookableParams('d1'), bookableParams('d2')]);
      settingsService.resolveWindowLimitsForMany.mockResolvedValue(
        new Map([
          ['d1', { minNoticeMinutes: 0, bookingHorizonDays: 30 }],
          ['d2', { minNoticeMinutes: 0, bookingHorizonDays: 30 }],
        ]),
      );
      ruleRepo.listForRangeForMany.mockResolvedValue(weeklyRuleRows('d1') as never);

      const result = await service.getEarliestBookableSlots(['d1', 'd2'], FROM, TO);

      expect(busyIntervalProvider.getBusyIntervalsForMany).toBeUndefined();
      expect(busyIntervalProvider.getBusyIntervals).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });
  });
});
