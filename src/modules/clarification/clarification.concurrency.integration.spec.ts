/**
 * *** REAL-DATABASE TEST. *** Follows `document/patient-file.transaction.
 * integration.spec.ts`'s four pattern rules — one fixture helper, strict
 * reverse-FK teardown, per-run UUID namespacing, a positive control on every
 * claim — the same convention `instant.routing-race.integration.spec.ts` and
 * `booking.slot-race.integration.spec.ts` follow for their own row locks.
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * `clarification.service.spec.ts` asserts that a status transition CALLS
 * `ClarificationRepository.updateStatusIfIn` with the right `from` array.
 * That is a claim about a `jest.fn()`. It says nothing about whether the
 * guarded `UPDATE ... WHERE status IN (from)`, taken under
 * `findByIdForUpdate`'s `SELECT ... FOR UPDATE`, actually serialises two
 * genuinely concurrent callers — only Postgres can answer that.
 *
 * Three claims here, each a fact about the database, not about service code:
 *
 *   1. `clarification.constants.ts#CLARIFICATION_STATUS_TRANSITIONS`'s
 *      row lock really does let exactly one of two simultaneous transition
 *      attempts on the SAME case succeed, whether the two are racing to
 *      POST the same draft or racing to ASSIGN two different experts to the
 *      same posted case.
 *   2. `ClarificationRepository#listByExpertDoctor`'s `WHERE expert_doctor_id
 *      = ?` — CHECK #2, "what they may see" — really does return `[]` for an
 *      expert with zero assignments even while OTHER experts' real rows sit
 *      in the same table, and `getAssignedCase` really does 404 (not leak)
 *      a case that exists but is somebody else's.
 *   3. *** THE ACKNOWLEDGED TOCTOU IN `assignExpert`. *** Its own doc comment
 *      in `clarification.service.ts` claims a narrow, accepted race: the
 *      `DoctorFacade.isExpertDoctor` check happens once, before the
 *      transaction opens, so a seniority revocation landing in the gap
 *      between that check and the commit is not caught. That claim is
 *      reproduced here deterministically against real Postgres rather than
 *      asserted only in prose — see that test's own header for why a
 *      deterministic sequential reproduction is the honest way to prove a
 *      timing hole exists, where a genuine `Promise.all` race would only
 *      prove it PROBABLY exists, on this run, on this machine.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 *
 * Real: the database, `ClarificationRepository`, `ClarificationService`,
 * `AuditService`, `DoctorRepository` (used both directly, for fixtures and
 * assertions, and to back the `isExpertDoctor` stand-in below).
 *
 * NOT real: `DoctorFacade` and `ClinicalFacade` are not constructed through
 * Nest DI — `DoctorFacade` alone pulls in `DoctorService`/
 * `DoctorSpecialtyService`/`DoctorPresenceService` and, transitively,
 * `CatalogueModule`/`StorageModule`, none of which this file's claims are
 * about. `doctorFacadeStub.isExpertDoctor` below is not a `jest.fn()` — it
 * is `DoctorService#isExpertDoctor`'s exact logic, backed by a REAL
 * `DoctorRepository.findById` read against real Postgres, so the fact under
 * test (a revoked doctor genuinely reads back as not-expert) is still
 * proven for real. `clinicalFacadeStub` is never called — every fixture case
 * is seeded directly through `ClarificationRepository.create`, never through
 * `ClarificationService.createDraft`, so `sourceConsultationId` verification
 * is out of scope for this file (it is exercised in
 * `clarification.service.spec.ts` with a mocked `ClinicalFacade`).
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do, and fails loudly rather than skipping if the database is unreachable: a
 * silently-skipped concurrency test is worse than no test.
 */
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { clarificationCasesTable, type NewClarificationCaseRow } from '../../schema/clarification-cases.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { DoctorFacade } from '../doctor/doctor.facade';
import { DoctorRepository } from '../doctor/doctor.repository';
import { CLARIFICATION_AUDIT_ENTITY_TYPES, CLARIFICATION_ERROR_CODES } from './clarification.constants';
import { ClarificationRepository } from './clarification.repository';
import { ClarificationService } from './clarification.service';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  treatingDoctorId: string;
  /** Two verified experts, so the assignment race has two genuine, distinct winners to choose between. */
  expertAId: string;
  expertBId: string;
  /** A THIRD verified expert with zero assignments — the read-scoping fixture's true negative. */
  expertWithNoCasesId: string;
  /** Not the expert seniority level — the assignment gate's negative control. */
  notExpertId: string;
  doctorIds: string[];
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9199${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  async function makeDoctor(label: string, overrides: Partial<typeof doctorsTable.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `${label} ${runId}`,
        verificationStatus: 'verified',
        seniorityLevel: 'standard',
        ...overrides,
      })
      .returning({ id: doctorsTable.id });
    return row.id;
  }

  const treatingDoctorId = await makeDoctor('Treating');
  const expertAId = await makeDoctor('ExpertA', { seniorityLevel: 'expert' });
  const expertBId = await makeDoctor('ExpertB', { seniorityLevel: 'expert' });
  const expertWithNoCasesId = await makeDoctor('ExpertNoCases', { seniorityLevel: 'expert' });
  const notExpertId = await makeDoctor('NotExpert', { seniorityLevel: 'standard' });

  return {
    runId,
    treatingDoctorId,
    expertAId,
    expertBId,
    expertWithNoCasesId,
    notExpertId,
    doctorIds: [treatingDoctorId, expertAId, expertBId, expertWithNoCasesId, notExpertId],
  };
}

