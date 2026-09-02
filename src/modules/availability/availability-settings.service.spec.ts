import { BadRequestException } from '@nestjs/common';
import type { DoctorSchedulingSettingsRow } from '../../schema/doctor-scheduling-settings.schema';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import { AvailabilitySettingsRepository } from './availability-settings.repository';
import { AvailabilitySettingsService } from './availability-settings.service';

function settingsRow(overrides: Partial<DoctorSchedulingSettingsRow> = {}): DoctorSchedulingSettingsRow {
  return {
    doctorId: 'doctor-1',
    minNoticeMinutes: null,
    bookingHorizonDays: null,
    slotIntervalMinutes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDeps() {
  const repo = {
    findByDoctor: jest.fn(),
    upsert: jest.fn(),
  } as unknown as jest.Mocked<AvailabilitySettingsRepository>;

  const appConfig = {
    getNumber: jest.fn(),
    getJson: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as jest.Mocked<AppConfigService>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new AvailabilitySettingsService(repo, appConfig, audit);
  return { service, repo, appConfig, audit };
}

describe('AvailabilitySettingsService', () => {
  describe('resolveWindowLimits — three-level resolution', () => {
    it('uses the per-doctor override when both columns are non-null', async () => {
      const { service, repo, appConfig } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: 45, bookingHorizonDays: 10 }));
      appConfig.getNumber.mockResolvedValue(999); // should not be used

      const result = await service.resolveWindowLimits('doctor-1');

      expect(result).toEqual({ minNoticeMinutes: 45, bookingHorizonDays: 10 });
    });

    it('falls through to app_config when the doctor has a row but the columns are null', async () => {
      const { service, repo, appConfig } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: null, bookingHorizonDays: null }));
      appConfig.getNumber.mockImplementation(async (key: string, fallback: number) => {
        if (key === 'scheduling.min_notice_minutes') return 200;
        if (key === 'scheduling.booking_horizon_days') return 45;
        return fallback;
      });

      const result = await service.resolveWindowLimits('doctor-1');

      expect(result).toEqual({ minNoticeMinutes: 200, bookingHorizonDays: 45 });
    });

    it('falls through to app_config (and then the compiled fallback) when the doctor has NO row at all', async () => {
      const { service, repo, appConfig } = createDeps();
      repo.findByDoctor.mockResolvedValue(null);
      appConfig.getNumber.mockImplementation(async (_key: string, fallback: number) => fallback); // simulate a missing app_config row too

      const result = await service.resolveWindowLimits('doctor-1');

      expect(result).toEqual({ minNoticeMinutes: 120, bookingHorizonDays: 30 });
    });

    it('resolves each field independently — one overridden, the other inherited', async () => {
      const { service, repo, appConfig } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: 15, bookingHorizonDays: null }));
      appConfig.getNumber.mockImplementation(async (key: string, fallback: number) => (key === 'scheduling.booking_horizon_days' ? 60 : fallback));

      const result = await service.resolveWindowLimits('doctor-1');

      expect(result).toEqual({ minNoticeMinutes: 15, bookingHorizonDays: 60 });
    });
  });

  describe('getOwnSettings', () => {
    it('returns nulls for a doctor with no row', async () => {
      const { service, repo } = createDeps();
      repo.findByDoctor.mockResolvedValue(null);
      await expect(service.getOwnSettings('doctor-1')).resolves.toEqual({
        minNoticeMinutes: null,
        bookingHorizonDays: null,
        slotIntervalMinutes: null,
      });
    });

    it('returns the row values for a doctor with overrides', async () => {
      const { service, repo } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: 30 }));
      await expect(service.getOwnSettings('doctor-1')).resolves.toEqual({
        minNoticeMinutes: 30,
        bookingHorizonDays: null,
        slotIntervalMinutes: null,
      });
    });
  });

  describe('updateSettings', () => {
    it('is a no-op (no upsert, no audit) when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByDoctor.mockResolvedValue(null);

      await service.updateSettings('doctor-1', 'doctor', 'doctor-1', {});

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rejects an out-of-bounds minNoticeMinutes (SETTINGS_INVALID)', async () => {
      const { service, repo } = createDeps();
      await expect(service.updateSettings('doctor-1', 'doctor', 'doctor-1', { minNoticeMinutes: -5 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('rejects an out-of-bounds bookingHorizonDays', async () => {
      const { service, repo } = createDeps();
      await expect(service.updateSettings('doctor-1', 'doctor', 'doctor-1', { bookingHorizonDays: 0 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('rejects a non-integer value', async () => {
      const { service, repo } = createDeps();
      await expect(service.updateSettings('doctor-1', 'doctor', 'doctor-1', { minNoticeMinutes: 12.5 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('allows an explicit null (clearing back to "inherit")', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: 45 }));
      repo.upsert.mockResolvedValue(settingsRow({ minNoticeMinutes: null }));

      const result = await service.updateSettings('doctor-1', 'doctor', 'doctor-1', { minNoticeMinutes: null });

      expect(repo.upsert).toHaveBeenCalledWith('doctor-1', { minNoticeMinutes: null });
      expect(result.minNoticeMinutes).toBeNull();
    });

    it('upserts and audits create when the doctor had no prior row', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByDoctor.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(settingsRow({ minNoticeMinutes: 30 }));

      await service.updateSettings('doctor-1', 'doctor', 'doctor-1', { minNoticeMinutes: 30 });

      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'availability_settings' }));
    });

    it('upserts and audits update when the doctor already had a row', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByDoctor.mockResolvedValue(settingsRow({ minNoticeMinutes: 10 }));
      repo.upsert.mockResolvedValue(settingsRow({ minNoticeMinutes: 30 }));

      await service.updateSettings('doctor-1', 'admin', 'admin-1', { minNoticeMinutes: 30 });

      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', entityType: 'availability_settings', actorType: 'admin' }));
    });
  });
});
