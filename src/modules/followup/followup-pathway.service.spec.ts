/**
 * `FollowupPathwayService` — the admin write path for FR-13.7's "question
 * sets and red-flag rules editable from the admin panel with no app release."
 *
 * `new FollowupPathwayService(mockedDeps)` with hand-rolled `jest.fn()`s,
 * never `Test.createTestingModule` — same discipline `legal-document.service
 * .spec.ts` applies to the identical invariant on `legal_documents`.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { FollowupPathwayService } from './followup-pathway.service';
import type { FollowupPathwayRepository } from './followup-pathway.repository';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

const QUESTIONS = [{ id: 'mood', text: 'Mood?', type: 'scale_1_5', required: true }];
const RULES = [{ id: 'r1', questionId: 'mood', matchValues: ['1'], severity: 'red', reason: 'Very low mood reported.' }];

function row(overrides: Partial<FollowupPathwayRow> = {}): FollowupPathwayRow {
  return {
    id: 'p0000000-0000-4000-8000-000000000001',
    code: 'general',
    name: 'General Follow-up',
    version: 1,
    durationDays: 7,
    questions: QUESTIONS,
    redFlagRules: RULES,
    isCurrent: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The `pg` driver's unique-violation shape, as `postgres-error.util.ts` documents it. */
const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

describe('FollowupPathwayService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<FollowupPathwayRepository>;
  let audit: jest.Mocked<AuditService>;
  let service: FollowupPathwayService;
  let calls: string[];
  let stored: FollowupPathwayRow | null;

  beforeEach(() => {
    calls = [];
    stored = null;
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      findById: jest.fn().mockResolvedValue(null),
      findByCodeAndVersion: jest.fn().mockResolvedValue(null),
      findCurrentByCode: jest.fn().mockResolvedValue(null),
      listByCode: jest.fn().mockResolvedValue([]),
      listLatestPerCode: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (data: Partial<FollowupPathwayRow>) => {
        calls.push('create');
        stored = row({ ...data, id: 'p0000000-0000-4000-8000-0000000000ff' });
        return stored;
      }),
      lockCodeGuard: jest.fn(async () => {
        calls.push('lock');
      }),
      clearCurrent: jest.fn(async () => {
        calls.push('clearCurrent');
        return [];
      }),
      setCurrent: jest.fn(async (id: string) => {
        calls.push('setCurrent');
        const target = stored && stored.id === id ? stored : row({ id });
        return { ...target, isCurrent: true };
      }),
    } as unknown as jest.Mocked<FollowupPathwayRepository>;

    audit = { write: jest.fn(async () => { calls.push('audit'); }) } as unknown as jest.Mocked<AuditService>;

    service = new FollowupPathwayService(db as unknown as Database, repo, audit);
  });

  describe('adminCreateVersion', () => {
    it('creates an unpublished version without touching the lock or any other row', async () => {
      const result = await service.adminCreateVersion(ADMIN_ID, {
        code: 'general',
        name: 'General Follow-up',
        version: 1,
        durationDays: 7,
        questions: QUESTIONS,
        redFlagRules: RULES,
        publish: false,
      });

      expect(result.isCurrent).toBe(false);
      expect(repo.lockCodeGuard).not.toHaveBeenCalled();
      expect(repo.setCurrent).not.toHaveBeenCalled();
      expect(calls).toEqual(['create', 'audit']);
    });

    it('takes the advisory lock BEFORE reading/writing current when publish is true', async () => {
      await service.adminCreateVersion(ADMIN_ID, {
        code: 'general',
        name: 'General Follow-up',
        version: 2,
        durationDays: 7,
        questions: QUESTIONS,
        redFlagRules: RULES,
        publish: true,
      });

      // The lock is taken before the insert, and everything else follows it —
      // this ordering is the entire correctness argument for the invariant.
      expect(calls).toEqual(['lock', 'create', 'clearCurrent', 'setCurrent', 'audit']);
    });

    it('rejects a duplicate (code, version) via the pre-check', async () => {
      repo.findByCodeAndVersion.mockResolvedValueOnce(row());
      await expect(
        service.adminCreateVersion(ADMIN_ID, {
          code: 'general',
          name: 'General Follow-up',
          version: 1,
          durationDays: 7,
          questions: QUESTIONS,
          redFlagRules: RULES,
          publish: false,
        }),
      ).rejects.toThrow(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('converts a race-losing unique violation into the same 409', async () => {
      repo.create.mockRejectedValueOnce(uniqueViolation);
      await expect(
        service.adminCreateVersion(ADMIN_ID, {
          code: 'general',
          name: 'General Follow-up',
          version: 1,
          durationDays: 7,
          questions: QUESTIONS,
          redFlagRules: RULES,
          publish: false,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a malformed question set before ever reaching the repository', async () => {
      await expect(
        service.adminCreateVersion(ADMIN_ID, {
          code: 'general',
          name: 'General Follow-up',
          version: 1,
          durationDays: 7,
          questions: [],
          redFlagRules: [],
          publish: false,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.findByCodeAndVersion).not.toHaveBeenCalled();
    });

    it('rejects a red-flag rule referencing a question outside this version\'s own question set', async () => {
      await expect(
        service.adminCreateVersion(ADMIN_ID, {
          code: 'general',
          name: 'General Follow-up',
          version: 1,
          durationDays: 7,
          questions: QUESTIONS,
          redFlagRules: [{ id: 'r1', questionId: 'not_a_question', matchValues: ['1'], severity: 'red', reason: 'x' }],
          publish: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('adminPublish', () => {
    it('locks, demotes the previous current row and promotes the target, in that order', async () => {
      const target = row({ id: 'p2', version: 2, isCurrent: false });
      repo.findById.mockResolvedValue(target);

      await service.adminPublish(ADMIN_ID, 'p2');

      expect(calls).toEqual(['lock', 'clearCurrent', 'setCurrent', 'audit']);
      expect(repo.clearCurrent).toHaveBeenCalledWith('general', 'p2', db);
    });

    it('is idempotent: publishing the already-current version still audits, demoting nothing meaningful', async () => {
      const target = row({ id: 'p1', isCurrent: true });
      repo.findById.mockResolvedValue(target);

      const result = await service.adminPublish(ADMIN_ID, 'p1');
      expect(result.isCurrent).toBe(true);
      expect(audit.write).toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.adminPublish(ADMIN_ID, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCurrentByCodeOrThrow', () => {
    it('throws NotFoundException when no version has ever been published for the code', async () => {
      repo.findCurrentByCode.mockResolvedValue(null);
      await expect(service.getCurrentByCodeOrThrow('general')).rejects.toThrow(NotFoundException);
    });

    it('returns the current row when one exists', async () => {
      const current = row({ isCurrent: true });
      repo.findCurrentByCode.mockResolvedValue(current);
      await expect(service.getCurrentByCodeOrThrow('general')).resolves.toBe(current);
    });
  });
});
