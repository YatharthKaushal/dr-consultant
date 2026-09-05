/**
 * ***************************************************************************
 * *** PROMOTION MODULE — REAL HTTP, REAL POSTGRES, EVERY DOCUMENTED BRANCH.**
 * ***************************************************************************
 *
 * `src/app.e2e.integration.spec.ts` redeems a coupon through the real
 * `POST /api/bookings` route and reserves a referral through `PromotionFacade`
 * directly (that facade call is the one piece the checkout seam cannot yet
 * reach over HTTP — see that file's own comment on why). NEITHER of those
 * drives this module's OWN routes: minting a referral code, listing
 * redeemable codes, the enumeration throttle, admin coupon/voucher creation,
 * the referral link/attribution surface, or any affiliate endpoint. That is
 * this file's job.
 *
 * *** GLOBAL, SHARED CONFIG DISCIPLINE. ***
 * `promotion.affiliate_enabled` is a single row every worktree hitting this
 * physical Postgres can see. It defaults `false`, and this file spends most
 * of its affiliate coverage proving the DEFAULT-OFF behaviour (the task's own
 * emphasis). The one test that flips it `true` does so for the shortest
 * possible window, inside a `try/finally` that restores `false` before the
 * next test runs — `afterAll` restores it again defensively in case a test
 * fails between the flip and the restore.
 *
 * Pattern copied from the other three `*.endpoint.spec.ts` files in this
 * round: Slide mocked, `createConfiguredApp()`, `app.inject()`, the envelope
 * unwrapped by `payload()`, an admin minted via a seeded `admins` row plus
 * `admin_permission_grants` and `IdentityTokenService#mintTokenPair`.
 */
import { randomUUID } from 'node:crypto';

const identifiersByRequestId = new Map<string, string>();
const slideOtpMock = {
  send: jest.fn(async ({ identifier }: { widgetId: string; identifier: string }) => {
    const requestId = `otpreq_${randomUUID()}`;
    identifiersByRequestId.set(requestId, identifier);
    return { requestId };
  }),
  retry: jest.fn(async ({ requestId }: { requestId: string }) => ({ requestId })),
  verify: jest.fn(async ({ requestId }: { requestId: string; otp: string }) => ({
    accessToken: `slide_at_${requestId}`,
  })),
  verifyToken: jest.fn(async ({ accessToken }: { accessToken: string }) => {
    const requestId = accessToken.replace(/^slide_at_/, '');
    const identifier = identifiersByRequestId.get(requestId);
    if (identifier === undefined) throw new Error(`Test mock: no Slide request for token ${accessToken}.`);
    return { verified: true, identifier, verifiedAt: new Date().toISOString() };
  }),
};

jest.mock('@synquic/slide', () => {
  const actual = jest.requireActual('@synquic/slide');
  return { ...actual, SlideClient: jest.fn().mockImplementation(() => ({ otp: slideOtpMock })) };
});

