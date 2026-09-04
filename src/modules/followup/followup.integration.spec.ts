/**
 * *** REAL-DATABASE TEST. Follows `consent/consent.current-version.
 * integration.spec.ts` and `clinical/clinical.completion-gate.integration
 * .spec.ts` — one fixture helper, strict reverse-FK teardown, per-run
 * namespacing, and a positive control on every claim. ***
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * `followup-pathway.service.spec.ts` asserts that `adminPublish` CALLS
 * `lockCodeGuard`. That is a claim about a `jest.fn()` — it would pass
 * identically against a `lockCodeGuard` whose SQL is wrong or takes a lock in
 * a session outside the transaction that needs it, and `followup_pathways`
 * carries only a plain index on `(code, is_current)`, no unique constraint
 * that could express "exactly one current version" on its own.
 * `followup.service.spec.ts` asserts that `insertCheckin` was called; it
 * cannot prove the REAL partial unique index on
 * `(consultation_id, checkin_date)` is what actually refuses a duplicate.
 *
 * The claims below are claims about rows in Postgres:
 *
 *   1. Two admins publishing the same pathway code at once leave EXACTLY ONE
 *      current version — through the real service, against the real
 *      advisory lock.
 *   2. An assignment pinned to v1 keeps reading v1's questions and red-flag
 *      rules after an admin publishes v2 as current (FR-13.7).
 *   3. A duplicate `(consultation_id, checkin_date)` is refused with a clean
 *      409, converted from the real driver's `23505`.
 *   4. The missed-check-in sweep raises one alert for a genuinely missed day,
 *      never re-raises it on a second pass, and moves a fully-elapsed
 *      assignment to `completed`.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 *
 * Real: the database, `FollowupPathwayRepository`, `FollowupPathwayService`,
 * `FollowupRepository`, `FollowupAlertService`, `FollowupService`,
 * `FollowupCheckinSweepService`, `AuditService`.
 *
 * Stubbed: `BookingFacade` (a hand-built object exposing only `getBooking`,
 * reading the SAME `consultations` fixture rows this spec inserts directly —
 * constructing the real `BookingFacade` would mean wiring six other modules'
 * full dependency graphs for a read this spec can assert correctly by hand)
 * and `ClinicalFacade`/`CARE_HUB_PORT` (unused by any claim below — none of
 * these tests exercise `getCarePlan`). `FOLLOWUP_NOTIFICATION_PORT` and
 * `ADMIN_DIRECTORY_PORT` are the real null objects
 * (`UnavailableFollowupNotificationProvider`/`UnavailableAdminDirectoryProvider`)
 * — exactly what this module runs against today.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local`, exactly as the seed scripts
 * do, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { checkinResponsesTable } from '../../schema/checkin-responses.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { followupAssignmentsTable } from '../../schema/followup-assignments.schema';
import { followupPathwaysTable } from '../../schema/followup-pathways.schema';
import { patientsTable } from '../../schema/patients.schema';
import { safetyAlertsTable } from '../../schema/safety-alerts.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import { FollowupAlertService } from './followup-alert.service';
import { addDaysToIsoDate } from './followup-ist.util';
import { FollowupPathwayRepository } from './followup-pathway.repository';
import { FollowupPathwayService } from './followup-pathway.service';
import { FollowupCheckinSweepService, missedCheckinReason } from './followup-checkin-sweep.service';
import { UnavailableAdminDirectoryProvider } from './unavailable-admin-directory.provider';
import { UnavailableFollowupNotificationProvider } from './unavailable-notification.provider';
import { FollowupRepository } from './followup.repository';
import { FollowupService } from './followup.service';

jest.setTimeout(30_000);

const QUESTIONS = [{ id: 'mood', text: 'Mood?', type: 'scale_1_5', required: true }];
const RED_FLAG_RULES = [{ id: 'r1', questionId: 'mood', matchValues: ['1'], severity: 'red', reason: 'Very low mood reported.' }];
const V2_QUESTIONS = [
  { id: 'mood', text: 'Mood?', type: 'scale_1_5', required: true },
  { id: 'sleep', text: 'Sleep?', type: 'yes_no', required: true },
];
const V2_RULES = [{ id: 'r1', questionId: 'sleep', matchValues: ['no'], severity: 'amber', reason: 'Sleep worsening reported.' }];

describe('M-16 follow-up pathways, check-ins and the missed-check-in sweep, against a real database', () => {
  let db: Database;
  let pathwayRepo: FollowupPathwayRepository;
  let pathways: FollowupPathwayService;
  let repo: FollowupRepository;
  let alerts: FollowupAlertService;
  let followup: FollowupService;
  let sweep: FollowupCheckinSweepService;

  const adminId = randomUUID();
  const runId = randomUUID().slice(0, 8);
  const code = (label: string) => `test_${label}_${runId}`;

  let specialtyId: string;
  let patientId: string;
  const createdConsultationIds: string[] = [];
  const createdPathwayIds: string[] = [];
  let consultationSeq = 0;

  async function makeConsultation(): Promise<string> {
    consultationSeq += 1;
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `FU-${runId}-${consultationSeq}`,
        patientId,
        doctorId: null,
        specialtyId,
        mode: 'scheduled',
        status: 'completed',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    createdConsultationIds.push(row.id);
    return row.id;
  }

  /** BookingFacade's `getBooking`, hand-stubbed against the real fixture row — see this file's header for why. */
  function stubBookingFacade(): BookingFacade {
    return {
      getBooking: async (consultationId: string) => {
        const [row] = await db.select().from(consultationsTable).where(eq(consultationsTable.id, consultationId));
        if (!row) return null;
        return {
          id: row.id,
          referenceCode: row.referenceCode,
          patientId: row.patientId,
          doctorId: row.doctorId,
          specialtyId: row.specialtyId,
          concernId: row.concernId,
          mode: row.mode,
          status: row.status,
          scheduledStartAt: row.scheduledStartAt,
          durationMinutes: row.durationMinutes,
          intakeAnswers: row.intakeAnswers,
          rescheduledFromConsultationId: row.rescheduledFromConsultationId,
          cancelledAt: row.cancelledAt,
          cancelledByParty: row.cancelledByParty,
          cancellationReason: row.cancellationReason,
          createdAt: row.createdAt,
        };
      },
    } as unknown as BookingFacade;
  }

  const stubClinicalFacade = { getCarePlanInputs: async () => null } as unknown as ClinicalFacade;
  const stubCareHub = { getRecommendedForConsultation: async () => [] };

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();

    const audit = new AuditService(db);
    pathwayRepo = new FollowupPathwayRepository(db);
    pathways = new FollowupPathwayService(db, pathwayRepo, audit);
    repo = new FollowupRepository(db);
    alerts = new FollowupAlertService(repo, audit, new UnavailableFollowupNotificationProvider(), new UnavailableAdminDirectoryProvider());
    followup = new FollowupService(repo, pathways, alerts, audit, stubBookingFacade(), stubClinicalFacade, stubCareHub);
    sweep = new FollowupCheckinSweepService(repo, pathways, alerts, stubBookingFacade());

    const [specialty] = await db
      .insert(specialtiesTable)
      .values({ code: `followup_test_${runId}`, name: `Followup Test Specialty ${runId}`, isActive: true })
      .returning({ id: specialtiesTable.id });
    specialtyId = specialty.id;

    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: `+9197${runId.slice(0, 6)}01`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientId = patient.id;
  });

  afterAll(async () => {
    if (db) {
      await db.delete(safetyAlertsTable).where(inArray(safetyAlertsTable.consultationId, createdConsultationIds));
      await db.delete(checkinResponsesTable).where(inArray(checkinResponsesTable.consultationId, createdConsultationIds));
      await db.delete(followupAssignmentsTable).where(inArray(followupAssignmentsTable.consultationId, createdConsultationIds));
      await db.delete(consultationsTable).where(inArray(consultationsTable.id, createdConsultationIds));
      await db.delete(patientsTable).where(eq(patientsTable.id, patientId));
      await db.delete(specialtiesTable).where(eq(specialtiesTable.id, specialtyId));
      if (createdPathwayIds.length > 0) {
        await db.delete(followupPathwaysTable).where(inArray(followupPathwaysTable.id, createdPathwayIds));
      }
      await db.delete(auditLogTable).where(and(eq(auditLogTable.actorType, 'admin'), eq(auditLogTable.actorId, adminId)));
      await disconnectDatabase();
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 1. Exactly one current version per pathway code, under real concurrency. */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('exactly one current pathway version per code', () => {
    it('two admins publishing at the same instant leave exactly one current version', async () => {
      const raceCode = code('race');

      const results = await Promise.all([
        pathways.adminCreateVersion(adminId, { code: raceCode, name: 'Race A', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true }),
        pathways.adminCreateVersion(adminId, { code: raceCode, name: 'Race B', version: 2, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true }),
      ]);
      createdPathwayIds.push(...results.map((r) => r.id));

      const current = await db
        .select({ id: followupPathwaysTable.id })
        .from(followupPathwaysTable)
        .where(and(eq(followupPathwaysTable.code, raceCode), eq(followupPathwaysTable.isCurrent, true)));

      expect(current).toHaveLength(1);
      expect(results.map((r) => r.id)).toContain(current[0]?.id);
    });

    it('five concurrent publishes of five different versions still leave exactly one current', async () => {
      const raceCode = code('five');
      const candidates = await Promise.all(
        [1, 2, 3, 4, 5].map((v) =>
          pathways.adminCreateVersion(adminId, { code: raceCode, name: `V${v}`, version: v, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: false }),
        ),
      );
      createdPathwayIds.push(...candidates.map((c) => c.id));

      await Promise.all(candidates.map((c) => pathways.adminPublish(adminId, c.id)));

      const current = await db
        .select({ id: followupPathwaysTable.id })
        .from(followupPathwaysTable)
        .where(and(eq(followupPathwaysTable.code, raceCode), eq(followupPathwaysTable.isCurrent, true)));
      expect(current).toHaveLength(1);
    });

    it('publishing one code does not disturb another code\'s current version (positive control)', async () => {
      const untouchedCode = code('untouched');
      const other = await pathways.adminCreateVersion(adminId, { code: untouchedCode, name: 'Untouched', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(other.id);

      const raceCode = code('later');
      const later = await pathways.adminCreateVersion(adminId, { code: raceCode, name: 'Later', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(later.id);

      const stillCurrent = await db
        .select({ id: followupPathwaysTable.id })
        .from(followupPathwaysTable)
        .where(and(eq(followupPathwaysTable.code, untouchedCode), eq(followupPathwaysTable.isCurrent, true)));
      expect(stillCurrent).toHaveLength(1);
      expect(stillCurrent[0]?.id).toBe(other.id);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 2. FR-13.7: an in-flight assignment keeps the version it started on.    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('pathway version pinning (FR-13.7)', () => {
    it('an assignment pinned at v1 keeps reading v1\'s questions and rules after v2 is published current', async () => {
      const pinCode = code('pin');
      const v1 = await pathways.adminCreateVersion(adminId, { code: pinCode, name: 'Pin V1', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(v1.id);

      const consultationId = await makeConsultation();
      const assignment = await followup.assignPathway({ consultationId, pathwayCode: pinCode });
      expect(assignment.pathwayVersion).toBe(1);

      // Admin publishes v2 mid-week.
      const v2 = await pathways.adminCreateVersion(adminId, { code: pinCode, name: 'Pin V2', version: 2, durationDays: 7, questions: V2_QUESTIONS, redFlagRules: V2_RULES, publish: true });
      createdPathwayIds.push(v2.id);

      // The in-flight assignment is untouched.
      const stillPinned = await followup.getAssignment(consultationId);
      expect(stillPinned?.pathwayVersion).toBe(1);

      // A check-in against it scores using v1's rules (mood=1 -> red), not v2's (which has no rule on `mood` at all).
      const result = await followup.submitCheckin({ consultationId, answers: { mood: '1' }, actorPatientId: patientId });
      expect(result.response.status).toBe('red');
    });

    it('a NEW assignment made after the publish gets v2', async () => {
      const pinCode = code('pin2');
      const v1 = await pathways.adminCreateVersion(adminId, { code: pinCode, name: 'V1', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(v1.id);
      const v2 = await pathways.adminCreateVersion(adminId, { code: pinCode, name: 'V2', version: 2, durationDays: 7, questions: V2_QUESTIONS, redFlagRules: V2_RULES, publish: true });
      createdPathwayIds.push(v2.id);

      const consultationId = await makeConsultation();
      const assignment = await followup.assignPathway({ consultationId, pathwayCode: pinCode });
      expect(assignment.pathwayVersion).toBe(2);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 3. The duplicate check-in refusal, against the real partial unique      */
  /*    index on (consultation_id, checkin_date).                            */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('duplicate check-in refusal', () => {
    it('refuses a sequential resubmission for the same day with a clean 409', async () => {
      const dupCode = code('dup');
      const pathway = await pathways.adminCreateVersion(adminId, { code: dupCode, name: 'Dup', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(pathway.id);
      const consultationId = await makeConsultation();
      await followup.assignPathway({ consultationId, pathwayCode: dupCode });

      await followup.submitCheckin({ consultationId, answers: { mood: '3' }, actorPatientId: patientId });

      await expect(
        followup.submitCheckin({ consultationId, answers: { mood: '4' }, actorPatientId: patientId }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses two genuinely concurrent submissions for the same day, leaving exactly one row', async () => {
      const dupCode = code('dup-race');
      const pathway = await pathways.adminCreateVersion(adminId, { code: dupCode, name: 'Dup Race', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(pathway.id);
      const consultationId = await makeConsultation();
      await followup.assignPathway({ consultationId, pathwayCode: dupCode });

      const results = await Promise.allSettled([
        followup.submitCheckin({ consultationId, answers: { mood: '3' }, actorPatientId: patientId }),
        followup.submitCheckin({ consultationId, answers: { mood: '3' }, actorPatientId: patientId }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rows = await db.select().from(checkinResponsesTable).where(eq(checkinResponsesTable.consultationId, consultationId));
      expect(rows).toHaveLength(1);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4. The missed-check-in sweep, against real active assignments.          */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the missed-check-in sweep', () => {
    it('raises exactly one missed_checkin alert for a genuinely missed day, and never re-raises it', async () => {
      const sweepCode = code('sweep');
      const pathway = await pathways.adminCreateVersion(adminId, { code: sweepCode, name: 'Sweep', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(pathway.id);
      const consultationId = await makeConsultation();
      const startsOn = '2026-02-01';
      await followup.assignPathway({ consultationId, pathwayCode: sweepCode, startsOn: new Date('2026-02-01T00:00:00.000Z') });

      const today = addDaysToIsoDate(startsOn, 2); // yesterday (startsOn + 1) has no check-in.
      const first = await sweep.sweep(today);
      expect(first.missedCheckinAlertsRaised).toBeGreaterThanOrEqual(1);

      const openAlerts = await db
        .select()
        .from(safetyAlertsTable)
        .where(and(eq(safetyAlertsTable.consultationId, consultationId), eq(safetyAlertsTable.alertType, 'missed_checkin')));
      expect(openAlerts).toHaveLength(1);
      expect(openAlerts[0]?.reason).toBe(missedCheckinReason(addDaysToIsoDate(startsOn, 1)));

      // Running the sweep again for the same "today" must not raise a second alert for the same day.
      const second = await sweep.sweep(today);
      const openAlertsAfter = await db
        .select()
        .from(safetyAlertsTable)
        .where(and(eq(safetyAlertsTable.consultationId, consultationId), eq(safetyAlertsTable.alertType, 'missed_checkin')));
      expect(openAlertsAfter).toHaveLength(1);
      void second;
    });

    it('does not raise a missed-check-in alert for a day that was actually submitted', async () => {
      const sweepCode = code('sweep-ok');
      const pathway = await pathways.adminCreateVersion(adminId, { code: sweepCode, name: 'Sweep OK', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(pathway.id);
      const consultationId = await makeConsultation();
      const startsOn = '2026-02-01';
      await followup.assignPathway({ consultationId, pathwayCode: sweepCode, startsOn: new Date('2026-02-01T00:00:00.000Z') });
      const dueDate = addDaysToIsoDate(startsOn, 1);
      await followup.submitCheckin({ consultationId, checkinDate: dueDate, answers: { mood: '4' }, actorPatientId: patientId });

      const today = addDaysToIsoDate(startsOn, 2);
      await sweep.sweep(today);

      const openAlerts = await db
        .select()
        .from(safetyAlertsTable)
        .where(and(eq(safetyAlertsTable.consultationId, consultationId), eq(safetyAlertsTable.alertType, 'missed_checkin')));
      expect(openAlerts).toHaveLength(0);
    });

    it('moves an assignment to completed once its window has fully elapsed', async () => {
      const sweepCode = code('sweep-end');
      const pathway = await pathways.adminCreateVersion(adminId, { code: sweepCode, name: 'Sweep End', version: 1, durationDays: 7, questions: QUESTIONS, redFlagRules: RED_FLAG_RULES, publish: true });
      createdPathwayIds.push(pathway.id);
      const consultationId = await makeConsultation();
      const startsOn = '2026-02-01';
      await followup.assignPathway({ consultationId, pathwayCode: sweepCode, startsOn: new Date('2026-02-01T00:00:00.000Z') });

      const windowEnd = addDaysToIsoDate(startsOn, 7);
      await sweep.sweep(windowEnd);

      const assignment = await followup.getAssignment(consultationId);
      expect(assignment?.status).toBe('completed');
    });
  });
});
