/**
 * *** REAL-HTTP ENDPOINT TESTS for the FOLLOWUP module (M-16). ***
 *
 * Every other spec in this module calls a service/repository method
 * directly (mocked, or against real Postgres — `followup.integration.spec
 * .ts`). Nothing before this drove these routes through actual HTTP with the
 * real `JwtAuthGuard`/`AccountTypeGuard`/`PermissionGuard`/`ValidationPipe`
 * in the loop. This file does, using `createConfiguredApp()` +
 * `app.inject()` — the exact mechanism `app.e2e.integration.spec.ts`
 * establishes (that file does not cover this module at all, so there is no
 * overlap to avoid).
 *
 * Tokens are minted directly via `IdentityTokenService` rather than through
 * the real `/api/auth/otp/*` flow — OTP itself is already proven end-to-end
 * elsewhere, and minting directly still exercises the REAL `JwtAuthGuard`
 * (real signature check, real DB-backed `tokenVersion`/status lookup on
 * every request).
 *
 * Fixture isolation: this worktree's Postgres is shared with the other
 * module groups' own endpoint-spec runs. Every unique column is namespaced
 * by a random per-run id, and teardown runs in strict reverse-FK order.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { checkinResponsesTable } from '../../schema/checkin-responses.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { followupAssignmentsTable } from '../../schema/followup-assignments.schema';
import { followupPathwaysTable } from '../../schema/followup-pathways.schema';
import { notificationsTable } from '../../schema/notifications.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { safetyAlertsTable } from '../../schema/safety-alerts.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { FollowupService } from './followup.service';
import { FollowupCheckinSweepService, missedCheckinReason } from './followup-checkin-sweep.service';
import { addDaysToIsoDate } from './followup-ist.util';

jest.setTimeout(60_000);

/** Every response in this application is enveloped — see `response.interceptor.ts`/`http-exception.filter.ts`. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

const runId = randomUUID().slice(0, 8);
const mobileRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
let mobileSeq = 10;
const nextMobile = (): string => `+9178${mobileRun}${String(mobileSeq++).padStart(2, '0')}`;

const GREEN_ANSWERS = {
  overall_wellbeing: '4',
  symptom_change: '4',
  self_harm_thoughts: 'no',
  feeling_unsafe: 'no',
  confusion_agitation: 'no',
  violence_risk: 'no',
};
const RED_ANSWERS = { ...GREEN_ANSWERS, self_harm_thoughts: 'yes' };

describe('FOLLOWUP module — real HTTP, real guards, real database', () => {
  let app: NestFastifyApplication;
  let db: Database;

  let specialtyId: string;
  let patientOwnerId: string;
  let patientOwnerToken: string;
  let patientStrangerId: string;
  let patientStrangerToken: string;
  let doctorId: string;
  let doctorToken: string;

  const consultationIds: string[] = [];
  const adminIds: string[] = [];
  const pathwayIds: string[] = [];
  let consultationSeq = 0;

  async function makeConsultation(patientId: string, overrides: Partial<typeof consultationsTable.$inferInsert> = {}): Promise<string> {
    consultationSeq += 1;
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `FUEP-${runId}-${consultationSeq}`,
        patientId,
        doctorId: null,
        specialtyId,
        mode: 'scheduled',
        status: 'completed',
        durationMinutes: 30,
        ...overrides,
      })
      .returning({ id: consultationsTable.id });
    consultationIds.push(row.id);
    return row.id;
  }

  async function mintToken(accountType: 'patient' | 'doctor' | 'admin', accountId: string): Promise<string> {
    const { accessToken } = await app.get(IdentityTokenService).mintTokenPair(accountType, accountId, 0);
    return accessToken;
  }

  /** Inserts a fresh admin and grants the given permission KEYS (real, already-seeded rows — never invented). */
  async function mintAdmin(permissionKeys: string[] = []): Promise<{ adminId: string; token: string }> {
    const [admin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextMobile(), fullName: `Followup EP Admin ${runId}` })
      .returning({ id: adminsTable.id });
    adminIds.push(admin.id);

    for (const key of permissionKeys) {
      const [perm] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
      if (!perm) throw new Error(`Permission "${key}" is not seeded in this database.`);
      await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: perm.id });
    }

    const token = await mintToken('admin', admin.id);
    return { adminId: admin.id, token };
  }

  /** Directly pins the REAL, already-seeded `general` pathway to a consultation — setup only, not the thing under test (that is the HTTP check-in submission). */
  async function assignGeneralPathway(consultationId: string, startsOn?: Date) {
    return app.get(FollowupService).assignPathway({ consultationId, pathwayCode: 'general', startsOn });
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    const [specialty] = await db
      .insert(specialtiesTable)
      .values({ code: `fu_ep_${runId}`, name: `Followup EP Specialty ${runId}`, isActive: true })
      .returning({ id: specialtiesTable.id });
    specialtyId = specialty.id;

    const [owner] = await db
      .insert(patientsTable)
      .values({ mobileNumber: nextMobile(), fullName: `Followup EP Owner ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientOwnerId = owner.id;
    patientOwnerToken = await mintToken('patient', patientOwnerId);

    const [stranger] = await db
      .insert(patientsTable)
      .values({ mobileNumber: nextMobile(), fullName: `Followup EP Stranger ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientStrangerId = stranger.id;
    patientStrangerToken = await mintToken('patient', patientStrangerId);

    const [doctor] = await db
      .insert(doctorsTable)
      .values({ mobileNumber: nextMobile(), fullName: `Followup EP Doctor ${runId}` })
      .returning({ id: doctorsTable.id });
    doctorId = doctor.id;
    doctorToken = await mintToken('doctor', doctorId);

    // *** REQUIRED BY consultations_doctor_specialty_fk. *** Any consultation
    // fixture that sets BOTH doctorId and specialtyId (several tests below
    // pass `{ doctorId }`, defaulting specialtyId to the fixture specialty)
    // needs this pairing to actually exist in doctor_specialties, or Postgres
    // rejects the insert outright — found by running this file for real.
    await db.insert(doctorSpecialtiesTable).values({ doctorId, specialtyId });
  });

  afterAll(async () => {
    if (!db) return;

    // *** `notifications` HAS A REAL FK ONTO `consultations` TOO. *** Raising
    // a red-flag alert (and other real code paths this suite exercises over
    // HTTP) writes a `notifications` row carrying `consultation_id` — found
    // by querying `pg_constraint` against the real database after this
    // teardown's `consultations` delete failed with no informative cause
    // printed, then confirming by count that `notifications` (not a stale
    // `safety_alerts`/`checkin_responses`/`followup_assignments` row — those
    // were already empty) was the actual blocker. This is deterministic, not
    // a timing race: every attempt failed identically, which is what
    // separates it from the FollowupClinicalListener race the clinical
    // module's own endpoint spec found (a genuine fire-and-forget listener
    // race, correctly fixed there with a retry). Delete it before
    // `consultations`, same as `app.e2e.integration.spec.ts`'s own teardown
    // already does for its own fixtures.
    await db.delete(notificationsTable).where(inArray(notificationsTable.consultationId, consultationIds));
    await db.delete(safetyAlertsTable).where(inArray(safetyAlertsTable.consultationId, consultationIds));
    await db.delete(checkinResponsesTable).where(inArray(checkinResponsesTable.consultationId, consultationIds));
    await db.delete(followupAssignmentsTable).where(inArray(followupAssignmentsTable.consultationId, consultationIds));
    await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));

    if (pathwayIds.length > 0) await db.delete(followupPathwaysTable).where(inArray(followupPathwaysTable.id, pathwayIds));
    await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
    await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
    await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, doctorId));
    await db.delete(doctorsTable).where(eq(doctorsTable.id, doctorId));
    await db.delete(patientsTable).where(inArray(patientsTable.id, [patientOwnerId, patientStrangerId]));
    await db.delete(specialtiesTable).where(eq(specialtiesTable.id, specialtyId));
    if (adminIds.length > 0) {
      await db.delete(auditLogTable).where(and(eq(auditLogTable.actorType, 'admin'), inArray(auditLogTable.actorId, adminIds)));
    }
    await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
    if (app) await app.close();
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Auth boundary — representative routes                                 */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('auth boundary', () => {
    it('401s every patient route with no token', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const routes = [
        { method: 'POST' as const, url: `/api/consultations/${consultationId}/checkins`, payload: { answers: GREEN_ANSWERS } },
        { method: 'GET' as const, url: `/api/consultations/${consultationId}/checkins` },
        { method: 'GET' as const, url: `/api/consultations/${consultationId}/followup-assignment` },
        { method: 'GET' as const, url: `/api/consultations/${consultationId}/followup-booking-recommendation` },
        { method: 'GET' as const, url: `/api/consultations/${consultationId}/care-plan` },
      ];
      for (const route of routes) {
        const response = await app.inject(route);
        expect(response.statusCode).toBe(401);
      }
    });

    it('403s a DOCTOR hitting a patient-only followup route (WRONG_ACCOUNT_TYPE)', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/followup-assignment`,
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.statusCode).toBe(403);
      // Real value per `auth.constants.ts#AUTH_ERROR_CODES.WRONG_ACCOUNT_TYPE`
      // — no "AUTH_" prefix. Found by running this file for real.
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('403s a PATIENT hitting an admin-only route (WRONG_ACCOUNT_TYPE), independent of any permission grant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/safety-alerts',
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('403s an admin with NO grants on every permission-gated admin route', async () => {
      const { token } = await mintAdmin([]);
      const routes = [
        { method: 'GET' as const, url: '/api/admin/safety-alerts' },
        { method: 'GET' as const, url: '/api/admin/followup-pathways' },
      ];
      for (const route of routes) {
        const response = await app.inject({ ...route, headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(403);
      }
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Ownership-before-assignment-state regression — the fix this session   */
  /* made to `submitCheckin`, proved over real HTTP.                       */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('REGRESSION: ownership is checked before assignment state (submitCheckin)', () => {
    it('a stranger consultation with NO assignment and one WITH an assignment answer with the IDENTICAL 404', async () => {
      const consultationNoAssignment = await makeConsultation(patientStrangerId);
      const consultationWithAssignment = await makeConsultation(patientStrangerId);
      // Deliberately NOT 'active' — a non-submittable internal state, so a
      // caller that could see past ownership would get a DIFFERENT outcome
      // (403 CHECKIN_OUTSIDE_WINDOW) than the no-assignment case, which is
      // exactly the oracle `followup.service.ts#submitCheckin`'s own header
      // describes and the ordering fix closes.
      const pathway = await assignGeneralPathway(consultationWithAssignment);
      await db.update(followupAssignmentsTable).set({ status: 'completed' }).where(eq(followupAssignmentsTable.id, pathway.id));

      const asStranger = (consultationId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/consultations/${consultationId}/checkins`,
          headers: { authorization: `Bearer ${patientOwnerToken}` },
          payload: { answers: GREEN_ANSWERS },
        });

      const responseNoAssignment = await asStranger(consultationNoAssignment);
      const responseWithAssignment = await asStranger(consultationWithAssignment);

      expect(responseNoAssignment.statusCode).toBe(404);
      expect(responseWithAssignment.statusCode).toBe(404);
      const codeNoAssignment = payload<{ code: string }>(responseNoAssignment).code;
      const codeWithAssignment = payload<{ code: string }>(responseWithAssignment).code;
      expect(codeNoAssignment).toBe('FOLLOWUP_CONSULTATION_NOT_FOUND');
      expect(codeWithAssignment).toBe('FOLLOWUP_CONSULTATION_NOT_FOUND');
      expect(codeWithAssignment).toBe(codeNoAssignment);

      // And the SAME 404, same code, for a truly nonexistent id — the
      // existence leak this convention exists to close.
      const responseNonexistent = await asStranger(randomUUID());
      expect(responseNonexistent.statusCode).toBe(404);
      expect(payload<{ code: string }>(responseNonexistent).code).toBe('FOLLOWUP_CONSULTATION_NOT_FOUND');
    });

    it('the same identical-404 parity holds for GET followup-assignment, GET checkins and GET followup-booking-recommendation', async () => {
      const consultationWithAssignment = await makeConsultation(patientStrangerId);
      await assignGeneralPathway(consultationWithAssignment);

      for (const url of [
        `/api/consultations/${consultationWithAssignment}/followup-assignment`,
        `/api/consultations/${consultationWithAssignment}/checkins`,
        `/api/consultations/${consultationWithAssignment}/followup-booking-recommendation`,
        `/api/consultations/${consultationWithAssignment}/care-plan`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${patientOwnerToken}` } });
        expect(response.statusCode).toBe(404);
        expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_CONSULTATION_NOT_FOUND');
      }
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Check-in submission, against the REAL seeded `general` pathway.       */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('POST /consultations/:id/checkins — against the real seeded `general` pathway', () => {
    it('validation: answers must be an object, not a string or array (400 from the real ValidationPipe)', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { answers: 'not-an-object' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('REAL END-TO-END: a green submission against the real `general` pathway scores green and raises no alert', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      expect(assignment.pathwayCode).toBe('general');

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: GREEN_ANSWERS },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ response: { status: string }; alertRaised: unknown }>(response);
      expect(body.response.status).toBe('green');
      expect(body.alertRaised).toBeNull();

      // Fresh SQL, not the service's own return value.
      const rows = await db.select().from(checkinResponsesTable).where(eq(checkinResponsesTable.consultationId, consultationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('green');
    });

    it('REAL END-TO-END: a red-flag submission (self_harm_thoughts=yes) raises a red_flag safety_alerts row and returns it inline', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: RED_ANSWERS },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ response: { status: string }; alertRaised: { id: string; alertType: string } | null }>(response);
      expect(body.response.status).toBe('red');
      expect(body.alertRaised).not.toBeNull();
      expect(body.alertRaised?.alertType).toBe('red_flag');

      const alerts = await db.select().from(safetyAlertsTable).where(eq(safetyAlertsTable.consultationId, consultationId));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.alertType).toBe('red_flag');
      expect(alerts[0]?.reason).toContain('harming');
    });

    it('a same-day resubmission is refused 409 FOLLOWUP_CHECKIN_ALREADY_SUBMITTED', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      const submit = () =>
        app.inject({
          method: 'POST',
          url: `/api/consultations/${consultationId}/checkins`,
          headers: { authorization: `Bearer ${patientOwnerToken}` },
          payload: { checkinDate: assignment.startsOn, answers: GREEN_ANSWERS },
        });

      expect((await submit()).statusCode).toBe(201);
      const second = await submit();
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe('FOLLOWUP_CHECKIN_ALREADY_SUBMITTED');
    });

    it('a date outside the assignment window is refused 403 FOLLOWUP_CHECKIN_OUTSIDE_WINDOW', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      const beforeWindow = addDaysToIsoDate(assignment.startsOn, -1);

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: beforeWindow, answers: GREEN_ANSWERS },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_CHECKIN_OUTSIDE_WINDOW');
    });

    it('an inactive (completed) assignment refuses a check-in with 403 FOLLOWUP_CHECKIN_OUTSIDE_WINDOW, not a 500 or a silent accept', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      await db.update(followupAssignmentsTable).set({ status: 'completed' }).where(eq(followupAssignmentsTable.id, assignment.id));

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: GREEN_ANSWERS },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_CHECKIN_OUTSIDE_WINDOW');
    });

    it('no assignment yet -> 404 FOLLOWUP_ASSIGNMENT_NOT_FOUND for the OWNER (distinct from the stranger 404, which never reaches this branch)', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { answers: GREEN_ANSWERS },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_ASSIGNMENT_NOT_FOUND');
    });

    it('a required question left unanswered is refused 400 FOLLOWUP_INVALID_ANSWERS', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      const { self_harm_thoughts: _omit, ...incomplete } = GREEN_ANSWERS;
      void _omit;

      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: incomplete },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_INVALID_ANSWERS');
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* GET routes — assignment / checkins / booking recommendation / plan.   */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('GET :id/followup-assignment — null, not 404, when nothing is assigned yet', () => {
    it('200 with a null body for an owned consultation with no assignment', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/followup-assignment`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown>(response)).toBeNull();
    });

    it('200 with the real assignment view once one exists', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/followup-assignment`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ pathwayCode: string; status: string; id: string }>(response);
      expect(body.pathwayCode).toBe('general');
      expect(body.status).toBe('active');
      expect(body.id).toBe(assignment.id);
    });
  });

  describe('GET :id/followup-booking-recommendation', () => {
    it('sameDoctor is true by default and false when ?urgent=true, always recommending the treating doctor', async () => {
      const consultationId = await makeConsultation(patientOwnerId, { doctorId });

      const normal = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/followup-booking-recommendation`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(normal.statusCode).toBe(200);
      const normalBody = payload<{ sameDoctor: boolean; recommendedDoctorId: string; urgent: boolean }>(normal);
      expect(normalBody.sameDoctor).toBe(true);
      expect(normalBody.urgent).toBe(false);
      expect(normalBody.recommendedDoctorId).toBe(doctorId);

      const urgent = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/followup-booking-recommendation?urgent=true`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(urgent.statusCode).toBe(200);
      const urgentBody = payload<{ sameDoctor: boolean; urgent: boolean }>(urgent);
      expect(urgentBody.sameDoctor).toBe(false);
      expect(urgentBody.urgent).toBe(true);
    });
  });

  describe('GET :id/care-plan — composed live, stores nothing of its own', () => {
    it('200 with a null prescription, empty checkins, null followUp for a fresh consultation', async () => {
      const consultationId = await makeConsultation(patientOwnerId, { doctorId });
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/care-plan`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ prescription: unknown; checkins: unknown[]; followUp: unknown; recommendedSelfHelp: unknown[] }>(response);
      expect(body.prescription).toBeNull();
      expect(body.checkins).toEqual([]);
      expect(body.followUp).toBeNull();
      // `CARE_HUB_PORT` is bound to `UnavailableCareHubProvider` in this module today.
      expect(body.recommendedSelfHelp).toEqual([]);
    });

    it('200 with the real assignment and check-in once they exist', async () => {
      const consultationId = await makeConsultation(patientOwnerId, { doctorId });
      const assignment = await assignGeneralPathway(consultationId);
      await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: GREEN_ANSWERS },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${consultationId}/care-plan`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ checkins: unknown[]; followUp: { pathwayCode: string } | null; recommendedFollowUpBooking: unknown }>(response);
      expect(body.checkins).toHaveLength(1);
      expect(body.followUp?.pathwayCode).toBe('general');
      expect(body.recommendedFollowUpBooking).not.toBeNull();
    });
  });

  describe('GET :id/checkins — malformed id', () => {
    it('400 VALIDATION_FAILED for a non-UUID path param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/consultations/not-a-uuid/checkins',
        headers: { authorization: `Bearer ${patientOwnerToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Admin — safety alerts (FR-13.4/FR-18.5)                                */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('admin/safety-alerts — governance.read_queues / governance.act_alerts', () => {
    it('GET list: 403 with only an unrelated permission, 200 with governance.read_queues', async () => {
      const { token: wrongPermToken } = await mintAdmin(['content.manage_followup_questions']);
      const wrong = await app.inject({ method: 'GET', url: '/api/admin/safety-alerts', headers: { authorization: `Bearer ${wrongPermToken}` } });
      expect(wrong.statusCode).toBe(403);

      const { token } = await mintAdmin(['governance.read_queues']);
      const ok = await app.inject({ method: 'GET', url: '/api/admin/safety-alerts', headers: { authorization: `Bearer ${token}` } });
      expect(ok.statusCode).toBe(200);
      expect(Array.isArray(payload<unknown[]>(ok))).toBe(true);
    });

    it('GET list: query validation — limit above the max page size is refused 400', async () => {
      const { token } = await mintAdmin(['governance.read_queues']);
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/safety-alerts?limit=1000',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
    });

    it('a red-flag alert raised by a real check-in appears in the admin queue and in the per-consultation list', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: RED_ANSWERS },
      });

      const { token } = await mintAdmin(['governance.read_queues']);
      const queue = await app.inject({ method: 'GET', url: '/api/admin/safety-alerts?limit=100', headers: { authorization: `Bearer ${token}` } });
      expect(queue.statusCode).toBe(200);
      const queued = payload<Array<{ consultationId: string }>>(queue);
      expect(queued.some((row) => row.consultationId === consultationId)).toBe(true);

      const perConsultation = await app.inject({
        method: 'GET',
        url: `/api/admin/safety-alerts/consultation/${consultationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(perConsultation.statusCode).toBe(200);
      const alerts = payload<Array<{ alertType: string }>>(perConsultation);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.alertType).toBe('red_flag');
    });

    it('acknowledge/close: 403 without governance.act_alerts, 404 for an unknown id, 200 success, then 409 on a second close', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const assignment = await assignGeneralPathway(consultationId);
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/consultations/${consultationId}/checkins`,
        headers: { authorization: `Bearer ${patientOwnerToken}` },
        payload: { checkinDate: assignment.startsOn, answers: RED_ANSWERS },
      });
      const alertId = payload<{ alertRaised: { id: string } }>(submitted).alertRaised!.id;

      const { token: readOnlyToken } = await mintAdmin(['governance.read_queues']);
      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/admin/safety-alerts/${alertId}/acknowledge`,
        headers: { authorization: `Bearer ${readOnlyToken}` },
      });
      expect(forbidden.statusCode).toBe(403);

      const { token } = await mintAdmin(['governance.act_alerts']);
      const notFound = await app.inject({
        method: 'POST',
        url: `/api/admin/safety-alerts/${randomUUID()}/acknowledge`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('FOLLOWUP_ALERT_NOT_FOUND');

      const acknowledged = await app.inject({
        method: 'POST',
        url: `/api/admin/safety-alerts/${alertId}/acknowledge`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(acknowledged.statusCode).toBe(200);
      expect(payload<{ acknowledgedAt: string | null }>(acknowledged).acknowledgedAt).not.toBeNull();

      const closed = await app.inject({
        method: 'POST',
        url: `/api/admin/safety-alerts/${alertId}/close`,
        headers: { authorization: `Bearer ${token}` },
        payload: { closingNote: 'Reviewed, patient contacted.' },
      });
      expect(closed.statusCode).toBe(200);
      expect(payload<{ closedAt: string | null; closingNote: string | null }>(closed).closingNote).toBe('Reviewed, patient contacted.');

      const closedAgain = await app.inject({
        method: 'POST',
        url: `/api/admin/safety-alerts/${alertId}/close`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(closedAgain.statusCode).toBe(409);
      expect(payload<{ code: string }>(closedAgain).code).toBe('FOLLOWUP_ALERT_ALREADY_CLOSED');
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Missed check-in sweep — no HTTP trigger route exists; the sweep is    */
  /* invoked directly (real service, real DB) and its OUTPUT is proved     */
  /* reachable through the real admin HTTP queue.                         */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('missed-check-in sweep surfaces through the real admin queue', () => {
    it('a genuinely missed day raises a missed_checkin alert visible over GET /admin/safety-alerts', async () => {
      const consultationId = await makeConsultation(patientOwnerId);
      const startsOn = '2026-02-01';
      await assignGeneralPathway(consultationId, new Date('2026-02-01T00:00:00.000Z'));

      const today = addDaysToIsoDate(startsOn, 2); // yesterday (startsOn + 1) has no check-in.
      const result = await app.get(FollowupCheckinSweepService).sweep(today);
      expect(result.missedCheckinAlertsRaised).toBeGreaterThanOrEqual(1);

      const { token } = await mintAdmin(['governance.read_queues']);
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/safety-alerts/consultation/${consultationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const alerts = payload<Array<{ alertType: string; reason: string }>>(response);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.alertType).toBe('missed_checkin');
      expect(alerts[0]?.reason).toBe(missedCheckinReason(addDaysToIsoDate(startsOn, 1)));
    });
  });

  /* ════════════════════════════════════════════════════════════════════ */
  /* Admin — pathway CRUD/publish workflow (FR-13.7)                       */
  /* ════════════════════════════════════════════════════════════════════ */

  describe('admin/followup-pathways — content.manage_followup_questions', () => {
    it('GET list: 403 without the permission, 200 with it, includes the real seeded pathways', async () => {
      const { token: wrongToken } = await mintAdmin(['governance.read_queues']);
      const forbidden = await app.inject({ method: 'GET', url: '/api/admin/followup-pathways', headers: { authorization: `Bearer ${wrongToken}` } });
      expect(forbidden.statusCode).toBe(403);

      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({ method: 'GET', url: '/api/admin/followup-pathways', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ code: string }>>(response);
      expect(rows.map((r) => r.code)).toEqual(
        expect.arrayContaining(['general', 'depression_anxiety', 'sleep', 'substance_use', 'bipolar_psychosis']),
      );
    });

    it('GET :id — 404 for an unknown id', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/followup-pathways/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_PATHWAY_NOT_FOUND');
    });

    it('GET by-code/:code/versions — the real `general` pathway has at least one version', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/followup-pathways/by-code/general/versions',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const versions = payload<Array<{ code: string; version: number }>>(response);
      expect(versions.length).toBeGreaterThanOrEqual(1);
      expect(versions.every((v) => v.code === 'general')).toBe(true);
    });

    const validQuestions = [{ id: 'mood', text: 'Mood?', type: 'scale_1_5', required: true }];
    const validRules = [{ id: 'r1', questionId: 'mood', matchValues: ['1'], severity: 'red', reason: 'Very low mood reported.' }];

    it('POST create: DTO validation — durationDays above 90 is refused 400 by the real ValidationPipe', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/followup-pathways',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          code: `fu_ep_dto_${runId}`,
          name: 'Bad duration',
          version: 1,
          durationDays: 91,
          questions: validQuestions,
          redFlagRules: validRules,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST create: a red-flag rule referencing an unknown question is refused 400 FOLLOWUP_INVALID_RED_FLAG_RULES', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/followup-pathways',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          code: `fu_ep_badrule_${runId}`,
          name: 'Bad rule',
          version: 1,
          durationDays: 7,
          questions: validQuestions,
          redFlagRules: [{ id: 'r1', questionId: 'does_not_exist', matchValues: ['1'], severity: 'red', reason: 'x' }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_INVALID_RED_FLAG_RULES');
    });

    it('POST create then re-POST the same (code, version) is refused 409 FOLLOWUP_PATHWAY_VERSION_TAKEN', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const code = `fu_ep_dup_${runId}`;
      const body = { code, name: 'V1', version: 1, durationDays: 7, questions: validQuestions, redFlagRules: validRules, publish: false };

      const first = await app.inject({ method: 'POST', url: '/api/admin/followup-pathways', headers: { authorization: `Bearer ${token}` }, payload: body });
      expect(first.statusCode).toBe(201);
      pathwayIds.push(payload<{ id: string }>(first).id);

      const second = await app.inject({ method: 'POST', url: '/api/admin/followup-pathways', headers: { authorization: `Bearer ${token}` }, payload: body });
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe('FOLLOWUP_PATHWAY_VERSION_TAKEN');
    });

    it('POST create with publish:true makes it current; POST :id/publish on a new version demotes it', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const code = `fu_ep_pub_${runId}`;

      const v1 = await app.inject({
        method: 'POST',
        url: '/api/admin/followup-pathways',
        headers: { authorization: `Bearer ${token}` },
        payload: { code, name: 'V1', version: 1, durationDays: 7, questions: validQuestions, redFlagRules: validRules, publish: true },
      });
      expect(v1.statusCode).toBe(201);
      const v1Body = payload<{ id: string; isCurrent: boolean }>(v1);
      pathwayIds.push(v1Body.id);
      expect(v1Body.isCurrent).toBe(true);

      const v2 = await app.inject({
        method: 'POST',
        url: '/api/admin/followup-pathways',
        headers: { authorization: `Bearer ${token}` },
        payload: { code, name: 'V2', version: 2, durationDays: 7, questions: validQuestions, redFlagRules: validRules, publish: false },
      });
      expect(v2.statusCode).toBe(201);
      const v2Body = payload<{ id: string; isCurrent: boolean }>(v2);
      pathwayIds.push(v2Body.id);
      expect(v2Body.isCurrent).toBe(false);

      const publish = await app.inject({
        method: 'POST',
        url: `/api/admin/followup-pathways/${v2Body.id}/publish`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(publish.statusCode).toBe(200);
      expect(payload<{ isCurrent: boolean }>(publish).isCurrent).toBe(true);

      const [v1Row] = await db.select({ isCurrent: followupPathwaysTable.isCurrent }).from(followupPathwaysTable).where(eq(followupPathwaysTable.id, v1Body.id));
      expect(v1Row?.isCurrent).toBe(false);
    });

    it('POST :id/publish — 404 for an unknown id', async () => {
      const { token } = await mintAdmin(['content.manage_followup_questions']);
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/followup-pathways/${randomUUID()}/publish`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('FOLLOWUP_PATHWAY_NOT_FOUND');
    });
  });
});
