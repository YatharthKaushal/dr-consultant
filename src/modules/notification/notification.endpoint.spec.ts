/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR M-08 NOTIFICATION. ***
 *
 * Every other spec here calls `NotificationService`/`NotificationFacade`/
 * `NotificationTemplateService` directly. This file drives every route on
 * `NotificationController` (the in-app inbox + device registration) and
 * `NotificationAdminController` (template copy) through `app.inject()`
 * against the REAL application, with real guards, `ValidationPipe`, and
 * Postgres — the same mechanism `app.e2e.integration.spec.ts` documents, and
 * the same JWT-minting shortcut (`IdentityTokenService.mintTokenPair`).
 *
 * *** THIS PROJECT HAS NO REAL FCM CREDENTIALS ANYWHERE. *** `FcmPushAdapter`
 * logs "FCM is not configured ... will be recorded but not delivered" — by
 * design, not a gap in this test. There is no `POST /notifications` route (a
 * notification is raised by another module through `NotificationFacade`,
 * never by an app directly), so the "recorded but undeliverable" proof below
 * calls `app.get(NotificationFacade).notify(...)` — the REAL, DI-resolved
 * write path other modules use — and then verifies the read side entirely
 * over HTTP: the row is visible, its `status` is `failed` with a
 * provider-unavailable reason, and the read/unread/device-token surface all
 * behave correctly around it.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env.local`,
 * fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { notificationsTable } from '../../schema/notifications.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { NotificationFacade } from './notification.facade';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

interface Fixtures {
  runId: string;
  patientId: string;
  patient2Id: string;
  doctorId: string;
  adminTemplateEditorId: string; // content.manage_notification_templates
  adminNoPermId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9194${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Notif Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [patient2] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Notif Endpoint Patient 2 ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Notif Endpoint Doctor ${runId}`, verificationStatus: 'verified', isListed: true })
    .returning({ id: doctorsTable.id });

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` })
      .returning({ id: adminsTable.id });
    return row.id;
  }
  const adminTemplateEditorId = await makeAdmin('Notif Admin TemplateEditor');
  const adminNoPermId = await makeAdmin('Notif Admin NoPerm');

  const [permission] = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.key, 'content.manage_notification_templates'));
  if (!permission) {
    throw new Error('Expected content.manage_notification_templates to be seeded in `permissions` (run npm run db:seed).');
  }
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminTemplateEditorId, permissionId: permission.id });

  return { runId, patientId: patient.id, patient2Id: patient2.id, doctorId: doctor.id, adminTemplateEditorId, adminNoPermId };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [fixtures.adminTemplateEditorId, fixtures.adminNoPermId];
  const patientIds = [fixtures.patientId, fixtures.patient2Id];

  // `notifications` FKs onto all three of patients/doctors/admins — every row
  // this run created must go BEFORE the accounts it points at.
  await db.delete(notificationsTable).where(inArray(notificationsTable.patientId, patientIds));
  await db.delete(notificationsTable).where(eq(notificationsTable.doctorId, fixtures.doctorId));
  await db.delete(notificationsTable).where(inArray(notificationsTable.adminId, adminIds));
  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
}

/* -------------------------------------------------------------------------- */

describe('M-08 Notification — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let facade: NotificationFacade;
  let patientToken: string;
  let patient2Token: string;
  let doctorToken: string;
  let adminTemplateEditorToken: string;
  let adminNoPermToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);
    facade = app.get(NotificationFacade);

    const tokenService = app.get(IdentityTokenService);
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
    patient2Token = (await tokenService.mintTokenPair('patient', fixtures.patient2Id, 0)).accessToken;
    doctorToken = (await tokenService.mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
    adminTemplateEditorToken = (await tokenService.mintTokenPair('admin', fixtures.adminTemplateEditorId, 0)).accessToken;
    adminNoPermToken = (await tokenService.mintTokenPair('admin', fixtures.adminNoPermId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /* ====================================================================== */
  /* THE WRITE HALF, called directly on the real DI-resolved facade —        */
  /* there is no HTTP route for it — then verified entirely over HTTP        */
  /* ====================================================================== */

  describe('*** a notification is recorded correctly even though push is undeliverable (no FCM credentials exist anywhere in this project) ***', () => {
    it('notify() queues a row, the push leg degrades to provider_unavailable, and the patient still sees it in-app', async () => {
      const result = await facade.notify({
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient', id: fixtures.patientId },
        variables: { doctorName: 'Dr. Endpoint Test', scheduledAt: '2026-01-01 10:00' },
      });
      expect(result.queued).toBe(true);
      expect(result.notificationId).not.toBeNull();
      expect(result.reason).toBe('provider_unavailable');

      // Raw SQL: the operational failure_reason (never exposed over HTTP) really names the cause.
      const [row] = await db
        .select({ status: notificationsTable.status, failureReason: notificationsTable.failureReason })
        .from(notificationsTable)
        .where(eq(notificationsTable.id, result.notificationId!));
      expect(row.status).toBe('failed');
      expect(row.failureReason).toMatch(/FCM is not configured/i);

      // And the same fact, over the real HTTP inbox route — `status` IS exposed, `failureReason` is not.
      const list = await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(patientToken) });
      expect(list.statusCode).toBe(200);
      const notifications = payload<Array<{ id: number; status: string; title: string; body: string }>>(list);
      const found = notifications.find((n) => n.id === result.notificationId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('failed');
      expect(found!.title.length).toBeGreaterThan(0);
      expect((found as unknown as { failureReason?: unknown }).failureReason).toBeUndefined();
    });

    it('an admin audience is delivered by the row alone (no push channel exists) — status is sent, not failed', async () => {
      const result = await facade.notify({
        templateCode: 'checkin_due',
        audience: { kind: 'admin', id: fixtures.adminNoPermId },
      });
      expect(result.queued).toBe(true);

      const [row] = await db.select({ status: notificationsTable.status }).from(notificationsTable).where(eq(notificationsTable.id, result.notificationId!));
      expect(row.status).toBe('sent');

      const list = await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(adminNoPermToken) });
      expect(payload<Array<{ id: number; status: string }>>(list).some((n) => n.id === result.notificationId && n.status === 'sent')).toBe(true);
    });
  });

  /* ====================================================================== */
  /* GET /notifications, GET unread-count, POST :id/read, POST read-all      */
  /* ====================================================================== */

  describe('the in-app inbox — ownership, unread counting, marking read', () => {
    it('unread-count reflects an unread notification, POST :id/read marks it, and the count drops', async () => {
      const created = await facade.notify({ templateCode: 'doctor_approved', audience: { kind: 'patient', id: fixtures.patientId } });
      const id = created.notificationId!;

      const before = payload<{ unread: number }>(
        await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: auth(patientToken) }),
      );
      expect(before.unread).toBeGreaterThan(0);

      const marked = await app.inject({ method: 'POST', url: `/api/notifications/${id}/read`, headers: auth(patientToken) });
      expect(marked.statusCode).toBe(201);
      const markedBody = payload<{ id: number; readAt: string }>(marked);
      expect(markedBody.id).toBe(id);
      expect(markedBody.readAt).not.toBeNull();

      const after = payload<{ unread: number }>(
        await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: auth(patientToken) }),
      );
      expect(after.unread).toBe(before.unread - 1);

      // unreadOnly=true no longer includes it.
      const unreadList = payload<Array<{ id: number }>>(
        await app.inject({ method: 'GET', url: '/api/notifications?unreadOnly=true', headers: auth(patientToken) }),
      );
      expect(unreadList.map((n) => n.id)).not.toContain(id);
    });

    it("marking another patient's notification (or a nonexistent id) 404s the same way — no existence oracle", async () => {
      const created = await facade.notify({ templateCode: 'doctor_approved', audience: { kind: 'patient', id: fixtures.patient2Id } });

      const stolen = await app.inject({ method: 'POST', url: `/api/notifications/${created.notificationId}/read`, headers: auth(patientToken) });
      const nonexistent = await app.inject({ method: 'POST', url: '/api/notifications/999999999/read', headers: auth(patientToken) });

      expect(stolen.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(payload<{ code: string }>(stolen)).toEqual(payload<{ code: string }>(nonexistent));
      expect(payload<{ code: string }>(stolen).code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('validation: a non-integer id path param is refused 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/notifications/not-a-number/read', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('POST read-all marks every remaining unread notification for the caller', async () => {
      await facade.notify({ templateCode: 'doctor_approved', audience: { kind: 'patient', id: fixtures.patientId } });
      await facade.notify({ templateCode: 'doctor_approved', audience: { kind: 'patient', id: fixtures.patientId } });

      const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: auth(patientToken) });
      expect(res.statusCode).toBe(201);
      expect(payload<{ marked: number }>(res).marked).toBeGreaterThan(0);

      const unread = payload<{ unread: number }>(
        await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: auth(patientToken) }),
      );
      expect(unread.unread).toBe(0);
    });

    it('a doctor and an admin each see only their own notifications, never the patient\'s', async () => {
      await facade.notify({ templateCode: 'doctor_joined', audience: { kind: 'doctor', id: fixtures.doctorId } });
      const doctorList = payload<Array<{ id: number }>>(
        await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(doctorToken) }),
      );
      expect(doctorList.length).toBeGreaterThan(0);

      const patientList = payload<Array<{ id: number }>>(
        await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(patientToken) }),
      );
      const doctorIds = new Set(doctorList.map((n) => n.id));
      expect(patientList.some((n) => doctorIds.has(n.id))).toBe(false);
    });

    it('validation: limit above the configured max is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notifications?limit=100000', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401 for every inbox route', async () => {
      const list = await app.inject({ method: 'GET', url: '/api/notifications' });
      const count = await app.inject({ method: 'GET', url: '/api/notifications/unread-count' });
      const read = await app.inject({ method: 'POST', url: '/api/notifications/1/read' });
      const readAll = await app.inject({ method: 'POST', url: '/api/notifications/read-all' });
      expect(list.statusCode).toBe(401);
      expect(count.statusCode).toBe(401);
      expect(read.statusCode).toBe(401);
      expect(readAll.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* POST /notifications/device, DELETE /notifications/device                */
  /* ====================================================================== */

  describe('device token registration — patient/doctor only, one token per account', () => {
    it('a patient registers a device; the token is stored, then cleared on unregister', async () => {
      const token = `fcm-token-${randomUUID()}`;
      const registered = await app.inject({
        method: 'POST',
        url: '/api/notifications/device',
        headers: auth(patientToken),
        payload: { pushToken: token, deviceId: 'device-a' },
      });
      expect(registered.statusCode).toBe(201);
      expect(payload<{ registered: boolean }>(registered).registered).toBe(true);

      const [row] = await db.select({ pushToken: patientsTable.pushToken }).from(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
      expect(row.pushToken).toBe(token);

      const unregistered = await app.inject({ method: 'DELETE', url: '/api/notifications/device', headers: auth(patientToken) });
      expect(unregistered.statusCode).toBe(204);
      const [after] = await db.select({ pushToken: patientsTable.pushToken }).from(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
      expect(after.pushToken).toBeNull();
    });

    it('the same physical token registered by a second patient moves to them and is cleared from the first', async () => {
      const sharedToken = `fcm-token-shared-${randomUUID()}`;
      await app.inject({ method: 'POST', url: '/api/notifications/device', headers: auth(patientToken), payload: { pushToken: sharedToken } });

      const stolen = await app.inject({ method: 'POST', url: '/api/notifications/device', headers: auth(patient2Token), payload: { pushToken: sharedToken } });
      expect(stolen.statusCode).toBe(201);

      const [first] = await db.select({ pushToken: patientsTable.pushToken }).from(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
      const [second] = await db.select({ pushToken: patientsTable.pushToken }).from(patientsTable).where(eq(patientsTable.id, fixtures.patient2Id));
      expect(first.pushToken).not.toBe(sharedToken);
      expect(second.pushToken).toBe(sharedToken);
    });

    it('a doctor may also register a device', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifications/device',
        headers: auth(doctorToken),
        payload: { pushToken: `fcm-doctor-token-${randomUUID()}` },
      });
      expect(res.statusCode).toBe(201);
    });

    it('an admin has no push channel: registering (and unregistering) is refused 403 WRONG_ACCOUNT_TYPE, per notifications.admin_id\'s own rule', async () => {
      const register = await app.inject({
        method: 'POST',
        url: '/api/notifications/device',
        headers: auth(adminNoPermToken),
        payload: { pushToken: `fcm-admin-token-${randomUUID()}` },
      });
      expect(register.statusCode).toBe(403);
      expect(payload<{ code: string }>(register).code).toBe('WRONG_ACCOUNT_TYPE');

      const unregister = await app.inject({ method: 'DELETE', url: '/api/notifications/device', headers: auth(adminNoPermToken) });
      expect(unregister.statusCode).toBe(403);
    });

    it('validation: a pushToken shorter than 16 characters is refused 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/notifications/device', headers: auth(patientToken), payload: { pushToken: 'short' } });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401 for both routes', async () => {
      const register = await app.inject({ method: 'POST', url: '/api/notifications/device', payload: { pushToken: `fcm-anon-${randomUUID()}` } });
      const unregister = await app.inject({ method: 'DELETE', url: '/api/notifications/device' });
      expect(register.statusCode).toBe(401);
      expect(unregister.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Admin: GET/PUT/DELETE /admin/notifications/templates                    */
  /* ====================================================================== */

  describe('admin notification-template CRUD — permission-gated on content.manage_notification_templates', () => {
    it('GET templates: 403 without the permission, 200 with it, includes the compiled-in defaults', async () => {
      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminNoPermToken) });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const withPerm = await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminTemplateEditorToken) });
      expect(withPerm.statusCode).toBe(200);
      const templates = payload<Array<{ code: string; source: string }>>(withPerm);
      expect(templates.some((t) => t.code === 'booking_confirmed')).toBe(true);
    });

    /**
     * *** A RUN-UNIQUE CODE, NOT ONE OF THE NINE REAL SEEDED CODES. ***
     *
     * `notification.seed.ts` writes ALL NINE compiled-in templates into the
     * one `notifications.templates` `app_config` row at seed time (so the
     * panel is non-empty "from day one") — which this shared database has
     * already had run against it. That pre-population means
     * `listForAdmin()`'s `source` is 'custom' for every one of the nine
     * codes FOREVER after a seed run, never 'default', which contradicts
     * this file's own doc comment ("default = compiled-in, no app_config
     * entry yet"). See API_TEST_FINDINGS.md — a real discrepancy, logged as
     * found-not-fixed rather than patched here. Using a fresh code side-steps
     * it entirely (a code an admin only just added is unambiguously
     * `source: 'custom'` before, and unambiguously gone/`null` after delete,
     * since it was never in the compiled-in defaults) AND avoids mutating a
     * real, shared production template code that other tests/deployments
     * read.
     */
    it('PUT creates/edits custom copy under a NEW code; DELETE removes it entirely (no compiled-in default to fall back to)', async () => {
      const freshCode = `endpoint_test_${fixtures.runId}`;

      const updated = await app.inject({
        method: 'PUT',
        url: `/api/admin/notifications/templates/${freshCode}`,
        headers: auth(adminTemplateEditorToken),
        payload: { title: 'Edited Title For Test', body: 'Edited body copy for the endpoint test.' },
      });
      expect(updated.statusCode).toBe(200);
      const updatedBody = payload<{ code: string; title: string; source: string }>(updated);
      expect(updatedBody.title).toBe('Edited Title For Test');
      expect(updatedBody.source).toBe('custom');

      const listedAfterPut = payload<Array<{ code: string }>>(
        await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminTemplateEditorToken) }),
      );
      expect(listedAfterPut.some((t) => t.code === freshCode)).toBe(true);

      const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/notifications/templates/${freshCode}`, headers: auth(adminTemplateEditorToken) });
      expect(deleted.statusCode).toBe(200);
      // Not one of the nine schema-named codes, so there is no compiled-in
      // default to fall back to — deleting it is a true delete, not a revert.
      expect(payload<unknown>(deleted)).toBeNull();

      const listedAfterDelete = payload<Array<{ code: string }>>(
        await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminTemplateEditorToken) }),
      );
      expect(listedAfterDelete.some((t) => t.code === freshCode)).toBe(false);
    });

    it('PUT/DELETE: 403 without the permission (nothing is written)', async () => {
      const freshCode = `endpoint_test_noperm_${fixtures.runId}`;
      const put = await app.inject({
        method: 'PUT',
        url: `/api/admin/notifications/templates/${freshCode}`,
        headers: auth(adminNoPermToken),
        payload: { title: 'x', body: 'y' },
      });
      expect(put.statusCode).toBe(403);

      const del = await app.inject({ method: 'DELETE', url: `/api/admin/notifications/templates/${freshCode}`, headers: auth(adminNoPermToken) });
      expect(del.statusCode).toBe(403);

      const list = payload<Array<{ code: string }>>(
        await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminTemplateEditorToken) }),
      );
      expect(list.some((t) => t.code === freshCode)).toBe(false);
    });

    it('FR-16.2: a template CODE naming a diagnosis is refused 409, and nothing is written', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/notifications/templates/you_have_diabetes',
        headers: auth(adminTemplateEditorToken),
        payload: { title: 'Reminder', body: 'Please open the app.' },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS');

      const list = await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(adminTemplateEditorToken) });
      expect(payload<Array<{ code: string }>>(list).some((t) => t.code === 'you_have_diabetes')).toBe(false);
    });

    it('FR-16.2: copy (title/body) naming a diagnosis is refused 409, even under an innocuous code', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/notifications/templates/harmless_code_name',
        headers: auth(adminTemplateEditorToken),
        payload: { title: 'Reminder', body: 'Your diabetes review is due tomorrow.' },
      });
      expect(res.statusCode).toBe(409);
      expect(payload<{ code: string }>(res).code).toBe('NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS');
    });

    it('validation: a malformed :code path param is refused 400 before the service runs', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/notifications/templates/NotValid-Code!',
        headers: auth(adminTemplateEditorToken),
        payload: { title: 'x', body: 'y' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('validation: an empty title is refused 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/notifications/templates/checkin_due',
        headers: auth(adminTemplateEditorToken),
        payload: { title: '', body: 'Body text.' },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('DELETE on a code with no stored override 404s TEMPLATE_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/notifications/templates/never_stored_${fixtures.runId}`,
        headers: auth(adminTemplateEditorToken),
      });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('NOTIFICATION_TEMPLATE_NOT_FOUND');
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/notifications/templates' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/notifications/templates', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });
});
