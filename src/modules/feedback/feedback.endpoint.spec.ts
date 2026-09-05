/**
 * *** FEEDBACK AND COMPLAINTS OVER REAL HTTP. ***
 *
 * Drives every route in `feedback.controller.ts` (patient feedback),
 * `complaint.controller.ts` (patient complaints), `feedback-admin
 * .controller.ts` and `complaint-admin.controller.ts` (the FR-18.8 admin
 * surface) through `createConfiguredApp()` + `app.inject()` — the same
 * mechanism `app.e2e.integration.spec.ts` established.
 *
 * *** WHY TOKENS ARE MINTED DIRECTLY. *** See `governance.endpoint.spec.ts`'s
 * identical note — `IdentityTokenService.mintTokenPair` produces a real,
 * signed JWT verified through the exact same `resolveAccessToken` path
 * `JwtAuthGuard` calls.
 *
 * ── THE THREE THINGS THIS FILE EXISTS TO PROVE OVER REAL HTTP ──────────────
 *
 * 1. ONE FEEDBACK SUBMISSION PER CONSULTATION, ENFORCED AS A CLEAN 409, NOT
 *    A 500. `feedback.schema.ts`'s `UNIQUE(consultation_id)` is a real
 *    Postgres constraint — this file submits the SAME consultation's
 *    feedback TWICE over two separate real HTTP calls and asserts the
 *    second one gets `ALREADY_SUBMITTED` (409), never an unhandled `23505`
 *    surfacing as a 500.
 *
 * 2. THE COMPLAINT STATE MACHINE, `open -> in_progress -> resolved |
 *    rejected`, driven end to end over real HTTP with the row-locked guard
 *    at each edge (assign is one-shot from `open` only; resolve/reject are
 *    only legal from `in_progress`).
 *
 * 3. `isInternal` MESSAGE FILTERING. An admin posts an internal-only note
 *    on a complaint thread; the SAME complaint, read back through the
 *    PATIENT's own `GET /complaints/:id`, must never contain it — proved by
 *    both a structural check (the message is simply absent from the
 *    `messages` array) and a raw-text search of the response body for the
 *    internal note's exact wording.
 *
 * Requires a reachable Postgres — reads `.env`/`.env.local` exactly as
 * `app.e2e.integration.spec.ts` does, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { complaintsTable } from '../../schema/complaints.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { feedbackTable } from '../../schema/feedback.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  doctorId: string;
  patient1Id: string; // owns consultation1 (feedback) and complaint1
  patient2Id: string; // a stranger for ownership checks
  consultation1Id: string;
  consultation2Id: string; // belongs to patient2 — used to prove patient1 cannot touch it
  adminFullId: string; // feedback.read + feedback.manage_complaints
  adminReadOnlyId: string; // feedback.read only
  adminNoneId: string;
}

async function grant(db: Database, adminId: string, key: string): Promise<void> {
  const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
  if (!permission) throw new Error(`Permission "${key}" is not seeded — has identity.seed.ts run against this database?`);
  await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permission.id });
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const mobile = (seq: number) => `FDB${runId}${seq}`.slice(0, 16);

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `fdb_${runId}`, name: `Feedback Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: mobile(1), fullName: `Feedback Doctor ${runId}` })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [patient1] = await db
    .insert(patientsTable)
    .values({ mobileNumber: mobile(2), fullName: `Feedback Patient 1 ${runId}` })
    .returning({ id: patientsTable.id });
  const [patient2] = await db
    .insert(patientsTable)
    .values({ mobileNumber: mobile(3), fullName: `Feedback Patient 2 ${runId}` })
    .returning({ id: patientsTable.id });

  const newConsultation = async (patientId: string, seq: number): Promise<string> => {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `FDB${runId}${seq}`.slice(0, 24),
        patientId,
        doctorId: doctor.id,
        specialtyId: specialty.id,
        mode: 'scheduled',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  };

  const consultation1Id = await newConsultation(patient1.id, 1);
  const consultation2Id = await newConsultation(patient2.id, 2);

  const [adminFull] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(4), fullName: `Feedback Admin (full) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminReadOnly] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(5), fullName: `Feedback Admin (read only) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: mobile(6), fullName: `Feedback Admin (none) ${runId}` })
    .returning({ id: adminsTable.id });

  await grant(db, adminFull.id, PERMISSIONS.FEEDBACK_READ);
  await grant(db, adminFull.id, PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS);
  await grant(db, adminReadOnly.id, PERMISSIONS.FEEDBACK_READ);

  return {
    runId,
    specialtyId: specialty.id,
    doctorId: doctor.id,
    patient1Id: patient1.id,
    patient2Id: patient2.id,
    consultation1Id,
    consultation2Id,
    adminFullId: adminFull.id,
    adminReadOnlyId: adminReadOnly.id,
    adminNoneId: adminNone.id,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.patient1Id, fixtures.patient2Id];
  const consultationIds = [fixtures.consultation1Id, fixtures.consultation2Id];
  const adminIds = [fixtures.adminFullId, fixtures.adminReadOnlyId, fixtures.adminNoneId];

  await db.delete(feedbackTable).where(inArray(feedbackTable.consultationId, consultationIds));
  await db.delete(complaintsTable).where(inArray(complaintsTable.patientId, patientIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

describe('*** FEEDBACK AND COMPLAINTS — every route, real HTTP ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: {
    patient1: string;
    patient2: string;
    doctor: string;
    adminFull: string;
    adminReadOnly: string;
    adminNone: string;
  };

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'admin' | 'doctor' | 'patient', id: string) =>
      (await tokenService.mintTokenPair(accountType, id, 0)).accessToken;

    tokens = {
      patient1: await mint('patient', fixtures.patient1Id),
      patient2: await mint('patient', fixtures.patient2Id),
      doctor: await mint('doctor', fixtures.doctorId),
      adminFull: await mint('admin', fixtures.adminFullId),
      adminReadOnly: await mint('admin', fixtures.adminReadOnlyId),
      adminNone: await mint('admin', fixtures.adminNoneId),
    };
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /* ====================================================================== */
  /* Feedback — POST/GET /consultations/:id/feedback                       */
  /* ====================================================================== */

  describe('POST /api/consultations/:id/feedback', () => {
    it('401s with no token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        payload: { rating: 5 },
      });
      expect(response.statusCode).toBe(401);
    });

    it('403s for a doctor token — this route is patient-only', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.doctor),
        payload: { rating: 5 },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('404s (never 403) when the patient does not own the consultation', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation2Id}/feedback`,
        headers: bearer(tokens.patient1),
        payload: { rating: 5 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('400s on a DTO validation failure (rating out of the 1-5 bound)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.patient1),
        payload: { rating: 6 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('GET returns null before any feedback has been submitted — a normal state, not a 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.patient1),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown>(response)).toBeNull();
    });

    it('201s the first real submission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.patient1),
        payload: { rating: 4, comment: 'Doctor was thorough and on time.' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ rating: number; comment: string | null }>(response);
      expect(body.rating).toBe(4);
      expect(body.comment).toBe('Doctor was thorough and on time.');
    });

    it('GET now returns the submitted feedback, not null', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.patient1),
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ rating: number }>(response).rating).toBe(4);
    });

    /**
     * *** THE CENTREPIECE. *** A second real HTTP submission for the SAME
     * consultation must be a clean 409, never a 500 — `feedback.schema.ts`'s
     * `UNIQUE(consultation_id)` really is hit here, and
     * `feedback.service.ts#submitFeedback`'s `isUniqueConstraintViolation`
     * catch really is what turns it into `ALREADY_SUBMITTED`.
     */
    it('409s (ALREADY_SUBMITTED) a second real submission for the same consultation — a real unique-constraint conflict, not a 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultation1Id}/feedback`,
        headers: bearer(tokens.patient1),
        payload: { rating: 1, comment: 'changed my mind' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('FEEDBACK_ALREADY_SUBMITTED');

      // The original rating survived — a 409 refusal, not a silent overwrite.
      const rows = await db.select().from(feedbackTable).where(eq(feedbackTable.consultationId, fixtures.consultation1Id));
      expect(rows).toHaveLength(1);
      expect(rows[0].rating).toBe(4);
    });
  });

  /* ====================================================================== */
  /* Patient complaints                                                     */
  /* ====================================================================== */

  describe('POST /api/complaints and the patient thread', () => {
    it('401s with no token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        payload: { category: 'other', subject: 'x', description: 'y' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('403s for a doctor token — this route is patient-only', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.doctor),
        payload: { category: 'other', subject: 'x', description: 'y' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('400s on a DTO validation failure (invalid category)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
        payload: { category: 'not_a_real_category', subject: 'x', description: 'y' },
      });
      expect(response.statusCode).toBe(400);
    });

    it("404s (never 403) raising a complaint against another patient's consultationId", async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
        payload: {
          category: 'technical_issue',
          subject: 'Call dropped',
          description: 'The video call dropped twice.',
          consultationId: fixtures.consultation2Id,
        },
      });
      expect(response.statusCode).toBe(404);
    });

    it('201s a complaint with no consultationId at all — a real, valid case per FR-17.2', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
        payload: { category: 'payment_issue', subject: 'Overcharged', description: 'I was billed twice for one consult.' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ status: string; consultationId: string | null }>(response);
      expect(body.status).toBe('open');
      expect(body.consultationId).toBeNull();
    });
  });

  /* ====================================================================== */
  /* The full state machine + isInternal filtering, on ONE complaint         */
  /* ====================================================================== */

  describe('the complaint lifecycle: open -> in_progress -> resolved, and isInternal filtering', () => {
    let complaintId: string;
    const INTERNAL_NOTE = 'Internal triage note: escalate to L2 support, patient has a history of refund requests.';

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
        payload: {
          category: 'consultation_quality',
          subject: 'Doctor seemed rushed',
          description: 'The consult felt shorter than the slot booked.',
          consultationId: fixtures.consultation1Id,
        },
      });
      expect(created.statusCode).toBe(201);
      complaintId = payload<{ id: string }>(created).id;
    });

    it('404s (never 403) when a different patient reads it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/complaints/${complaintId}`,
        headers: bearer(tokens.patient2),
      });
      expect(response.statusCode).toBe(404);
    });

    it('409s (ILLEGAL_TRANSITION) resolving a complaint that is still open — resolve is only legal from in_progress', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/resolve`,
        headers: bearer(tokens.adminFull),
        payload: { resolutionNote: 'too early' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('COMPLAINT_ILLEGAL_TRANSITION');
    });

    it('403s the admin assign route for an admin holding feedback.read but not feedback.manage_complaints', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/assign`,
        headers: bearer(tokens.adminReadOnly),
        payload: { assignedToAdminId: fixtures.adminFullId },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('200s assigning it: open -> in_progress', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { assignedToAdminId: fixtures.adminFullId },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string; assignedToAdminId: string }>(response);
      expect(body.status).toBe('in_progress');
      expect(body.assignedToAdminId).toBe(fixtures.adminFullId);
    });

    it('409s (ILLEGAL_TRANSITION) assigning it again — one-shot from open only', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { assignedToAdminId: fixtures.adminFullId },
      });
      expect(response.statusCode).toBe(409);
    });

    /**
     * *** `isInternal` FILTERING, THE CENTREPIECE. *** An admin posts an
     * internal-only note. The SAME thread, read back through the patient's
     * own view, must never contain it.
     */
    it('an admin posts an internal-only message, and the patient\'s own GET never contains it', async () => {
      const internalMessage = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/messages`,
        headers: bearer(tokens.adminFull),
        payload: { body: INTERNAL_NOTE, isInternal: true },
      });
      expect(internalMessage.statusCode).toBe(200);

      // The admin's OWN view (getForAdmin) DOES see it — it is real, not a no-op.
      const adminView = await app.inject({
        method: 'GET',
        url: `/api/admin/complaints/${complaintId}`,
        headers: bearer(tokens.adminReadOnly),
      });
      expect(adminView.statusCode).toBe(200);
      expect(adminView.payload).toContain(INTERNAL_NOTE);
      const adminMessages = payload<{ messages: Array<{ body: string; isInternal: boolean }> }>(adminView).messages;
      expect(adminMessages.some((m) => m.body === INTERNAL_NOTE && m.isInternal === true)).toBe(true);

      // The PATIENT's own view must never contain it — neither structurally nor as raw text.
      const patientView = await app.inject({
        method: 'GET',
        url: `/api/complaints/${complaintId}`,
        headers: bearer(tokens.patient1),
      });
      expect(patientView.statusCode).toBe(200);
      expect(patientView.payload).not.toContain(INTERNAL_NOTE);
      const patientMessages = payload<{ messages: Array<{ body: string }> }>(patientView).messages;
      expect(patientMessages.some((m) => m.body === INTERNAL_NOTE)).toBe(false);

      // And the patient's own list view (a second, separate read path) is equally clean.
      const patientList = await app.inject({
        method: 'GET',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
      });
      expect(patientList.statusCode).toBe(200);
      expect(patientList.payload).not.toContain(INTERNAL_NOTE);
    });

    it('the patient can still add their own (never internal) message to the same thread', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/complaints/${complaintId}/messages`,
        headers: bearer(tokens.patient1),
        payload: { body: 'Please let me know the outcome.' },
      });
      expect(response.statusCode).toBe(200);
      const messages = payload<{ messages: Array<{ body: string; isInternal: boolean; authorType: string }> }>(response).messages;
      const own = messages.find((m) => m.body === 'Please let me know the outcome.');
      expect(own?.isInternal).toBe(false);
      expect(own?.authorType).toBe('patient');
    });

    it('a different patient cannot post a message on this thread — 404, never 403', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/complaints/${complaintId}/messages`,
        headers: bearer(tokens.patient2),
        payload: { body: 'trying to reach a thread that is not mine' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('409s (ILLEGAL_TRANSITION) rejecting an in_progress complaint via reject after it is resolved is impossible — reject only from in_progress, so resolve first, then reject 409s from resolved', async () => {
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/resolve`,
        headers: bearer(tokens.adminFull),
        payload: { resolutionNote: 'Refund issued and consultation credited.' },
      });
      expect(resolved.statusCode).toBe(200);
      const resolvedBody = payload<{ status: string; resolvedAt: string | null }>(resolved);
      expect(resolvedBody.status).toBe('resolved');
      expect(resolvedBody.resolvedAt).not.toBeNull();

      const rejectAfterResolve = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/reject`,
        headers: bearer(tokens.adminFull),
        payload: { resolutionNote: 'too late' },
      });
      expect(rejectAfterResolve.statusCode).toBe(409);
      expect(payload<{ code: string }>(rejectAfterResolve).code).toBe('COMPLAINT_ILLEGAL_TRANSITION');
    });
  });

  describe('the reject branch — a SEPARATE complaint, in_progress -> rejected', () => {
    let complaintId: string;

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/complaints',
        headers: bearer(tokens.patient1),
        payload: { category: 'other', subject: 'Reject branch fixture', description: 'x' },
      });
      complaintId = payload<{ id: string }>(created).id;
      const assigned = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/assign`,
        headers: bearer(tokens.adminFull),
        payload: { assignedToAdminId: fixtures.adminFullId },
      });
      expect(assigned.statusCode).toBe(200);
    });

    it('200s rejecting an in_progress complaint, and resolvedAt is NEVER set — rejected is not resolved', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/complaints/${complaintId}/reject`,
        headers: bearer(tokens.adminFull),
        payload: { resolutionNote: 'Not a valid complaint — duplicate of another ticket.' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string; resolvedAt: string | null }>(response);
      expect(body.status).toBe('rejected');
      expect(body.resolvedAt).toBeNull();

      const row = await db.select().from(complaintsTable).where(eq(complaintsTable.id, complaintId));
      expect(row[0].resolvedAt).toBeNull();
    });
  });

  /* ====================================================================== */
  /* Admin surfaces — feedback.read / feedback.manage_complaints            */
  /* ====================================================================== */

  describe('GET /api/admin/feedback', () => {
    it('401s with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/feedback' });
      expect(response.statusCode).toBe(401);
    });

    it('403s for an admin missing feedback.read', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/feedback', headers: bearer(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('200s for an admin holding feedback.read, and finds the feedback submitted earlier by rating filter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/feedback?rating=4',
        headers: bearer(tokens.adminReadOnly),
      });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ consultationId: string; rating: number }>>(response);
      expect(rows.some((r) => r.consultationId === fixtures.consultation1Id && r.rating === 4)).toBe(true);
    });

    it('400s on a DTO validation failure (rating out of bound)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/feedback?rating=9',
        headers: bearer(tokens.adminReadOnly),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/admin/complaints', () => {
    it('401s with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/complaints' });
      expect(response.statusCode).toBe(401);
    });

    it('403s for a patient token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/complaints', headers: bearer(tokens.patient1) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('403s for an admin missing feedback.read', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/complaints', headers: bearer(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
    });

    it('200s for an admin holding feedback.read', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/complaints?status=rejected',
        headers: bearer(tokens.adminReadOnly),
      });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(payload<unknown[]>(response))).toBe(true);
    });

    it('404s the detail read for a well-formed but non-existent complaint id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/complaints/${randomUUID()}`,
        headers: bearer(tokens.adminReadOnly),
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
