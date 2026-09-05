/**
 * *** DATA RIGHTS OVER REAL HTTP — THE MOST IMPORTANT FILE IN THIS ROUND. ***
 *
 * `GET /admin/data-deletion-requests/:id/preview` and
 * `POST /admin/data-deletion-requests/:id/execute` are the ONLY place in
 * this entire codebase that actually deletes or anonymizes a patient's data
 * (`data-rights-admin.controller.ts`'s own header). Both routes are driven
 * here through `createConfiguredApp()` + `app.inject()` — the same
 * mechanism `app.e2e.integration.spec.ts` established — precisely because
 * this is the one place where "the service's own tests are green" is not
 * enough evidence: the claim under test is that real Postgres rows survive
 * or do not survive a real HTTP call, and that is verified with fresh SQL,
 * never the HTTP response's own say-so.
 *
 * ── WHAT THIS FILE PROVES, AND HOW ──────────────────────────────────────
 *
 * 1. PREVIEW WRITES NOTHING. A full snapshot of every row `previewExecution`
 *    reports on (the `patients` row, both `search_queries` rows, the
 *    `promotion_code_attempts` row) is taken by raw SQL BEFORE the HTTP
 *    call, `GET preview` is called TWICE, and the identical snapshot is
 *    taken AFTER — asserted byte-identical with `toEqual`, not just "the
 *    counts matched".
 *
 * 2. EXECUTE ON A NON-APPROVED REQUEST IS REFUSED AND TOUCHES NOTHING. A
 *    `requested`-status request is executed against; the response is 409
 *    `DATA_DELETION_NOT_APPROVED`, and the same before/after SQL snapshot
 *    technique proves not one row moved.
 *
 * 3. EXECUTE ON A GENUINELY APPROVED REQUEST ANONYMIZES/DELETES EXACTLY THE
 *    THREE TABLES `data-rights.constants.ts#STATIC_TABLE_SURVEY` marks
 *    `hard_delete`/`anonymize` (`search_queries`, `promotion_code_attempts`,
 *    `patients`) — verified by direct SQL read of each, including the exact
 *    deterministic mobile-number placeholder
 *    (`identity.repository.ts#anonymizedMobilePlaceholder`) — and NOTHING
 *    ELSE: a `feedback` row (a `retain` table) tied to this same patient is
 *    confirmed to survive untouched.
 *
 * 4. THE CONCURRENCY FIX HOLDS OVER REAL HTTP. An earlier adversarial round
 *    found and fixed a real race in `DataDeletionService
 *    #recordExecutionOutcome`'s guarded `UPDATE ... WHERE status =
 *    'approved'` — two concurrent executions of the SAME approved request
 *    could previously both report success. This file fires two concurrent
 *    real `POST .../execute` calls at the SAME approved request via
 *    `Promise.all` and asserts EXACTLY ONE responds 201 (`overallStatus:
 *    'executed'`) and the other responds 409 `DATA_DELETION_NOT_APPROVED` —
 *    never both 201, never a 500.
 *
 * 5. BOTH ROUTES ARE GATED ON `compliance.manage_deletion_requests`,
 *    independently proven with the full auth-boundary matrix.
 *
 * ── FIXTURE ISOLATION — WHY THIS FILE NEVER MATCHES BY MOBILE NUMBER ──────
 *
 * `patient.service.ts#anonymizeForDeletion` REPLACES `mobile_number` with a
 * deterministic placeholder (`DEL` + the id's own hex, stripped of dashes) —
 * so a teardown clause written as `WHERE mobile_number = <original>` would
 * silently stop matching the row the instant this test's own subject under
 * test succeeds. Every fixture below is tracked and torn down BY ID, never
 * by mobile number, precisely because this file expects that mutation to
 * really happen.
 *
 * Requires a reachable Postgres — reads `.env`/`.env.local` exactly as
 * `app.e2e.integration.spec.ts` does, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { dataDeletionRequestsTable } from '../../schema/data-deletion-requests.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { feedbackTable } from '../../schema/feedback.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { promotionCodeAttemptsTable } from '../../schema/promotion-code-attempts.schema';
import { searchQueriesTable } from '../../schema/search-queries.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { anonymizedMobilePlaceholder } from '../identity/identity.repository';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface PatientSubject {
  patientId: string;
  mobileNumber: string;
  searchQueryIds: number[];
  promotionAttemptId: number;
  requestId: string;
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  doctorId: string;
  adminFullId: string;
  adminNoneId: string;
  /** For the wrong-account-type probe. */
  bystanderPatientId: string;
  /** PREVIEW-focused subject — its request is `approved`, but this subject is used ONLY for the no-mutation preview assertions, never executed. */
  previewSubject: PatientSubject;
  /** A `requested` (never approved) request — proves execute refuses it and touches nothing. */
  refusedSubject: PatientSubject;
  /** The main happy-path subject — approved, then genuinely executed once. */
  executeSubject: PatientSubject & { consultationId: string; feedbackId: string };
  /** A SECOND, separate approved subject — reserved for the concurrency race. */
  concurrentSubject: PatientSubject;
}

