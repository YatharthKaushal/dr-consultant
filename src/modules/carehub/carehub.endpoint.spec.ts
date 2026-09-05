/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR M-18 CARE HUB. ***
 *
 * Every other test touching this module (`carehub.service.spec.ts`,
 * `carehub.facade.spec.ts`, `carehub.integration.spec.ts`) calls
 * `CarehubService`/`CareHubFacade` directly — real rules, real Postgres in
 * the `.integration.` case, but never through `@AccountType`/
 * `@RequirePermission`, `ValidationPipe`, or `HttpExceptionFilter`. This file
 * drives every route across all four of this module's controllers
 * (`CarehubController`, `CarehubDoctorController`, `CarehubAdminController`,
 * `CarehubShareController`) through `app.inject()` against the REAL
 * application built by `createConfiguredApp()` — the same mechanism
 * `app.e2e.integration.spec.ts` uses, and the same JWT-minting shortcut
 * (`IdentityTokenService.mintTokenPair`, resolved from the real container)
 * that file's own header documents as the sanctioned way to authenticate an
 * `app.inject()` call without the OTP/Slide round trip — nothing here mints
 * a lookalike token: `mintTokenPair` IS what `POST /api/auth/otp/verify`
 * calls internally.
 *
 * *** THE REGRESSION THIS FILE EXISTS TO PIN. *** An adversarial pass (see
 * `git log` — "Fix M-18: recommendations kept leaking unpublished content
 * items") found and fixed `CarehubService`'s recommendation reads returning
 * a doctor's recommendation for a content item an admin had since retired,
 * reverted to draft, or otherwise unpublished. `carehub.service.spec.ts`
 * proves the SERVICE method filters correctly against a mocked repository;
 * this file additionally proves the full HTTP round trip — real admin
 * transition routes, real permission gates, real Postgres — produces the
 * same outcome a patient's app would actually see.
 *
 * Permissions are granted directly via `admin_permission_grants` against the
 * REAL, already-seeded `permissions` table (`content.read`/`content.author`/
 * `content.publish` — seeded by `identity.seed.ts`, confirmed present in the
 * shared database before writing this file), never a synthetic test
 * permission — so a drift between this module's `PERMISSIONS` catalog and
 * what's actually seeded would fail loudly here rather than being masked.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env.local`
 * exactly as every other `*.integration.spec.ts` in this repo does, and
 * fails loudly rather than skipping.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { getEnv, loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { concernsTable } from '../../schema/concerns.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { contentItemsTable } from '../../schema/content-items.schema';
import { contentRecommendationsTable } from '../../schema/content-recommendations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { IdentityTokenService } from '../identity/identity-token.service';

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/* Envelope + fixtures                                                        */
/* -------------------------------------------------------------------------- */

/** See `app.e2e.integration.spec.ts`'s identical helper — every response is enveloped by `ResponseInterceptor`/`HttpExceptionFilter`. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  specialtyId: string;
  concernId: string;
  patientId: string;
  patient2Id: string;
  doctorId: string;
  otherDoctorId: string;
  consultationId: string;
  adminFullId: string; // content.read + content.author + content.publish
  adminAuthorOnlyId: string; // content.author only
  adminPublishOnlyId: string; // content.publish only
  adminReadOnlyId: string; // content.read only
  adminNoPermId: string; // admin account, zero grants
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9196${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `chep_${runId}`, name: `CH Endpoint Specialty ${runId}`, canPrescribe: false })
    .returning({ id: specialtiesTable.id });
  const [concern] = await db
    .insert(concernsTable)
    .values({ specialtyId: specialty.id, code: `chep_concern_${runId}`, name: `CH Endpoint Concern ${runId}` })
    .returning({ id: concernsTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `CH Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [patient2] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `CH Endpoint Patient 2 ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  async function makeDoctor(label: string): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `${label} ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
      })
      .returning({ id: doctorsTable.id });
    await db.insert(doctorSpecialtiesTable).values({ doctorId: row.id, specialtyId: specialty.id, isPrimary: true });
    return row.id;
  }
  const doctorId = await makeDoctor('CH Endpoint Doctor');
  const otherDoctorId = await makeDoctor('CH Endpoint Other Doctor');

  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `CHEP-${runId}`,
      patientId: patient.id,
      doctorId,
      specialtyId: specialty.id,
      mode: 'scheduled',
      status: 'completed',
      durationMinutes: 30,
    })
    .returning({ id: consultationsTable.id });

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` })
      .returning({ id: adminsTable.id });
    return row.id;
  }
  const adminFullId = await makeAdmin('CH Admin Full');
  const adminAuthorOnlyId = await makeAdmin('CH Admin Author');
  const adminPublishOnlyId = await makeAdmin('CH Admin Publish');
  const adminReadOnlyId = await makeAdmin('CH Admin Read');
  const adminNoPermId = await makeAdmin('CH Admin NoPerm');

  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, ['content.read', 'content.author', 'content.publish']));
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (permissionIdByKey.size !== 3) {
    throw new Error(
      `Expected content.read/content.author/content.publish to be seeded in 'permissions' (run npm run db:seed) — found ${permissionIdByKey.size}/3.`,
    );
  }

  async function grant(adminId: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await db.insert(adminPermissionGrantsTable).values({
        adminId,
        permissionId: permissionIdByKey.get(key)!,
        reason: 'carehub.endpoint.spec.ts fixture',
      });
    }
  }
  await grant(adminFullId, ['content.read', 'content.author', 'content.publish']);
  await grant(adminAuthorOnlyId, ['content.read', 'content.author']);
  await grant(adminPublishOnlyId, ['content.read', 'content.publish']);
  await grant(adminReadOnlyId, ['content.read']);
  // adminNoPermId: deliberately zero grants.

  return {
    runId,
    specialtyId: specialty.id,
    concernId: concern.id,
    patientId: patient.id,
    patient2Id: patient2.id,
    doctorId,
    otherDoctorId,
    consultationId: consultation.id,
    adminFullId,
    adminAuthorOnlyId,
    adminPublishOnlyId,
    adminReadOnlyId,
    adminNoPermId,
  };
}

async function teardown(db: Database, fixtures: Fixtures, contentItemIds: readonly string[]): Promise<void> {
  const adminIds = [
    fixtures.adminFullId,
    fixtures.adminAuthorOnlyId,
    fixtures.adminPublishOnlyId,
    fixtures.adminReadOnlyId,
    fixtures.adminNoPermId,
  ];
  const doctorIds = [fixtures.doctorId, fixtures.otherDoctorId];
  const patientIds = [fixtures.patientId, fixtures.patient2Id];

  // admin_permission_grants cascades on admin deletion; deleted explicitly
  // anyway for clarity and so a teardown that partially failed a prior run
  // still cleans up.
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(contentRecommendationsTable).where(eq(contentRecommendationsTable.consultationId, fixtures.consultationId));
  await db.delete(contentItemsTable).where(inArray(contentItemsTable.id, [...contentItemIds]));
  await db.delete(auditLogTable).where(eq(auditLogTable.consultationId, fixtures.consultationId));
  await db.execute(
    sql`delete from audit_log where actor_id = any(${sql.raw(`array['${[...adminIds, ...doctorIds, ...patientIds].join("','")}']::uuid[]`)})`,
  );
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.consultationId));
  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(concernsTable).where(eq(concernsTable.id, fixtures.concernId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/* -------------------------------------------------------------------------- */

describe('M-18 Care Hub — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;
  const createdContentItemIds: string[] = [];

  let patientToken: string;
  let patient2Token: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  let adminFullToken: string;
  let adminAuthorOnlyToken: string;
  let adminPublishOnlyToken: string;
  let adminReadOnlyToken: string;
  let adminNoPermToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    tokenService = app.get(IdentityTokenService);
    fixtures = await seedFixtures(db);

    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
    patient2Token = (await tokenService.mintTokenPair('patient', fixtures.patient2Id, 0)).accessToken;
    doctorToken = (await tokenService.mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
    otherDoctorToken = (await tokenService.mintTokenPair('doctor', fixtures.otherDoctorId, 0)).accessToken;
    adminFullToken = (await tokenService.mintTokenPair('admin', fixtures.adminFullId, 0)).accessToken;
    adminAuthorOnlyToken = (await tokenService.mintTokenPair('admin', fixtures.adminAuthorOnlyId, 0)).accessToken;
    adminPublishOnlyToken = (await tokenService.mintTokenPair('admin', fixtures.adminPublishOnlyId, 0)).accessToken;
    adminReadOnlyToken = (await tokenService.mintTokenPair('admin', fixtures.adminReadOnlyId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures, createdContentItemIds);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /** Creates a draft item as `adminFullToken` and tracks it for teardown. */
  async function createDraft(overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
    const slug = `chep-${fixtures.runId}-${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/care-hub/content',
      headers: auth(adminFullToken),
      payload: { itemType: 'caregiver_guide', slug, title: 'Warning signs', body: { blocks: [] }, ...overrides },
    });
    expect(res.statusCode).toBe(201);
    const item = payload<{ id: string; slug: string }>(res);
    createdContentItemIds.push(item.id);
    return item;
  }

  async function publish(id: string): Promise<void> {
    const submitted = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${id}/submit`, headers: auth(adminFullToken) });
    expect(submitted.statusCode).toBe(200);
    const published = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${id}/publish`, headers: auth(adminFullToken) });
    expect(published.statusCode).toBe(200);
  }

  /* ====================================================================== */
  /* Patient browse — GET /care-hub/content, GET /care-hub/content/:id      */
  /* ====================================================================== */

  describe('patient browse — published only', () => {
    it('unauthenticated is refused 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/care-hub/content' });
      expect(res.statusCode).toBe(401);
      expect(payload<{ code: string }>(res).code).toBe('UNAUTHENTICATED');
    });

    it('wrong account type (doctor token) is refused 403 WRONG_ACCOUNT_TYPE', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/care-hub/content', headers: auth(doctorToken) });
      expect(res.statusCode).toBe(403);
      expect(payload<{ code: string }>(res).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('lists a published item, but not a draft one', async () => {
      const draft = await createDraft({ itemType: 'education_module', concernId: fixtures.concernId, title: `Draft Only ${fixtures.runId}` });
      const published = await createDraft({ itemType: 'education_module', concernId: fixtures.concernId, title: `Published Item ${fixtures.runId}` });
      await publish(published.id);

      const res = await app.inject({ method: 'GET', url: '/api/care-hub/content', headers: auth(patientToken) });
      expect(res.statusCode).toBe(200);
      const items = payload<Array<{ id: string }>>(res);
      const ids = items.map((item) => item.id);
      expect(ids).toContain(published.id);
      expect(ids).not.toContain(draft.id);
    });

    it('GET content/:id on a draft item 404s — same shape a nonexistent id gets', async () => {
      const draft = await createDraft();
      const draftRes = await app.inject({ method: 'GET', url: `/api/care-hub/content/${draft.id}`, headers: auth(patientToken) });
      const nonexistentRes = await app.inject({ method: 'GET', url: `/api/care-hub/content/${randomUUID()}`, headers: auth(patientToken) });

      expect(draftRes.statusCode).toBe(404);
      expect(nonexistentRes.statusCode).toBe(404);
      expect(payload<{ code: string }>(draftRes)).toEqual(payload<{ code: string }>(nonexistentRes));
      expect(payload<{ code: string }>(draftRes).code).toBe('CARE_HUB_CONTENT_ITEM_NOT_FOUND');
    });

    it('a published clinical_reference is excluded from the patient browse, even when asked for explicitly', async () => {
      const item = await createDraft({ itemType: 'clinical_reference', specialtyId: fixtures.specialtyId, title: `Clinical Ref ${fixtures.runId}` });
      await publish(item.id);

      const filtered = await app.inject({ method: 'GET', url: '/api/care-hub/content?itemType=clinical_reference', headers: auth(patientToken) });
      expect(filtered.statusCode).toBe(200);
      expect(payload<unknown[]>(filtered)).toEqual([]);

      const unfiltered = await app.inject({ method: 'GET', url: '/api/care-hub/content', headers: auth(patientToken) });
      const ids = payload<Array<{ id: string }>>(unfiltered).map((row) => row.id);
      expect(ids).not.toContain(item.id);

      const byId = await app.inject({ method: 'GET', url: `/api/care-hub/content/${item.id}`, headers: auth(patientToken) });
      expect(byId.statusCode).toBe(404);
    });

    it('validation: an unknown itemType is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/care-hub/content?itemType=not_a_real_type', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });
  });

  /* ====================================================================== */
  /* THE REGRESSION: unpublishing a recommended item makes it disappear      */
  /* ====================================================================== */

  describe('*** THE FIX, PROVEN OVER HTTP: recommendations stop surfacing the moment an item leaves `published`. ***', () => {
    it('doctor-recommended item shows for the patient while published, disappears the moment it is retired, and stays gone after restore to draft', async () => {
      const item = await createDraft({ itemType: 'self_help_tool', title: `Regression Item ${fixtures.runId}` });
      await publish(item.id);

      const added = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [item.id] },
      });
      expect(added.statusCode).toBe(200);

      const whilePublished = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations`,
        headers: auth(patientToken),
      });
      expect(whilePublished.statusCode).toBe(200);
      expect(payload<Array<{ contentItem: { id: string } }>>(whilePublished).map((r) => r.contentItem.id)).toContain(item.id);

      // published -> archived (retire), content.publish-gated.
      const retired = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/retire`, headers: auth(adminFullToken) });
      expect(retired.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(retired).reviewStatus).toBe('archived');

      const afterRetire = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations`,
        headers: auth(patientToken),
      });
      expect(afterRetire.statusCode).toBe(200);
      expect(payload<Array<{ contentItem: { id: string } }>>(afterRetire).map((r) => r.contentItem.id)).not.toContain(item.id);

      // The recommendation ROW still exists — only the read is filtered.
      const rows = await db
        .select()
        .from(contentRecommendationsTable)
        .where(inArray(contentRecommendationsTable.contentItemId, [item.id]));
      expect(rows).toHaveLength(1);

      // archived -> draft (restore) — still not published, so still gone.
      const restored = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/restore`, headers: auth(adminFullToken) });
      expect(restored.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(restored).reviewStatus).toBe('draft');

      const afterRestore = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations`,
        headers: auth(patientToken),
      });
      expect(payload<Array<{ contentItem: { id: string } }>>(afterRestore).map((r) => r.contentItem.id)).not.toContain(item.id);

      // Also true from the DOCTOR's own read of the same consultation.
      const doctorRead = await app.inject({
        method: 'GET',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
      });
      expect(payload<Array<{ contentItem: { id: string } }>>(doctorRead).map((r) => r.contentItem.id)).not.toContain(item.id);
    });
  });

  /* ====================================================================== */
  /* Doctor recommendation write path                                        */
  /* ====================================================================== */

  describe('doctor recommendation write path', () => {
    it('the treating doctor recommends a published item; a doctor who is not treating gets 404, not 403', async () => {
      const item = await createDraft({ title: `Doc Write ${fixtures.runId}` });
      await publish(item.id);

      const wrongDoctor = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(otherDoctorToken),
        payload: { contentItemIds: [item.id] },
      });
      const nonexistentConsultation = await app.inject({
        method: 'POST',
        url: `/api/consultations/${randomUUID()}/care-hub/recommendations`,
        headers: auth(otherDoctorToken),
        payload: { contentItemIds: [item.id] },
      });
      expect(wrongDoctor.statusCode).toBe(404);
      expect(nonexistentConsultation.statusCode).toBe(404);
      expect(payload<{ code: string }>(wrongDoctor)).toEqual(payload<{ code: string }>(nonexistentConsultation));

      const rightDoctor = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [item.id] },
      });
      expect(rightDoctor.statusCode).toBe(200);
      expect(payload<Array<{ contentItem: { id: string } }>>(rightDoctor).map((r) => r.contentItem.id)).toContain(item.id);

      // Re-adding the same item is a silent no-op (unique index), not an error.
      const again = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [item.id] },
      });
      expect(again.statusCode).toBe(200);
      const rows = await db.select().from(contentRecommendationsTable).where(inArray(contentRecommendationsTable.contentItemId, [item.id]));
      expect(rows).toHaveLength(1);
    });

    it('recommending a draft (unpublished) item is refused 400 CONTENT_ITEM_NOT_RECOMMENDABLE', async () => {
      const draft = await createDraft({ title: `Not Recommendable ${fixtures.runId}` });
      const res = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [draft.id] },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_CONTENT_ITEM_NOT_RECOMMENDABLE');
    });

    it('validation: an empty contentItemIds array is refused 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        payload: { contentItemIds: [randomUUID()] },
      });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(patientToken),
        payload: { contentItemIds: [randomUUID()] },
      });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('DELETE a recommendation as the treating doctor removes it; as another doctor 404s', async () => {
      const item = await createDraft({ title: `Delete Me ${fixtures.runId}` });
      await publish(item.id);
      const added = await app.inject({
        method: 'POST',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
        payload: { contentItemIds: [item.id] },
      });
      expect(added.statusCode).toBe(200);

      const wrongDoctorDelete = await app.inject({
        method: 'DELETE',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations/${item.id}`,
        headers: auth(otherDoctorToken),
      });
      expect(wrongDoctorDelete.statusCode).toBe(404);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations/${item.id}`,
        headers: auth(doctorToken),
      });
      expect(removed.statusCode).toBe(200);

      const list = await app.inject({
        method: 'GET',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(doctorToken),
      });
      expect(payload<Array<{ contentItem: { id: string } }>>(list).map((r) => r.contentItem.id)).not.toContain(item.id);
    });

    it('GET recommendations as a doctor with no relationship to the consultation 404s', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/consultations/${fixtures.consultationId}/care-hub/recommendations`,
        headers: auth(otherDoctorToken),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* Patient recommendations read — ownership                                */
  /* ====================================================================== */

  describe('patient reading their own recommendations', () => {
    it('the owning patient sees them; an unrelated patient gets the same 404 a nonexistent consultation gets', async () => {
      const owner = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations`,
        headers: auth(patientToken),
      });
      expect(owner.statusCode).toBe(200);

      const stranger = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations`,
        headers: auth(patient2Token),
      });
      const nonexistent = await app.inject({
        method: 'GET',
        url: `/api/care-hub/consultations/${randomUUID()}/recommendations`,
        headers: auth(patient2Token),
      });
      expect(stranger.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(payload<{ code: string }>(stranger)).toEqual(payload<{ code: string }>(nonexistent));
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/care-hub/consultations/${fixtures.consultationId}/recommendations` });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Share link — @Public(), HMAC-signed                                     */
  /* ====================================================================== */

  describe('share link — the only @Public() route in this module', () => {
    function forgeToken(contentItemId: string, expiresAtSeconds: number, wrongKey = false): string {
      const keyMaterial = wrongKey ? 'wrong-secret-entirely' : getEnv().JWT_ACCESS_SECRET;
      const shareKey = createHmac('sha256', keyMaterial).update('carehub.share_link.v1').digest();
      const payloadPart = Buffer.from(JSON.stringify({ c: contentItemId, e: expiresAtSeconds }), 'utf8').toString('base64url');
      const signature = createHmac('sha256', shareKey).update(payloadPart).digest('base64url');
      return `v1.${payloadPart}.${signature}`;
    }

    it('mints a real token via POST .../share, and GET /shared/:token resolves it unauthenticated', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Shareable ${fixtures.runId}` });
      await publish(item.id);

      const minted = await app.inject({
        method: 'POST',
        url: `/api/care-hub/content/${item.id}/share`,
        headers: auth(patientToken),
      });
      expect(minted.statusCode).toBe(200);
      const { token } = payload<{ token: string; expiresAt: string }>(minted);
      expect(typeof token).toBe('string');

      const resolved = await app.inject({ method: 'GET', url: `/api/care-hub/shared/${token}` });
      expect(resolved.statusCode).toBe(200);
      expect(payload<{ id: string }>(resolved).id).toBe(item.id);
    });

    it('*** THE FIX, RE-VERIFIED FOR THE SHARE-LINK PATH: a valid token against content since unpublished now correctly fails. ***', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Unpublished After Share ${fixtures.runId}` });
      await publish(item.id);

      const minted = await app.inject({ method: 'POST', url: `/api/care-hub/content/${item.id}/share`, headers: auth(patientToken) });
      const { token } = payload<{ token: string }>(minted);

      const whilePublished = await app.inject({ method: 'GET', url: `/api/care-hub/shared/${token}` });
      expect(whilePublished.statusCode).toBe(200);

      const retired = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/retire`, headers: auth(adminFullToken) });
      expect(retired.statusCode).toBe(200);

      const afterRetire = await app.inject({ method: 'GET', url: `/api/care-hub/shared/${token}` });
      expect(afterRetire.statusCode).toBe(404);
      expect(payload<{ code: string }>(afterRetire).code).toBe('CARE_HUB_SHARE_LINK_INVALID');
    });

    it('an expired token 404s the same way an invalid one does', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Expiry Test ${fixtures.runId}` });
      await publish(item.id);
      const pastSeconds = Math.floor((Date.now() - 60_000) / 1000);
      const expired = forgeToken(item.id, pastSeconds);

      const res = await app.inject({ method: 'GET', url: `/api/care-hub/shared/${expired}` });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_SHARE_LINK_INVALID');
    });

    it('a forged token (wrong signing key) 404s', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Forged Test ${fixtures.runId}` });
      await publish(item.id);
      const futureSeconds = Math.floor((Date.now() + 60_000) / 1000);
      const forged = forgeToken(item.id, futureSeconds, true);

      const res = await app.inject({ method: 'GET', url: `/api/care-hub/shared/${forged}` });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_SHARE_LINK_INVALID');
    });

    it('a malformed token (wrong shape entirely) 404s rather than 500ing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/care-hub/shared/not-a-real-token-at-all' });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_SHARE_LINK_INVALID');
    });

    it('sharing a non-caregiver_guide published item is refused 400 NOT_SHAREABLE', async () => {
      const item = await createDraft({ itemType: 'education_module', concernId: fixtures.concernId, title: `Not Shareable ${fixtures.runId}` });
      await publish(item.id);
      const res = await app.inject({ method: 'POST', url: `/api/care-hub/content/${item.id}/share`, headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_NOT_SHAREABLE');
    });

    it('sharing a draft caregiver_guide 404s (not found, not a business-rule refusal)', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Draft Guide ${fixtures.runId}` });
      const res = await app.inject({ method: 'POST', url: `/api/care-hub/content/${item.id}/share`, headers: auth(patientToken) });
      expect(res.statusCode).toBe(404);
    });

    it('minting a share link is patient-only: unauthenticated 401, doctor token 403 WRONG_ACCOUNT_TYPE', async () => {
      const item = await createDraft({ itemType: 'caregiver_guide', title: `Share Auth ${fixtures.runId}` });
      await publish(item.id);

      const anon = await app.inject({ method: 'POST', url: `/api/care-hub/content/${item.id}/share` });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'POST', url: `/api/care-hub/content/${item.id}/share`, headers: auth(doctorToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* Admin authoring — CRUD, validation, permission gates                    */
  /* ====================================================================== */

  describe('admin authoring — create/update, permission-gated on content.author', () => {
    it('create: 403 without content.author, 201 with it — same body, different token', async () => {
      const slug = `chep-noperm-${fixtures.runId}`;
      const body = { itemType: 'education_module', slug, title: 'No Perm', body: { blocks: [] } };

      const noPerm = await app.inject({ method: 'POST', url: '/api/admin/care-hub/content', headers: auth(adminReadOnlyToken), payload: body });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const withPerm = await app.inject({ method: 'POST', url: '/api/admin/care-hub/content', headers: auth(adminAuthorOnlyToken), payload: body });
      expect(withPerm.statusCode).toBe(201);
      const created = payload<{ id: string; reviewStatus: string }>(withPerm);
      createdContentItemIds.push(created.id);
      expect(created.reviewStatus).toBe('draft');
    });

    it('create: unauthenticated 401, wrong account type (patient token) 403 WRONG_ACCOUNT_TYPE', async () => {
      const body = { itemType: 'education_module', slug: `chep-auth-${fixtures.runId}`, title: 'Auth Test', body: {} };
      const anon = await app.inject({ method: 'POST', url: '/api/admin/care-hub/content', payload: body });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'POST', url: '/api/admin/care-hub/content', headers: auth(patientToken), payload: body });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('validation: missing required fields is refused 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/care-hub/content', headers: auth(adminFullToken), payload: { itemType: 'education_module' } });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('an unknown concernId is refused 400 UNKNOWN_TAXONOMY_REFERENCE', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/care-hub/content',
        headers: auth(adminFullToken),
        payload: { itemType: 'education_module', slug: `chep-badref-${fixtures.runId}`, title: 'Bad Ref', body: {}, concernId: randomUUID() },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_UNKNOWN_TAXONOMY_REFERENCE');
    });

    it('isVerifiedOrg on a non-support_org item is refused 400 VERIFIED_ORG_NOT_APPLICABLE', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/care-hub/content',
        headers: auth(adminFullToken),
        payload: { itemType: 'education_module', slug: `chep-vo-${fixtures.runId}`, title: 'VO', body: {}, isVerifiedOrg: true },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_VERIFIED_ORG_NOT_APPLICABLE');
    });

    it('specialtyId on a non-clinical_reference item is refused 400 SPECIALTY_NOT_APPLICABLE', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/care-hub/content',
        headers: auth(adminFullToken),
        payload: { itemType: 'education_module', slug: `chep-sp-${fixtures.runId}`, title: 'SP', body: {}, specialtyId: fixtures.specialtyId },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_SPECIALTY_NOT_APPLICABLE');
    });

    it('a duplicate slug is refused 409 SLUG_TAKEN', async () => {
      const item = await createDraft();
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/care-hub/content',
        headers: auth(adminFullToken),
        payload: { itemType: 'education_module', slug: item.slug, title: 'Dup', body: {} },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_SLUG_TAKEN');
    });

    it('update: 403 without content.author, 200 with it', async () => {
      const item = await createDraft();
      const noPerm = await app.inject({
        method: 'PUT',
        url: `/api/admin/care-hub/content/${item.id}`,
        headers: auth(adminPublishOnlyToken),
        payload: { title: 'Updated Title' },
      });
      expect(noPerm.statusCode).toBe(403);

      const withPerm = await app.inject({
        method: 'PUT',
        url: `/api/admin/care-hub/content/${item.id}`,
        headers: auth(adminAuthorOnlyToken),
        payload: { title: 'Updated Title' },
      });
      expect(withPerm.statusCode).toBe(200);
      expect(payload<{ title: string }>(withPerm).title).toBe('Updated Title');
    });

    it('update on a nonexistent id 404s', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/care-hub/content/${randomUUID()}`,
        headers: auth(adminFullToken),
        payload: { title: 'Nope' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('admin listing — permission-gated on content.read', () => {
    it('list: 403 without content.read, 200 with it', async () => {
      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/care-hub/content', headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const withPerm = await app.inject({ method: 'GET', url: '/api/admin/care-hub/content', headers: auth(adminReadOnlyToken) });
      expect(withPerm.statusCode).toBe(200);
    });

    it('get by id: 403 without content.read, 404 for an unknown id with it', async () => {
      const noPerm = await app.inject({ method: 'GET', url: `/api/admin/care-hub/content/${randomUUID()}`, headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);

      const withPerm = await app.inject({ method: 'GET', url: `/api/admin/care-hub/content/${randomUUID()}`, headers: auth(adminReadOnlyToken) });
      expect(withPerm.statusCode).toBe(404);
      expect(payload<{ code: string }>(withPerm).code).toBe('CARE_HUB_CONTENT_ITEM_NOT_FOUND');
    });

    it('an admin who is not an admin at all (patient token) is 403 WRONG_ACCOUNT_TYPE before permission is ever checked', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/care-hub/content', headers: auth(patientToken) });
      expect(res.statusCode).toBe(403);
      expect(payload<{ code: string }>(res).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* The six named transitions — exact permission per move                   */
  /* ====================================================================== */

  describe('the six-transition review state machine — exact permission per move', () => {
    it('submit (draft -> in_clinical_review): content.author, not content.publish', async () => {
      const item = await createDraft();
      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminPublishOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminAuthorOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(rightPerm).reviewStatus).toBe('in_clinical_review');
    });

    it('publish (in_clinical_review -> published): content.publish, not content.author; sets reviewedByAdminId/reviewedAt', async () => {
      const item = await createDraft();
      await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminFullToken) });

      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/publish`, headers: auth(adminAuthorOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/publish`, headers: auth(adminPublishOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      const view = payload<{ reviewStatus: string; reviewedByAdminId: string | null; reviewedAt: string | null }>(rightPerm);
      expect(view.reviewStatus).toBe('published');
      expect(view.reviewedByAdminId).toBe(fixtures.adminPublishOnlyId);
      expect(view.reviewedAt).not.toBeNull();
    });

    it('publishing straight from draft is refused 409 ILLEGAL_REVIEW_TRANSITION', async () => {
      const item = await createDraft();
      const res = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/publish`, headers: auth(adminFullToken) });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('CARE_HUB_ILLEGAL_REVIEW_TRANSITION');
    });

    it('reject (in_clinical_review -> draft): content.publish, not content.author', async () => {
      const item = await createDraft();
      await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminFullToken) });

      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/reject`, headers: auth(adminAuthorOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/reject`, headers: auth(adminPublishOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(rightPerm).reviewStatus).toBe('draft');
    });

    it('withdraw ({draft,in_clinical_review} -> archived): content.author, not content.publish', async () => {
      const item = await createDraft();
      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/withdraw`, headers: auth(adminPublishOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/withdraw`, headers: auth(adminAuthorOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(rightPerm).reviewStatus).toBe('archived');
    });

    it('retire (published -> archived): content.publish, not content.author', async () => {
      const item = await createDraft();
      await publish(item.id);

      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/retire`, headers: auth(adminAuthorOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/retire`, headers: auth(adminPublishOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(rightPerm).reviewStatus).toBe('archived');
    });

    it('restore (archived -> draft): content.author, not content.publish', async () => {
      const item = await createDraft();
      await publish(item.id);
      await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/retire`, headers: auth(adminFullToken) });

      const wrongPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/restore`, headers: auth(adminPublishOnlyToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/restore`, headers: auth(adminAuthorOnlyToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(rightPerm).reviewStatus).toBe('draft');
    });

    it('a repeat transition into the SAME status is an idempotent 200 no-op, not an error', async () => {
      const item = await createDraft();
      await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminFullToken) });
      const again = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${item.id}/submit`, headers: auth(adminFullToken) });
      expect(again.statusCode).toBe(200);
      expect(payload<{ reviewStatus: string }>(again).reviewStatus).toBe('in_clinical_review');
    });

    it('a transition on an unknown id 404s, and unauthenticated/wrong-account-type are refused before reaching the service', async () => {
      const unknown = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${randomUUID()}/submit`, headers: auth(adminFullToken) });
      expect(unknown.statusCode).toBe(404);

      const anon = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${randomUUID()}/submit` });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'POST', url: `/api/admin/care-hub/content/${randomUUID()}/submit`, headers: auth(doctorToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });
});
