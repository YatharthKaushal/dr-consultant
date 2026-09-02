import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DoctorAvailabilityRow } from '../../schema/doctor-availability.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { AvailabilityRuleRepository } from './availability-rule.repository';
import { AvailabilityRuleService } from './availability-rule.service';

function row(overrides: Partial<DoctorAvailabilityRow> = {}): DoctorAvailabilityRow {
  return {
    id: 'rule-1',
    doctorId: 'doctor-1',
    ruleType: 'weekly',
    dayOfWeek: 1,
    specificDate: null,
    startTime: '09:00:00',
    endTime: '10:00:00',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as DoctorAvailabilityRow;
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    listByDoctor: jest.fn(),
    listWeeklyByDoctor: jest.fn(),
    listForRange: jest.fn(),
    replaceWeekly: jest.fn(),
    addOverride: jest.fn(),
    addBlock: jest.fn(),
    removeById: jest.fn(),
  } as unknown as jest.Mocked<AvailabilityRuleRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  // A minimal fake `Database` whose `.transaction()` just invokes the callback with itself as `tx`.
  const db = {
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  } as unknown as jest.Mocked<Database>;

  const service = new AvailabilityRuleService(db, repo, audit);
  return { service, repo, audit, db };
}

describe('AvailabilityRuleService', () => {
  describe('replaceWeekly', () => {
    it('rejects a dayOfWeek outside 0-6 (INVALID_RULE_SHAPE)', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', [{ dayOfWeek: 7, startTime: '09:00', endTime: '10:00' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.replaceWeekly).not.toHaveBeenCalled();
    });

    it('rejects endTime <= startTime (INVALID_RULE_SHAPE)', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', [{ dayOfWeek: 1, startTime: '10:00', endTime: '10:00' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.replaceWeekly).not.toHaveBeenCalled();
    });

    it('rejects two rules for the same day that overlap in time (OVERLAPPING_RULE)', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', [
          { dayOfWeek: 1, startTime: '09:00', endTime: '11:00' },
          { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
        ]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.replaceWeekly).not.toHaveBeenCalled();
    });

    it('allows two non-overlapping rules for the same day (e.g. a lunch-break split shift)', async () => {
      const { service, repo, audit } = createDeps();
      repo.replaceWeekly.mockResolvedValue([row(), row({ id: 'rule-2', startTime: '14:00:00', endTime: '17:00:00' })]);

      await service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', [
        { dayOfWeek: 1, startTime: '09:00', endTime: '11:00' },
        { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
      ]);

      expect(repo.replaceWeekly).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update', entityType: 'availability_weekly_schedule', entityId: 'doctor-1' }),
        expect.anything(),
      );
    });

    it('allows overlapping times on DIFFERENT days', async () => {
      const { service, repo } = createDeps();
      repo.replaceWeekly.mockResolvedValue([row()]);

      await service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', [
        { dayOfWeek: 1, startTime: '09:00', endTime: '11:00' },
        { dayOfWeek: 2, startTime: '09:00', endTime: '11:00' },
      ]);

      expect(repo.replaceWeekly).toHaveBeenCalled();
    });

    it('replaces with an empty list (clearing the whole week) without error', async () => {
      const { service, repo, audit } = createDeps();
      repo.replaceWeekly.mockResolvedValue([]);

      const result = await service.replaceWeekly('doctor-1', 'doctor', 'doctor-1', []);

      expect(result).toEqual([]);
      expect(repo.replaceWeekly).toHaveBeenCalledWith('doctor-1', [], expect.anything());
      expect(audit.write).toHaveBeenCalled();
    });
  });

  describe('addOverride', () => {
    it('rejects endTime <= startTime', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.addOverride('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '10:00', endTime: '09:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.addOverride).not.toHaveBeenCalled();
    });

    it('rejects an override that overlaps an existing override on the same date', async () => {
      const { service, repo } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'custom_hours', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '11:00:00' })]);

      await expect(
        service.addOverride('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '10:00', endTime: '12:00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.addOverride).not.toHaveBeenCalled();
    });

    it('allows a non-overlapping override on the same date', async () => {
      const { service, repo, audit } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'custom_hours', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '10:00:00' })]);
      repo.addOverride.mockResolvedValue(row({ ruleType: 'custom_hours', dayOfWeek: null, specificDate: '2026-09-07', startTime: '14:00:00', endTime: '15:00:00' }));

      const result = await service.addOverride('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '14:00', endTime: '15:00' });

      expect(result.startTime).toBe('14:00:00');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'availability_override' }));
    });

    it('does not conflict with a block on the same date (different rule type)', async () => {
      const { service, repo, audit } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: null, endTime: null })]);
      repo.addOverride.mockResolvedValue(row({ ruleType: 'custom_hours', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '10:00:00' }));

      await service.addOverride('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });

      expect(repo.addOverride).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalled();
    });
  });

  describe('removeOverride', () => {
    it('404s when the rule does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);
      await expect(service.removeOverride('doctor-1', 'doctor', 'doctor-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the rule belongs to a different doctor', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(row({ ruleType: 'custom_hours', doctorId: 'other-doctor' }));
      await expect(service.removeOverride('doctor-1', 'doctor', 'doctor-1', 'rule-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the rule exists but is not a custom_hours rule (e.g. weekly)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(row({ ruleType: 'weekly' }));
      await expect(service.removeOverride('doctor-1', 'doctor', 'doctor-1', 'rule-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes and audits when valid', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(row({ ruleType: 'custom_hours', specificDate: '2026-09-07' }));
      repo.removeById.mockResolvedValue(true);

      await service.removeOverride('doctor-1', 'doctor', 'doctor-1', 'rule-1');

      expect(repo.removeById).toHaveBeenCalledWith('rule-1', 'doctor-1');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', entityType: 'availability_override' }));
    });
  });

  describe('addBlock', () => {
    it('rejects a block with only startTime set (must be both or neither)', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '09:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('rejects a block with only endTime set', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', endTime: '10:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('rejects endTime <= startTime for a partial block', async () => {
      const { service, repo } = createDeps();
      await expect(
        service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '10:00', endTime: '09:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('accepts a full-day block (both times omitted)', async () => {
      const { service, repo, audit } = createDeps();
      repo.listForRange.mockResolvedValue([]);
      repo.addBlock.mockResolvedValue(row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: null, endTime: null }));

      const result = await service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07' });

      expect(result.ruleType).toBe('blocked');
      expect(audit.write).toHaveBeenCalled();
    });

    it('rejects a new full-day block when a block already exists that day', async () => {
      const { service, repo } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '10:00:00' })]);

      await expect(service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07' })).rejects.toBeInstanceOf(ConflictException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('rejects a new partial block when a full-day block already exists that day', async () => {
      const { service, repo } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: null, endTime: null })]);

      await expect(
        service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '09:00', endTime: '10:00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('rejects two overlapping partial blocks on the same date', async () => {
      const { service, repo } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '11:00:00' })]);

      await expect(
        service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '10:00', endTime: '12:00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.addBlock).not.toHaveBeenCalled();
    });

    it('allows two non-overlapping partial blocks on the same date', async () => {
      const { service, repo, audit } = createDeps();
      repo.listForRange.mockResolvedValue([row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: '09:00:00', endTime: '10:00:00' })]);
      repo.addBlock.mockResolvedValue(row({ ruleType: 'blocked', dayOfWeek: null, specificDate: '2026-09-07', startTime: '14:00:00', endTime: '15:00:00' }));

      await service.addBlock('doctor-1', 'doctor', 'doctor-1', { specificDate: '2026-09-07', startTime: '14:00', endTime: '15:00' });

      expect(repo.addBlock).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalled();
    });
  });

  describe('removeBlock', () => {
    it('404s when the rule does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);
      await expect(service.removeBlock('doctor-1', 'doctor', 'doctor-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the rule is not a blocked rule (e.g. custom_hours)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(row({ ruleType: 'custom_hours' }));
      await expect(service.removeBlock('doctor-1', 'doctor', 'doctor-1', 'rule-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes and audits when valid', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(row({ ruleType: 'blocked', specificDate: '2026-09-07', startTime: null, endTime: null }));
      repo.removeById.mockResolvedValue(true);

      await service.removeBlock('doctor-1', 'doctor', 'doctor-1', 'rule-1');

      expect(repo.removeById).toHaveBeenCalledWith('rule-1', 'doctor-1');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', entityType: 'availability_block' }));
    });
  });

  describe('reads', () => {
    it('listWeekly delegates to the repository', async () => {
      const { service, repo } = createDeps();
      repo.listWeeklyByDoctor.mockResolvedValue([row()]);
      const result = await service.listWeekly('doctor-1');
      expect(result).toHaveLength(1);
      expect(repo.listWeeklyByDoctor).toHaveBeenCalledWith('doctor-1');
    });

    it('listAll delegates to the repository', async () => {
      const { service, repo } = createDeps();
      repo.listByDoctor.mockResolvedValue([row()]);
      const result = await service.listAll('doctor-1');
      expect(result).toHaveLength(1);
      expect(repo.listByDoctor).toHaveBeenCalledWith('doctor-1');
    });
  });
});