async function grant(db: Database, adminId: string, key: string): Promise<void> {
  const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
  if (!permission) throw new Error(`Permission "${key}" is not seeded — has identity.seed.ts run against this database?`);
  await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: permission.id });
}

async function seedPatientSubject(
  db: Database,
  runId: string,
  seq: number,
  requestStatus: 'approved' | 'requested',
): Promise<PatientSubject> {
  const mobileNumber = `DRT${runId}${seq}`.slice(0, 16);
  const [patient] = await db
    .insert(patientsTable)
    .values({
      mobileNumber,
      fullName: `Data Rights Subject ${seq} ${runId}`,
      status: 'active',
      dateOfBirth: '1990-01-01',
      pushToken: `push-token-${runId}-${seq}`,
      deviceId: `device-${runId}-${seq}`,
    })
    .returning({ id: patientsTable.id });

  const searchRows = await db
    .insert(searchQueriesTable)
    .values([
      { patientId: patient.id, queryText: `fixture query A ${runId}-${seq}` },
      { patientId: patient.id, queryText: `fixture query B ${runId}-${seq}` },
    ])
    .returning({ id: searchQueriesTable.id });

  const [promotionAttempt] = await db
    .insert(promotionCodeAttemptsTable)
    .values({ patientId: patient.id, ipAddress: '198.51.100.42', outcome: 'refused' })
    .returning({ id: promotionCodeAttemptsTable.id });

  const [request] = await db
    .insert(dataDeletionRequestsTable)
    .values({ patientId: patient.id, status: requestStatus, reason: `fixture ${runId}-${seq}` })
    .returning({ id: dataDeletionRequestsTable.id });

  return {
    patientId: patient.id,
    mobileNumber,
    searchQueryIds: searchRows.map((r) => r.id),
    promotionAttemptId: promotionAttempt.id,
    requestId: request.id,
  };
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `drt_${runId}`, name: `Data Rights Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: `DRT${runId}D`.slice(0, 16), fullName: `Data Rights Doctor ${runId}` })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [bystanderPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: `DRT${runId}B`.slice(0, 16), fullName: `Data Rights Bystander ${runId}` })
    .returning({ id: patientsTable.id });

  const [adminFull] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `DRT${runId}F`.slice(0, 16), fullName: `Data Rights Admin (full) ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: `DRT${runId}N`.slice(0, 16), fullName: `Data Rights Admin (none) ${runId}` })
    .returning({ id: adminsTable.id });
  await grant(db, adminFull.id, PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS);

  const previewSubject = await seedPatientSubject(db, runId, 1, 'approved');
  const refusedSubject = await seedPatientSubject(db, runId, 2, 'requested');
  const executeSubjectBase = await seedPatientSubject(db, runId, 3, 'approved');
  const concurrentSubject = await seedPatientSubject(db, runId, 4, 'approved');

  // The execute subject ALSO gets one real consultation + one feedback row —
  // `feedback` is a `retain` table in `STATIC_TABLE_SURVEY`, so this is what
  // proves execution touches ONLY the three mutating tables, nothing else.
  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `DRT${runId}EX`.slice(0, 24),
      patientId: executeSubjectBase.patientId,
      doctorId: doctor.id,
      specialtyId: specialty.id,
      mode: 'scheduled',
      durationMinutes: 30,
    })
    .returning({ id: consultationsTable.id });
  const [feedback] = await db
    .insert(feedbackTable)
    .values({ consultationId: consultation.id, patientId: executeSubjectBase.patientId, rating: 5, comment: 'must survive execution' })
    .returning({ id: feedbackTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    doctorId: doctor.id,
    adminFullId: adminFull.id,
    adminNoneId: adminNone.id,
    bystanderPatientId: bystanderPatient.id,
    previewSubject,
    refusedSubject,
    executeSubject: { ...executeSubjectBase, consultationId: consultation.id, feedbackId: feedback.id },
    concurrentSubject,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const allPatientIds = [
    fixtures.bystanderPatientId,
    fixtures.previewSubject.patientId,
    fixtures.refusedSubject.patientId,
    fixtures.executeSubject.patientId,
    fixtures.concurrentSubject.patientId,
  ];
  const allRequestIds = [
    fixtures.previewSubject.requestId,
    fixtures.refusedSubject.requestId,
    fixtures.executeSubject.requestId,
    fixtures.concurrentSubject.requestId,
  ];

  // Every table this test could have mutated OR left alone — always matched by ID, never by mobile number (see file header).
  await db.delete(feedbackTable).where(eq(feedbackTable.id, fixtures.executeSubject.feedbackId));
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.executeSubject.consultationId));
  await db.delete(dataDeletionRequestsTable).where(inArray(dataDeletionRequestsTable.id, allRequestIds));
  // search_queries: delete by id where still present (execute's own hard-delete may already have removed some).
  const allSearchQueryIds = [
    ...fixtures.previewSubject.searchQueryIds,
    ...fixtures.refusedSubject.searchQueryIds,
    ...fixtures.executeSubject.searchQueryIds,
    ...fixtures.concurrentSubject.searchQueryIds,
  ];
  await db.delete(searchQueriesTable).where(inArray(searchQueriesTable.id, allSearchQueryIds));
  // promotion_code_attempts: delete by id, NOT by patientId — an anonymized row's patient_id is already null.
  await db.delete(promotionCodeAttemptsTable).where(
    inArray(promotionCodeAttemptsTable.id, [
      fixtures.previewSubject.promotionAttemptId,
      fixtures.refusedSubject.promotionAttemptId,
      fixtures.executeSubject.promotionAttemptId,
      fixtures.concurrentSubject.promotionAttemptId,
    ]),
  );
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(adminsTable).where(inArray(adminsTable.id, [fixtures.adminFullId, fixtures.adminNoneId]));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  // Patients: matched by id ALWAYS — the execute/concurrent subjects' mobile_number is no longer their fixture value.
  await db.delete(patientsTable).where(inArray(patientsTable.id, allPatientIds));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/** A raw, order-independent snapshot of every row this module could touch for one subject — used for the before/after "wrote nothing" proofs. */