/** Strict reverse FK order: `clarification_cases` before `doctors`, `audit_log` has no FK but is scoped and cleaned anyway. */
async function teardown(db: Database, fixtures: Fixtures, caseIds: string[]): Promise<void> {
  if (caseIds.length > 0) {
    await db.delete(clarificationCasesTable).where(inArray(clarificationCasesTable.id, caseIds));
    await db.execute(
      sql`delete from audit_log where entity_type = ${CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE} and entity_id in (${sql.join(
        caseIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, fixtures.doctorIds));
}

function baseCase(fixtures: Fixtures, overrides: Partial<NewClarificationCaseRow> = {}): NewClarificationCaseRow {
  return {
    treatingDoctorId: fixtures.treatingDoctorId,
    title: `Concurrency-test case ${fixtures.runId}`,
    briefHistory: 'Three months of low mood.',
    specificDoubt: 'Would an SSRI switch be reasonable?',
    status: 'draft',
    ...overrides,
  };
}

describe('Clarification — the row lock, the expert read scope, and the acknowledged TOCTOU (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let clarificationRepo: ClarificationRepository;
  let doctorRepo: DoctorRepository;
  let auditService: AuditService;
  let service: ClarificationService;
  const seededCaseIds: string[] = [];

  /**
   * `DoctorService#isExpertDoctor`'s exact logic, reproduced against a REAL
   * `DoctorRepository.findById` — see this file's header, "what is real and
   * what is not", for why this stands in for the full `DoctorFacade` here.
   */
  const doctorFacadeStub: Pick<DoctorFacade, 'isExpertDoctor'> = {
    isExpertDoctor: async (doctorId: string) => {
      const doctor = await doctorRepo.findById(doctorId);
      return doctor !== null && doctor.verificationStatus === 'verified' && doctor.seniorityLevel === 'expert';
    },
  };

  const clinicalFacadeStub: Pick<ClinicalFacade, 'getRecordByConsultationId'> = {
    getRecordByConsultationId: async () => {
      throw new Error('clinicalFacadeStub.getRecordByConsultationId was called — this spec seeds every case directly and should never reach it.');
    },
  };

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);
    clarificationRepo = new ClarificationRepository(db);
    doctorRepo = new DoctorRepository(db);
    auditService = new AuditService(db);
    service = new ClarificationService(
      db,
      clarificationRepo,
      doctorFacadeStub as DoctorFacade,
      clinicalFacadeStub as ClinicalFacade,
      auditService,
    );
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures, seededCaseIds);
    } finally {
      await disconnectDatabase();
    }
  });

  async function seedCase(overrides: Partial<NewClarificationCaseRow> = {}) {
    const row = await clarificationRepo.create(baseCase(fixtures, overrides));
    seededCaseIds.push(row.id);
    return row;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 1. The row lock: two simultaneous transitions, exactly one wins
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the row lock — postCase', () => {
    it('*** LETS EXACTLY ONE OF TWO SIMULTANEOUS postCase CALLS WIN *** — the loser gets a real ConflictException, not a double-post', async () => {
      const draft = await seedCase({ status: 'draft' });

      const results = await Promise.allSettled([
        service.postCase(draft.id, fixtures.treatingDoctorId),
        service.postCase(draft.id, fixtures.treatingDoctorId),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.response.code).toBe(CLARIFICATION_ERROR_CODES.ILLEGAL_TRANSITION);

      const [row] = await db.select().from(clarificationCasesTable).where(eq(clarificationCasesTable.id, draft.id));
      expect(row.status).toBe('posted');
      expect(row.postedAt).not.toBeNull();
    });

    it('POSITIVE CONTROL: postCase on two DIFFERENT drafts never contends at all', async () => {
      const draftA = await seedCase({ status: 'draft', title: `Positive control A ${fixtures.runId}` });
      const draftB = await seedCase({ status: 'draft', title: `Positive control B ${fixtures.runId}` });

      const [a, b] = await Promise.all([
        service.postCase(draftA.id, fixtures.treatingDoctorId),
        service.postCase(draftB.id, fixtures.treatingDoctorId),
      ]);

      expect(a.status).toBe('posted');
      expect(b.status).toBe('posted');
    });
  });

  describe('the row lock — assignExpert', () => {
    it('*** LETS EXACTLY ONE OF TWO ADMINS ASSIGN A (DIFFERENT) EXPERT TO THE SAME CASE *** — never both, never a merge', async () => {
      const posted = await seedCase({ status: 'posted', postedAt: new Date() });

      const results = await Promise.allSettled([
        service.assignExpert(posted.id, fixtures.expertAId, randomUUID()),
        service.assignExpert(posted.id, fixtures.expertBId, randomUUID()),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      const [row] = await db.select().from(clarificationCasesTable).where(eq(clarificationCasesTable.id, posted.id));
      expect(row.status).toBe('awaiting_response');
      expect([fixtures.expertAId, fixtures.expertBId]).toContain(row.expertDoctorId);
      expect(row.assignedAt).not.toBeNull();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. CHECK #2 against real rows: the expert read scope
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the expert read scope — against real rows, not mocks', () => {
    it('an expert with zero assigned cases gets [] even while OTHER experts genuinely have rows in the same table', async () => {
      // Real rows for two OTHER experts — "other cases exist in the table" is
      // not a comment here, it is two committed Postgres rows.
      await seedCase({ status: 'awaiting_response', expertDoctorId: fixtures.expertAId, assignedAt: new Date() });
      await seedCase({ status: 'awaiting_response', expertDoctorId: fixtures.expertBId, assignedAt: new Date() });

      const result = await service.listAssignedCases(fixtures.expertWithNoCasesId, {});

      expect(result).toEqual([]);
    });

    it('an expert with exactly one assigned case gets exactly that one, not another expert\'s', async () => {
      const mine = await seedCase({ status: 'awaiting_response', expertDoctorId: fixtures.expertAId, assignedAt: new Date() });
      const someoneElses = await seedCase({
        status: 'awaiting_response',
        expertDoctorId: fixtures.expertBId,
        assignedAt: new Date(),
      });

      const result = await service.listAssignedCases(fixtures.expertAId, {});

      expect(result.map((c) => c.id)).toContain(mine.id);
      expect(result.map((c) => c.id)).not.toContain(someoneElses.id);
    });

    it('getAssignedCase 404s (not 403, no existence leak) for a case that genuinely exists but is assigned to someone else', async () => {
      const someoneElses = await seedCase({
        status: 'awaiting_response',
        expertDoctorId: fixtures.expertBId,
        assignedAt: new Date(),
      });

      await expect(service.getAssignedCase(someoneElses.id, fixtures.expertAId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getAssignedCase succeeds, and never carries sourceConsultationId, for the true assignee', async () => {
      const mine = await seedCase({ status: 'awaiting_response', expertDoctorId: fixtures.expertAId, assignedAt: new Date() });

      const result = await service.getAssignedCase(mine.id, fixtures.expertAId);

      expect(result.id).toBe(mine.id);
      expect('sourceConsultationId' in result).toBe(false);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. The acknowledged TOCTOU in assignExpert
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('*** THE ACKNOWLEDGED TOCTOU (see clarification.service.ts#assignExpert) ***', () => {
    it('a real assignExpert call refuses a doctor whose seniority was revoked BEFORE it is called — the ordinary case, proven for real', async () => {
      const revocable = await makeRevocableExpert();
      await doctorRepo.updateSeniority(revocable, 'standard');

      const posted = await seedCase({ status: 'posted', postedAt: new Date() });

      await expect(service.assignExpert(posted.id, revocable, randomUUID())).rejects.toMatchObject({
        response: { code: CLARIFICATION_ERROR_CODES.NOT_AN_EXPERT },
      });

      const [row] = await db.select().from(clarificationCasesTable).where(eq(clarificationCasesTable.id, posted.id));
      expect(row.expertDoctorId).toBeNull();
    });

    /**
     * *** THE HOLE ITSELF, PROVEN DETERMINISTICALLY AGAINST REAL POSTGRES. ***
     *
     * A genuine `Promise.all([assignExpert(...), revoke...])` race would only
     * show that the hole PROBABLY exists, with the outcome depending on which
     * of two real network round trips (the `isExpertDoctor` SELECT and the
     * revocation UPDATE) happens to land first on this run, on this machine
     * — exactly the kind of test that is green in CI and would still miss the
     * bug it exists to catch. `assignExpert`'s code does not leave that to
     * chance either: it performs its `isExpertDoctor` check ONCE, unconditionally,
     * before opening any transaction (`clarification.service.ts#assignExpert`'s
     * own doc comment). So this test reproduces the two steps in the exact
     * order and with the exact isolation the real method has — a real read,
     * then a real, independent commit that revokes the role, then the real
     * write the method performs with no further re-check — which proves the
     * gap exists on EVERY run, not just some.
     */
    it('*** if seniority is revoked AFTER the check but BEFORE the write commits, the assignment still goes through ***', async () => {
      const revocable = await makeRevocableExpert();
      const posted = await seedCase({ status: 'posted', postedAt: new Date() });

      // Step 1: assignExpert's own first move — a real, unconditional read.
      const isExpert = await doctorFacadeStub.isExpertDoctor(revocable);
      expect(isExpert).toBe(true);

      // Step 2: THE RACE — a real, independently-committed revocation landing
      // in the gap `clarification.service.ts#assignExpert`'s doc comment
      // names, between that check and the write below.
      await doctorRepo.updateSeniority(revocable, 'standard');
      expect(await doctorFacadeStub.isExpertDoctor(revocable)).toBe(false); // genuinely revoked, for real, right now

      // Step 3: THE WRITE — exactly `assignExpert`'s own guarded UPDATE,
      // reusing the STALE `isExpert = true` result from step 1 rather than
      // re-checking, because the real method never re-checks either.
      const updated = await clarificationRepo.updateStatusIfIn(posted.id, ['posted'], {
        status: 'awaiting_response',
        expertDoctorId: revocable,
        assignedAt: new Date(),
      });

      // *** THE HOLE. *** Nothing at the database layer stops a now-revoked
      // doctor from being written as expertDoctorId — there is no CHECK
      // constraint and no trigger; the seniority gate is purely an
      // application-level, once-only read.
      expect(updated).not.toBeNull();
      expect(updated!.expertDoctorId).toBe(revocable);

      const [doctorRow] = await db.select().from(doctorsTable).where(eq(doctorsTable.id, revocable));
      expect(doctorRow.seniorityLevel).toBe('standard');
    });
  });

  /** One extra expert per revocation test, seeded fresh, torn down with everything else — never reusing a fixture doctor whose seniority a prior test may have already revoked. */
  async function makeRevocableExpert(): Promise<string> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: `+9199${suffix}`,
        fullName: `Revocable Expert ${fixtures.runId}-${suffix}`,
        verificationStatus: 'verified',
        seniorityLevel: 'expert',
      })
      .returning({ id: doctorsTable.id });
    fixtures.doctorIds.push(row.id);
    return row.id;
  }
});
