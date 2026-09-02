import { BadRequestException } from '@nestjs/common';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { BusyIntervalProvider } from './availability.contract';
import { AvailabilityRuleRepository } from './availability-rule.repository';
import { AvailabilitySettingsService } from './availability-settings.service';
import { AvailabilitySlotService } from './availability-slot.service';

function createDeps() {
  const ruleRepo = {
    listForRange: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AvailabilityRuleRepository>;

  const settingsService = {
    resolveWindowLimits: jest.fn().mockResolvedValue({ minNoticeMinutes: 0, bookingHorizonDays: 30 }),
  } as unknown as jest.Mocked<AvailabilitySettingsService>;

  const doctorFacade = {
    getSchedulingParameters: jest.fn(),
  } as unknown as jest.Mocked<DoctorFacade>;

  const appConfig = {
    getNumber: jest.fn().mockResolvedValue(62),
  } as unknown as jest.Mocked<AppConfigService>;

  const busyIntervalProvider = {
    getBusyIntervals: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<BusyIntervalProvider>;

  const service = new AvailabilitySlotService(ruleRepo, settingsService, doctorFacade, appConfig, busyIntervalProvider);
  return { service, ruleRepo, settingsService, doctorFacade, appConfig, busyIntervalProvider };
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
});