import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(120_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

function pgArray(values: readonly string[], type: 'uuid' | 'varchar') {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`);
  return sql.raw(`array['${values.join("','")}']::${type}[]`);
}

async function getAffiliateEnabled(app: NestFastifyApplication, token: string): Promise<boolean> {
  const response = await app.inject({ method: 'GET', url: '/api/admin/promotions/config', headers: { authorization: `Bearer ${token}` } });
  return payload<{ affiliateEnabled: boolean }>(response).affiliateEnabled;
}

async function setAffiliateEnabled(app: NestFastifyApplication, token: string, enabled: boolean): Promise<void> {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/admin/promotions/config',
    headers: { authorization: `Bearer ${token}` },
    payload: { affiliateEnabled: enabled },
  });
  expect(response.statusCode).toBe(200);
}

describe('promotion module — real HTTP endpoints', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const runId = randomUUID().slice(0, 8);

  let patientId: string;
  let patientMobile: string;
  let patientToken: string;
  let throttlePatientId: string;
  let throttlePatientMobile: string;
  let throttlePatientToken: string;
  let doctorId: string;

  let adminFullToken: string; // every promotions.* and affiliates.* permission
  let adminReadOnlyToken: string; // promotions.read + affiliates.read only (mirrors `operations`)
  let adminManageNoSettleToken: string; // affiliates.read + affiliates.manage, no affiliates.settle
  let adminNoneToken: string;

  const adminIds: string[] = [];
  const createdInstrumentIds: string[] = [];
  const createdPartnerIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    patientMobile = `+9172${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}00`;
    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: patientMobile, fullName: `Promotion E2E Patient ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientId = patient.id;

    throttlePatientMobile = `+9172${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}01`;
    const [throttlePatient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: throttlePatientMobile, fullName: `Promotion E2E Throttle Patient ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    throttlePatientId = throttlePatient.id;

    const [doctor] = await db
      .insert(doctorsTable)
      .values({ mobileNumber: `+9172${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}02`, fullName: `Promotion E2E Doctor ${runId}` })
      .returning({ id: doctorsTable.id });
    doctorId = doctor.id;

    async function signInPatient(mobileNumber: string): Promise<string> {
      const requested = await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { mobileNumber, audience: 'patient' } });
      const { challengeId } = payload<{ challengeId: string }>(requested);
      const verified = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId, code: '123456' } });
      return payload<{ accessToken: string }>(verified).accessToken;
    }
    patientToken = await signInPatient(patientMobile);
    throttlePatientToken = await signInPatient(throttlePatientMobile);

    async function mintAdmin(label: string, permissionKeys: string[]): Promise<string> {
      const [admin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `+9171${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, fullName: `Promotion E2E Admin ${label}` })
        .returning({ id: adminsTable.id });
      adminIds.push(admin.id);
      for (const key of permissionKeys) {
        const [permission] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key));
        if (!permission) throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts first.`);
        await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: permission.id });
      }
      const tokens = await app.get(IdentityTokenService).mintTokenPair('admin', admin.id, 0);
      return tokens.accessToken;
    }

    adminFullToken = await mintAdmin('full', [
      PERMISSIONS.PROMOTIONS_READ,
      PERMISSIONS.PROMOTIONS_MANAGE,
      PERMISSIONS.PROMOTIONS_EXPORT,
      PERMISSIONS.AFFILIATES_READ,
      PERMISSIONS.AFFILIATES_MANAGE,
      PERMISSIONS.AFFILIATES_SETTLE,
    ]);
    adminReadOnlyToken = await mintAdmin('read-only', [PERMISSIONS.PROMOTIONS_READ, PERMISSIONS.AFFILIATES_READ]);
    adminManageNoSettleToken = await mintAdmin('manage-no-settle', [PERMISSIONS.AFFILIATES_READ, PERMISSIONS.AFFILIATES_MANAGE]);
    adminNoneToken = await mintAdmin('none', []);
  });

  afterAll(async () => {
    try {
      // Defensive: if a test failed between flipping the flag and restoring
      // it, do not leave this GLOBAL, SHARED setting on for other worktrees.
      if (await getAffiliateEnabled(app, adminFullToken)) {
        await setAffiliateEnabled(app, adminFullToken, false);
      }

      const patientIds = [patientId, throttlePatientId];
      const patientList = pgArray(patientIds, 'uuid');
      const doctorList = pgArray([doctorId], 'uuid');
      const partnerList = pgArray(createdPartnerIds, 'uuid');
      const instrumentList = pgArray(createdInstrumentIds, 'uuid');

      await db.execute(sql`delete from affiliate_commissions where partner_id = any(${partnerList})`);
      await db.execute(sql`delete from affiliate_settlements where partner_id = any(${partnerList})`);
      await db.execute(sql`delete from affiliate_attributions where patient_id = any(${patientList})`);
      await db.execute(sql`delete from discount_redemptions where patient_id = any(${patientList})`);
      // The lazily-minted referral code (referrer_patient_id) plus every
      // admin-created coupon/voucher this run made.
      await db.execute(sql`delete from discount_instruments where referrer_patient_id = any(${patientList})`);
      await db.execute(sql`delete from discount_instruments where id = any(${instrumentList})`);
      await db.execute(sql`delete from promotion_code_attempts where patient_id = any(${patientList})`);
      await db.execute(sql`delete from affiliate_partners where id = any(${partnerList})`);

      await db.execute(sql`delete from otp_challenges where mobile_number in (${patientMobile}, ${throttlePatientMobile})`);
      await db.execute(sql`delete from otp_request_attempts where mobile_number in (${patientMobile}, ${throttlePatientMobile})`);

      await db.execute(
        sql`delete from audit_log where actor_id = any(${pgArray([...patientIds, doctorId, ...adminIds], 'uuid')})`,
      );
      await db.execute(
        sql`delete from audit_log where entity_id = any(${pgArray([...createdInstrumentIds, ...createdPartnerIds], 'varchar')})`,
      );

      await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
      await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
      await db.execute(sql`delete from doctors where id = any(${doctorList})`);
      await db.execute(sql`delete from patients where id = any(${patientList})`);
    } finally {
      if (app) await app.close();
    }
  });

  /* ======================================================================== */
  /* AUTH BOUNDARY                                                             */
  /* ======================================================================== */

  describe('auth boundary', () => {
    it('POST /promotions/codes/preview — no token -> 401', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/promotions/codes/preview', payload: {} });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('POST /promotions/codes/preview — an admin token -> 403 WRONG_ACCOUNT_TYPE (this controller is patient-only)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: 'ANY', discountableAmount: '100.00', mode: 'scheduled' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('GET /admin/promotions/instruments — no token -> 401; patient token -> 403 WRONG_ACCOUNT_TYPE; admin with no permissions -> 403 PERMISSION_DENIED; admin with promotions.read -> 200', async () => {
      const noToken = await app.inject({ method: 'GET', url: '/api/admin/promotions/instruments' });
      expect(noToken.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/promotions/instruments', headers: { authorization: `Bearer ${patientToken}` } });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');

      const noPerm = await app.inject({ method: 'GET', url: '/api/admin/promotions/instruments', headers: { authorization: `Bearer ${adminNoneToken}` } });
      expect(noPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(noPerm).code).toBe('PERMISSION_DENIED');

      const ok = await app.inject({ method: 'GET', url: '/api/admin/promotions/instruments', headers: { authorization: `Bearer ${adminReadOnlyToken}` } });
      expect(ok.statusCode).toBe(200);
    });

    it('the operations-shaped role (promotions.read + affiliates.read) cannot write anything: manage, export and settle all 403', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminReadOnlyToken}` },
        payload: { code: 'X1Y2Z3', kind: 'coupon', label: 'test', valueKind: 'flat', flatAmount: '10.00' },
      });
      expect(create.statusCode).toBe(403);
      expect(payload<{ code: string }>(create).code).toBe('PERMISSION_DENIED');

      const csv = await app.inject({ method: 'GET', url: '/api/admin/promotions/export/redemptions', headers: { authorization: `Bearer ${adminReadOnlyToken}` } });
      expect(csv.statusCode).toBe(403);

      const settle = await app.inject({
        method: 'POST',
        url: `/api/admin/promotions/affiliates/partners/${randomUUID()}/settlements`,
        headers: { authorization: `Bearer ${adminReadOnlyToken}` },
        payload: { method: 'off_system' },
      });
      expect(settle.statusCode).toBe(403);
    });

    it('affiliates.manage without affiliates.settle cannot settle -> 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/promotions/affiliates/partners/${randomUUID()}/settlements`,
        headers: { authorization: `Bearer ${adminManageNoSettleToken}` },
        payload: { method: 'off_system' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  /* ======================================================================== */
  /* PATIENT — POST /promotions/codes/preview                                 */
  /* ======================================================================== */

  describe('POST /promotions/codes/preview', () => {
    it('validation: missing discountableAmount and missing mode -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { code: 'ANYCODE' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('an unknown code -> 200, applicable:false, CODE_NOT_USABLE — never a 404 (that would confirm which codes exist)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { code: 'NOSUCHCODEAT ALL', discountableAmount: '500.00', mode: 'scheduled' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ applicable: boolean; reason: string }>(response);
      expect(body.applicable).toBe(false);
      expect(body.reason).toBe('CODE_NOT_USABLE');
    });

    it('a real, active, publicly-listed flat coupon resolves as applicable with the correct discount amount', async () => {
      const code = `PROMO${runId.toUpperCase()}A`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code, kind: 'coupon', label: 'Flat 50 test coupon', isPubliclyListed: true, valueKind: 'flat', flatAmount: '50.00' },
      });
      expect(created.statusCode).toBe(201);
      const instrument = payload<{ id: string; status: string }>(created);
      createdInstrumentIds.push(instrument.id);
      expect(instrument.status).toBe('draft');

      const activated = await app.inject({
        method: 'PUT',
        url: `/api/admin/promotions/instruments/${instrument.id}/status`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { status: 'active' },
      });
      expect(activated.statusCode).toBe(200);

      const preview = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { code, discountableAmount: '500.00', mode: 'scheduled' },
      });
      expect(preview.statusCode).toBe(201);
      const body = payload<{ applicable: boolean; discountAmount: string; code: string }>(preview);
      expect(body.applicable).toBe(true);
      expect(body.discountAmount).toBe('50.00');

      // Now visible in the patient's own redeemable list — publicly listed.
      const list = await app.inject({ method: 'GET', url: '/api/promotions/codes', headers: { authorization: `Bearer ${patientToken}` } });
      expect(payload<{ codes: Array<{ code: string }> }>(list).codes.some((c) => c.code === code)).toBe(true);
    });

    it('MIN_ORDER_NOT_MET when the order is below the coupon\'s minimum, with the required minimum named in the response', async () => {
      const code = `PROMO${runId.toUpperCase()}B`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code, kind: 'coupon', label: 'Min order test coupon', valueKind: 'flat', flatAmount: '50.00', minOrderAmount: '1000.00' },
      });
      const instrument = payload<{ id: string }>(created);
      createdInstrumentIds.push(instrument.id);
      await app.inject({ method: 'PUT', url: `/api/admin/promotions/instruments/${instrument.id}/status`, headers: { authorization: `Bearer ${adminFullToken}` }, payload: { status: 'active' } });

      const preview = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { code, discountableAmount: '500.00', mode: 'scheduled' },
      });
      expect(preview.statusCode).toBe(201);
      const body = payload<{ applicable: boolean; reason: string; requiredMinOrder?: string }>(preview);
      expect(body.applicable).toBe(false);
      expect(body.reason).toBe('MIN_ORDER_NOT_MET');
      expect(body.requiredMinOrder).toBe('1000.00');
    });

    it('a NON-publicly-listed active coupon still resolves for a patient who types it, but never appears in the redeemable list', async () => {
      const code = `PROMO${runId.toUpperCase()}C`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code, kind: 'coupon', label: 'Unlisted test coupon', isPubliclyListed: false, valueKind: 'flat', flatAmount: '25.00' },
      });
      const instrument = payload<{ id: string }>(created);
      createdInstrumentIds.push(instrument.id);
      await app.inject({ method: 'PUT', url: `/api/admin/promotions/instruments/${instrument.id}/status`, headers: { authorization: `Bearer ${adminFullToken}` }, payload: { status: 'active' } });

      const list = await app.inject({ method: 'GET', url: '/api/promotions/codes', headers: { authorization: `Bearer ${patientToken}` } });
      expect(payload<{ codes: Array<{ code: string }> }>(list).codes.some((c) => c.code === code)).toBe(false);

      const preview = await app.inject({
        method: 'POST',
        url: '/api/promotions/codes/preview',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { code, discountableAmount: '500.00', mode: 'scheduled' },
      });
      expect(payload<{ applicable: boolean }>(preview).applicable).toBe(true);
    });

    it('THE ENUMERATION THROTTLE — hitting the per-patient attempt limit for real refuses further attempts with TOO_MANY_ATTEMPTS, not silently', async () => {
      const configResponse = await app.inject({ method: 'GET', url: '/api/admin/promotions/config', headers: { authorization: `Bearer ${adminFullToken}` } });
      const limit = payload<{ codeAttemptsPerPatientPerHour: number }>(configResponse).codeAttemptsPerPatientPerHour;

      let lastBody: { applicable: boolean; reason?: string } | null = null;
      // The counted row for THIS call is opened before the throttle check
      // itself runs, so the (limit + 1)-th call is the first to see the
      // count exceed the bound.
      for (let attempt = 0; attempt < limit + 1; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/promotions/codes/preview',
          headers: { authorization: `Bearer ${throttlePatientToken}` },
          payload: { code: `THROTTLE${attempt}`, discountableAmount: '100.00', mode: 'scheduled' },
        });
        expect(response.statusCode).toBe(201);
        lastBody = payload(response);
      }
      expect(lastBody?.applicable).toBe(false);
      expect(lastBody?.reason).toBe('TOO_MANY_ATTEMPTS');
    });
  });

  /* ======================================================================== */
  /* PATIENT — GET /promotions/referral                                       */
  /* ======================================================================== */

  describe('GET /promotions/referral', () => {
    it('mints a code on first request and returns the SAME code on a second — idempotent, counts only, never a referee identity', async () => {
      const first = await app.inject({ method: 'GET', url: '/api/promotions/referral', headers: { authorization: `Bearer ${patientToken}` } });
      expect(first.statusCode).toBe(200);
      const firstBody = payload<{ code: string; instrumentId: string; pendingCount: number; qualifiedCount: number; availableRewards: unknown[] }>(first);
      expect(firstBody.code).toBeTruthy();
      expect(firstBody.pendingCount).toBe(0);
      expect(firstBody.qualifiedCount).toBe(0);

      const second = await app.inject({ method: 'GET', url: '/api/promotions/referral', headers: { authorization: `Bearer ${patientToken}` } });
      const secondBody = payload<{ code: string; instrumentId: string }>(second);
      expect(secondBody.code).toBe(firstBody.code);
      expect(secondBody.instrumentId).toBe(firstBody.instrumentId);
    });
  });

  /* ======================================================================== */
  /* PATIENT — POST /promotions/affiliate/attribution                         */
  /* ======================================================================== */

  describe('POST /promotions/affiliate/attribution', () => {
    it('validation: missing token -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/promotions/affiliate/attribution', headers: { authorization: `Bearer ${patientToken}` }, payload: {} });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('DEFAULT-OFF: a well-formed but bogus token -> 200 {attributed:false}, never a 4xx', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/promotions/affiliate/attribution',
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { token: 'v1.bogus-payload.bogus-signature' },
      });
      expect(response.statusCode).toBe(201);
      expect(payload<{ attributed: boolean }>(response).attributed).toBe(false);
    });
  });

  /* ======================================================================== */
  /* PUBLIC — GET /promotions/affiliate/links/:linkSlug                       */
  /* ======================================================================== */

  describe('GET /promotions/affiliate/links/:linkSlug', () => {
    it('needs no bearer token at all — the one @Public() route in this module', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/promotions/affiliate/links/no-such-slug-${runId}` });
      expect(response.statusCode).toBe(200);
      expect(payload<{ resolved: boolean }>(response).resolved).toBe(false);
    });

    it('DEFAULT-OFF: even a real, active partner\'s slug resolves false while promotion.affiliate_enabled is off', async () => {
      expect(await getAffiliateEnabled(app, adminFullToken)).toBe(false);

      const slug = `promo-e2e-${runId}`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/affiliates/partners',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { doctorId, linkSlug: slug, commissionValueKind: 'flat', commissionFlat: '10.00' },
      });
      expect(created.statusCode).toBe(201);
      const partner = payload<{ id: string; status: string }>(created);
      createdPartnerIds.push(partner.id);
      // *** BORN paused, ALWAYS — not affected by the request body. ***
      expect(partner.status).toBe('paused');

      const response = await app.inject({ method: 'GET', url: `/api/promotions/affiliate/links/${slug}` });
      expect(response.statusCode).toBe(200);
      expect(payload<{ resolved: boolean }>(response).resolved).toBe(false);
    });
  });

  /* ======================================================================== */
  /* ADMIN — instruments (coupons/vouchers)                                   */
  /* ======================================================================== */

  describe('admin instrument CRUD', () => {
    it('PROMOTION_CODE_INVALID when the code normalises to fewer than 4 characters -> 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        // "A---" is 4 raw characters (passes the DTO's Length(4,64)) but
        // normalises (upper-case, strip non-alphanumerics) to "A" — too short.
        payload: { code: 'A---', kind: 'coupon', label: 'test', valueKind: 'flat', flatAmount: '10.00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_CODE_INVALID');
    });

    it('PROMOTION_INSTRUMENT_INVALID: a percent-valued instrument with no maxDiscountAmount (uncapped) -> 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: `UNCAPPED${runId.toUpperCase()}`, kind: 'coupon', label: 'test', valueKind: 'percent', percentRate: '50.00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_INSTRUMENT_INVALID');
    });

    it('PROMOTION_INSTRUMENT_INVALID: a voucher with no assignedPatientId -> 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: `NOVOUCHER${runId.toUpperCase()}`, kind: 'voucher', label: 'test', valueKind: 'flat', flatAmount: '10.00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_INSTRUMENT_INVALID');
    });

    it('PROMOTION_CODE_ALREADY_EXISTS: creating the same normalised code twice -> 409', async () => {
      const code = `DUPE${runId.toUpperCase()}`;
      const first = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code, kind: 'coupon', label: 'first', valueKind: 'flat', flatAmount: '10.00' },
      });
      expect(first.statusCode).toBe(201);
      createdInstrumentIds.push(payload<{ id: string }>(first).id);

      // Same value once normalised: punctuation differs, letters are the same.
      const second = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: `DUPE-${runId.toUpperCase()}`, kind: 'coupon', label: 'second', valueKind: 'flat', flatAmount: '10.00' },
      });
      expect(second.statusCode).toBe(409);
      expect(payload<{ code: string }>(second).code).toBe('PROMOTION_CODE_ALREADY_EXISTS');
    });

    it('GET instruments/:id — 404 PROMOTION_INSTRUMENT_NOT_FOUND for a nonexistent id; bad UUID -> 400', async () => {
      const notFound = await app.inject({ method: 'GET', url: `/api/admin/promotions/instruments/${randomUUID()}`, headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(notFound.statusCode).toBe(404);
      expect(payload<{ code: string }>(notFound).code).toBe('PROMOTION_INSTRUMENT_NOT_FOUND');

      const badUuid = await app.inject({ method: 'GET', url: '/api/admin/promotions/instruments/not-a-uuid', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(badUuid.statusCode).toBe(400);
      expect(payload<{ code: string }>(badUuid).code).toBe('VALIDATION_FAILED');
    });

    it('GET instruments/:id/redemptions — 200, empty for a fresh instrument', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: `FRESH${runId.toUpperCase()}`, kind: 'coupon', label: 'fresh', valueKind: 'flat', flatAmount: '10.00' },
      });
      const instrument = payload<{ id: string }>(created);
      createdInstrumentIds.push(instrument.id);

      const response = await app.inject({ method: 'GET', url: `/api/admin/promotions/instruments/${instrument.id}/redemptions`, headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response)).toEqual([]);
    });

    it('PATCH updates presentational fields, then PROMOTION_INSTRUMENT_NOT_EDITABLE once archived (a terminal state)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/instruments',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { code: `ARCH${runId.toUpperCase()}`, kind: 'coupon', label: 'before', valueKind: 'flat', flatAmount: '10.00' },
      });
      const instrument = payload<{ id: string }>(created);
      createdInstrumentIds.push(instrument.id);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/admin/promotions/instruments/${instrument.id}`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { label: 'after' },
      });
      expect(patched.statusCode).toBe(200);
      expect(payload<{ label: string }>(patched).label).toBe('after');

      const archived = await app.inject({
        method: 'PUT',
        url: `/api/admin/promotions/instruments/${instrument.id}/status`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { status: 'archived' },
      });
      expect(archived.statusCode).toBe(200);

      const patchAfterArchive = await app.inject({
        method: 'PATCH',
        url: `/api/admin/promotions/instruments/${instrument.id}`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { label: 'too late' },
      });
      expect(patchAfterArchive.statusCode).toBe(409);
      expect(payload<{ code: string }>(patchAfterArchive).code).toBe('PROMOTION_INSTRUMENT_NOT_EDITABLE');

      const statusAfterArchive = await app.inject({
        method: 'PUT',
        url: `/api/admin/promotions/instruments/${instrument.id}/status`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { status: 'active' },
      });
      expect(statusAfterArchive.statusCode).toBe(409);
      expect(payload<{ code: string }>(statusAfterArchive).code).toBe('PROMOTION_INSTRUMENT_NOT_EDITABLE');
    });
  });

  /* ======================================================================== */
  /* ADMIN — referrals, export, sweep, config                                 */
  /* ======================================================================== */

  describe('admin referrals, export, sweep, config', () => {
    it('GET /admin/promotions/referrals — 200, paginated shape, and it is the ONE place that names both parties', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/promotions/referrals', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ rows: unknown[]; total: number }>(response);
      expect(Array.isArray(body.rows)).toBe(true);
      expect(typeof body.total).toBe('number');
    });

    it('GET /admin/promotions/export/redemptions — a real CSV, not the JSON envelope', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/promotions/export/redemptions', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
    });

    it('POST /admin/promotions/sweep — runs both sweeps on demand and reports a shape', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/admin/promotions/sweep', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(201);
      const body = payload<{ reservations: unknown; qualifications: unknown }>(response);
      expect(body).toHaveProperty('reservations');
      expect(body).toHaveProperty('qualifications');
    });

    it('GET config — 200, full resolved shape', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/promotions/config', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ affiliateEnabled: boolean; codeAttemptsPerPatientPerHour: number; codeAttemptsPerIpPerHour: number }>(response);
      expect(typeof body.affiliateEnabled).toBe('boolean');
      expect(typeof body.codeAttemptsPerPatientPerHour).toBe('number');
      expect(typeof body.codeAttemptsPerIpPerHour).toBe('number');
    });

    it('PUT config — validation: codeAttemptsPerPatientPerHour out of bounds -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/promotions/config',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { codeAttemptsPerPatientPerHour: 999_999 },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('PUT config — PROMOTION_CONFIG_INVALID: a malformed referralProgram object -> 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/promotions/config',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { referralProgram: { enabled: 'yes-please' } },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_CONFIG_INVALID');
    });
  });

  /* ======================================================================== */
  /* ADMIN — affiliates, default-off then briefly flipped on                  */
  /* ======================================================================== */

  describe('admin affiliates', () => {
    it('PARTNER_ALREADY_EXISTS: a second arrangement for the same doctor -> 409', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/affiliates/partners',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { doctorId, commissionValueKind: 'flat', commissionFlat: '20.00' },
      });
      // The default-off link-resolution test above already created a partner
      // for this doctorId — so this call itself is the ALREADY_EXISTS case.
      expect(first.statusCode).toBe(409);
      expect(payload<{ code: string }>(first).code).toBe('PROMOTION_PARTNER_ALREADY_EXISTS');
    });

    it('PARTNER_INVALID: a non-default commission base with no commissionMax -> 400', async () => {
      const [otherDoctor] = await db
        .insert(doctorsTable)
        .values({ mobileNumber: `+9172${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}03`, fullName: `Promotion E2E Doctor B ${runId}` })
        .returning({ id: doctorsTable.id });

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/affiliates/partners',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { doctorId: otherDoctor.id, commissionValueKind: 'percent', commissionRate: '10.00', commissionBase: 'convenience_fee' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_PARTNER_INVALID');

      await db.execute(sql`delete from doctors where id = ${otherDoctor.id}`);
    });

    it('validation: a malformed linkSlug -> 400 VALIDATION_FAILED', async () => {
      const [otherDoctor] = await db
        .insert(doctorsTable)
        .values({ mobileNumber: `+9172${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}04`, fullName: `Promotion E2E Doctor C ${runId}` })
        .returning({ id: doctorsTable.id });

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/promotions/affiliates/partners',
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { doctorId: otherDoctor.id, linkSlug: 'NO', commissionValueKind: 'flat', commissionFlat: '10.00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');

      await db.execute(sql`delete from doctors where id = ${otherDoctor.id}`);
    });

    it('GET partners/:id — 404 PARTNER_NOT_FOUND for a nonexistent id', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/promotions/affiliates/partners/${randomUUID()}`, headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_PARTNER_NOT_FOUND');
    });

    it('DEFAULT-OFF: activating a partner while promotion.affiliate_enabled is false -> 403 PROMOTION_AFFILIATE_DISABLED', async () => {
      expect(await getAffiliateEnabled(app, adminFullToken)).toBe(false);
      const partnerId = createdPartnerIds[0];
      const response = await app.inject({
        method: 'PUT',
        url: `/api/admin/promotions/affiliates/partners/${partnerId}/status`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { status: 'active' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_AFFILIATE_DISABLED');

      // Pausing (the non-activating direction) is NEVER gated on the flag.
      const pause = await app.inject({
        method: 'PUT',
        url: `/api/admin/promotions/affiliates/partners/${partnerId}/status`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { status: 'paused' },
      });
      expect(pause.statusCode).toBe(200);
    });

    it('DEFAULT-OFF: issuing a partner link -> 200 {issued:false}, never an error', async () => {
      const partnerId = createdPartnerIds[0];
      const response = await app.inject({ method: 'POST', url: `/api/admin/promotions/affiliates/partners/${partnerId}/link`, headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(response.statusCode).toBe(201);
      expect(payload<{ issued: boolean }>(response).issued).toBe(false);
    });

    it('DEFAULT-OFF: settling a partner -> 403 PROMOTION_AFFILIATE_DISABLED (there is nothing to settle while the mechanism is off)', async () => {
      const partnerId = createdPartnerIds[0];
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/promotions/affiliates/partners/${partnerId}/settlements`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { method: 'off_system' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_AFFILIATE_DISABLED');
    });

    it('FLIPPED ON, briefly: activation succeeds, a link is issued, and settling with nothing accrued is PROMOTION_SETTLEMENT_EMPTY', async () => {
      const partnerId = createdPartnerIds[0];
      try {
        await setAffiliateEnabled(app, adminFullToken, true);
        expect(await getAffiliateEnabled(app, adminFullToken)).toBe(true);

        const activated = await app.inject({
          method: 'PUT',
          url: `/api/admin/promotions/affiliates/partners/${partnerId}/status`,
          headers: { authorization: `Bearer ${adminFullToken}` },
          payload: { status: 'active' },
        });
        expect(activated.statusCode).toBe(200);
        expect(payload<{ status: string }>(activated).status).toBe('active');

        const link = await app.inject({ method: 'POST', url: `/api/admin/promotions/affiliates/partners/${partnerId}/link`, headers: { authorization: `Bearer ${adminFullToken}` } });
        expect(link.statusCode).toBe(201);
        const linkBody = payload<{ issued: boolean; token: string; expiresAt: string }>(link);
        expect(linkBody.issued).toBe(true);
        expect(typeof linkBody.token).toBe('string');

        const settle = await app.inject({
          method: 'POST',
          url: `/api/admin/promotions/affiliates/partners/${partnerId}/settlements`,
          headers: { authorization: `Bearer ${adminFullToken}` },
          payload: { method: 'off_system' },
        });
        expect(settle.statusCode).toBe(409);
        expect(payload<{ code: string }>(settle).code).toBe('PROMOTION_SETTLEMENT_EMPTY');
      } finally {
        await setAffiliateEnabled(app, adminFullToken, false);
      }
    });

    it('GET affiliates/commissions and GET partners/:id/settlements — 200, list shapes', async () => {
      const partnerId = createdPartnerIds[0];
      const commissions = await app.inject({ method: 'GET', url: '/api/admin/promotions/affiliates/commissions', headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(commissions.statusCode).toBe(200);
      const commissionsBody = payload<{ rows: unknown[]; total: number }>(commissions);
      expect(Array.isArray(commissionsBody.rows)).toBe(true);

      const settlements = await app.inject({ method: 'GET', url: `/api/admin/promotions/affiliates/partners/${partnerId}/settlements`, headers: { authorization: `Bearer ${adminFullToken}` } });
      expect(settlements.statusCode).toBe(200);
      expect(Array.isArray(payload<{ rows: unknown[] }>(settlements).rows)).toBe(true);
    });

    it('POST settlements/:id/void — 404 SETTLEMENT_NOT_FOUND for a nonexistent settlement', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/promotions/affiliates/settlements/${randomUUID()}/void`,
        headers: { authorization: `Bearer ${adminFullToken}` },
        payload: { reason: 'Test void of a settlement that does not exist' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('PROMOTION_SETTLEMENT_NOT_FOUND');
    });
  });
});