async function snapshot(db: Database, subject: PatientSubject) {
  const patient = await db.execute(sql`select * from patients where id = ${subject.patientId}`);
  const searchQueries = await db.execute(
    sql`select * from search_queries where id = any(${sql.raw(`array[${subject.searchQueryIds.join(',')}]::bigint[]`)}) order by id`,
  );
  const promotionAttempt = await db.execute(sql`select * from promotion_code_attempts where id = ${subject.promotionAttemptId}`);
  const request = await db.execute(sql`select * from data_deletion_requests where id = ${subject.requestId}`);
  return {
    patient: patient.rows[0],
    searchQueries: searchQueries.rows,
    promotionAttempt: promotionAttempt.rows[0],
    request: request.rows[0],
  };
}

describe('*** DATA RIGHTS — preview and execute, every route, real HTTP ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokens: { adminFull: string; adminNone: string; patient: string };

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    const mint = async (accountType: 'admin' | 'patient', id: string) => (await tokenService.mintTokenPair(accountType, id, 0)).accessToken;
    tokens = {
      adminFull: await mint('admin', fixtures.adminFullId),
      adminNone: await mint('admin', fixtures.adminNoneId),
      patient: await mint('patient', fixtures.bystanderPatientId),
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
  /* Auth boundary — both routes, gated on compliance.manage_deletion_requests */
  /* ====================================================================== */

  describe('auth boundary — both routes', () => {
    it('GET preview: 401 / 403 (wrong account type) / 403 (missing permission)', async () => {
      const noToken = await app.inject({ method: 'GET', url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview` });
      expect(noToken.statusCode).toBe(401);

      const wrongType = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview`,
        headers: bearer(tokens.patient),
      });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');

      const noPermission = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview`,
        headers: bearer(tokens.adminNone),
      });
      expect(noPermission.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPermission).code).toBe('PERMISSION_DENIED');
    });

    it('POST execute: 401 / 403 (wrong account type) / 403 (missing permission) — and touches nothing', async () => {
      const before = await snapshot(db, fixtures.previewSubject);

      const noToken = await app.inject({ method: 'POST', url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/execute` });
      expect(noToken.statusCode).toBe(401);

      const wrongType = await app.inject({
        method: 'POST',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/execute`,
        headers: bearer(tokens.patient),
      });
      expect(wrongType.statusCode).toBe(403);

      const noPermission = await app.inject({
        method: 'POST',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/execute`,
        headers: bearer(tokens.adminNone),
      });
      expect(noPermission.statusCode).toBe(403);

      const after = await snapshot(db, fixtures.previewSubject);
      expect(after).toEqual(before);
    });
  });

  /* ====================================================================== */
  /* PREVIEW writes nothing                                                  */
  /* ====================================================================== */

  describe('GET preview — real counts, writes NOTHING', () => {
    it('reports the real, live counts for the mutating tables', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{
        requestStatus: string;
        tables: Array<{ table: string; decision: string; rowCount: number | null }>;
      }>(response);
      expect(body.requestStatus).toBe('approved');

      const byTable = new Map(body.tables.map((t) => [t.table, t]));
      expect(byTable.get('patients')).toMatchObject({ decision: 'anonymize', rowCount: 1 });
      expect(byTable.get('search_queries')).toMatchObject({ decision: 'hard_delete', rowCount: 2 });
      expect(byTable.get('promotion_code_attempts')).toMatchObject({ decision: 'anonymize', rowCount: 1 });
    });

    it('*** WRITES ABSOLUTELY NOTHING — proven with a byte-identical SQL snapshot across TWO calls ***', async () => {
      const before = await snapshot(db, fixtures.previewSubject);

      const first = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview`,
        headers: bearer(tokens.adminFull),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${fixtures.previewSubject.requestId}/preview`,
        headers: bearer(tokens.adminFull),
      });
      expect(second.statusCode).toBe(200);

      const after = await snapshot(db, fixtures.previewSubject);
      expect(after).toEqual(before);

      // And the request itself is STILL approved — preview never consumes the approval.
      expect((after.request as { status: string }).status).toBe('approved');
    });

    it('404s for a well-formed but non-existent request id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/data-deletion-requests/${randomUUID()}/preview`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* EXECUTE on a NOT-approved request — refused, touches nothing            */
  /* ====================================================================== */

  describe('POST execute — refused on a non-approved request, touches nothing', () => {
    it('409s (DATA_DELETION_NOT_APPROVED) on a `requested` (not yet approved) request, and mutates nothing', async () => {
      const before = await snapshot(db, fixtures.refusedSubject);

      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/data-deletion-requests/${fixtures.refusedSubject.requestId}/execute`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(409);
      const body = payload<{ code: string; currentStatus: string }>(response);
      expect(body.code).toBe('DATA_DELETION_NOT_APPROVED');
      expect(body.currentStatus).toBe('requested');

      const after = await snapshot(db, fixtures.refusedSubject);
      expect(after).toEqual(before);
    });
  });

  /* ====================================================================== */
  /* EXECUTE on a genuinely approved request — THE REAL THING               */
  /* ====================================================================== */

  describe('POST execute — a genuinely approved request is really anonymized/deleted', () => {
    it('201s, anonymizes patients, hard-deletes search_queries, anonymizes promotion_code_attempts, and LEAVES feedback (a retain table) untouched — verified with direct SQL, not the response', async () => {
      const subject = fixtures.executeSubject;
      const expectedMobilePlaceholder = anonymizedMobilePlaceholder(subject.patientId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/data-deletion-requests/${subject.requestId}/execute`,
        headers: bearer(tokens.adminFull),
      });
      // No `@HttpCode` override on this route — Nest's POST default, 201, applies.
      expect(response.statusCode).toBe(201);
      const body = payload<{
        status: string;
        executionOutcome: {
          overallStatus: string;
          mutatingSteps: Array<{ table: string; status: string; rowsAffected?: number }>;
          retainedTables: Array<{ table: string; decision: string }>;
        };
      }>(response);
      expect(body.status).toBe('executed');
      expect(body.executionOutcome.overallStatus).toBe('executed');

      const stepsByTable = new Map(body.executionOutcome.mutatingSteps.map((s) => [s.table, s]));
      expect(stepsByTable.get('search_queries')).toMatchObject({ status: 'success', rowsAffected: 2 });
      expect(stepsByTable.get('promotion_code_attempts')).toMatchObject({ status: 'success', rowsAffected: 1 });
      expect(stepsByTable.get('patients')).toMatchObject({ status: 'success', rowsAffected: 1 });
      expect(body.executionOutcome.retainedTables.some((t) => t.table === 'feedback' && t.decision === 'retain')).toBe(true);

      /* ── THE REAL PROOF: FRESH SQL, NOT THE HTTP RESPONSE'S OWN SAY-SO ── */

      const patientRow = (await db.select().from(patientsTable).where(eq(patientsTable.id, subject.patientId)))[0];
      expect(patientRow.fullName).toBeNull();
      expect(patientRow.dateOfBirth).toBeNull();
      expect(patientRow.pushToken).toBeNull();
      expect(patientRow.deviceId).toBeNull();
      expect(patientRow.status).toBe('deleted');
      expect(patientRow.mobileNumber).toBe(expectedMobilePlaceholder);
      expect(patientRow.mobileNumber).not.toBe(subject.mobileNumber);

      const remainingSearchQueries = await db
        .select()
        .from(searchQueriesTable)
        .where(inArray(searchQueriesTable.id, subject.searchQueryIds));
      expect(remainingSearchQueries).toHaveLength(0);

      const promotionRow = (
        await db.select().from(promotionCodeAttemptsTable).where(eq(promotionCodeAttemptsTable.id, subject.promotionAttemptId))
      )[0];
      expect(promotionRow).toBeDefined();
      expect(promotionRow.patientId).toBeNull();
      expect(promotionRow.ipAddress).toBeNull();
      // The row itself was ANONYMIZED, not hard-deleted — `outcome` (untouched by this module) survives as proof the row is the same one.
      expect(promotionRow.outcome).toBe('refused');

      // feedback — a `retain` table — is completely untouched, same id, same content.
      const feedbackRow = (await db.select().from(feedbackTable).where(eq(feedbackTable.id, subject.feedbackId)))[0];
      expect(feedbackRow).toBeDefined();
      expect(feedbackRow.rating).toBe(5);
      expect(feedbackRow.comment).toBe('must survive execution');
      expect(feedbackRow.patientId).toBe(subject.patientId); // the FK still resolves — the patient row still exists, merely anonymized.

      const requestRow = (
        await db.select().from(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, subject.requestId))
      )[0];
      expect(requestRow.status).toBe('executed');
      expect(requestRow.executedAt).not.toBeNull();
      expect(requestRow.executionOutcome).toBeTruthy();
    });

    it('409s (DATA_DELETION_NOT_APPROVED) executing the SAME request again — no replay, and the row stays exactly as executed', async () => {
      const subject = fixtures.executeSubject;
      const before = (await db.select().from(patientsTable).where(eq(patientsTable.id, subject.patientId)))[0];

      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/data-deletion-requests/${subject.requestId}/execute`,
        headers: bearer(tokens.adminFull),
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string; currentStatus: string }>(response).code).toBe('DATA_DELETION_NOT_APPROVED');
      expect(payload<{ currentStatus: string }>(response).currentStatus).toBe('executed');

      const after = (await db.select().from(patientsTable).where(eq(patientsTable.id, subject.patientId)))[0];
      expect(after).toEqual(before);
    });
  });

  /* ====================================================================== */
  /* THE CONCURRENCY FIX, OVER REAL HTTP                                    */
  /* ====================================================================== */

  describe('*** THE CONCURRENCY FIX *** — two concurrent real HTTP executes on the SAME approved request', () => {
    it('exactly one of two concurrent POST .../execute calls succeeds; the other gets a clean 409, never both 201, never a 500', async () => {
      const subject = fixtures.concurrentSubject;

      const [first, second] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/admin/data-deletion-requests/${subject.requestId}/execute`,
          headers: bearer(tokens.adminFull),
        }),
        app.inject({
          method: 'POST',
          url: `/api/admin/data-deletion-requests/${subject.requestId}/execute`,
          headers: bearer(tokens.adminFull),
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      // *** THE ASSERTION THE CONCURRENCY FIX EXISTS FOR. *** Never [201, 201].
      // (201, not 200 — this route has no `@HttpCode` override, so Nest's POST default applies.)
      expect(statusCodes).toEqual([201, 409]);

      const winner = first.statusCode === 201 ? first : second;
      const loser = first.statusCode === 409 ? first : second;

      expect(payload<{ status: string; executionOutcome: { overallStatus: string } }>(winner).status).toBe('executed');
      expect(payload<{ code: string }>(loser).code).toBe('DATA_DELETION_NOT_APPROVED');

      // And the real row reflects exactly ONE execution, not a double-apply:
      // hard-deleted rows do not come back, and the request settles on `executed`, never left ambiguous.
      const requestRow = (
        await db.select().from(dataDeletionRequestsTable).where(eq(dataDeletionRequestsTable.id, subject.requestId))
      )[0];
      expect(requestRow.status).toBe('executed');

      const remainingSearchQueries = await db
        .select()
        .from(searchQueriesTable)
        .where(inArray(searchQueriesTable.id, subject.searchQueryIds));
      expect(remainingSearchQueries).toHaveLength(0);

      const patientRow = (await db.select().from(patientsTable).where(eq(patientsTable.id, subject.patientId)))[0];
      expect(patientRow.status).toBe('deleted');
      expect(patientRow.mobileNumber).toBe(anonymizedMobilePlaceholder(subject.patientId));
    });
  });
});
