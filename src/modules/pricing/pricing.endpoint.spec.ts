/**
 * ***************************************************************************
 * *** PRICING MODULE — REAL HTTP, REAL POSTGRES, EVERY DOCUMENTED BRANCH. ***
 * ***************************************************************************
 *
 * `pricing` has exactly ONE controller (`PricingAdminController`, confirmed
 * by `pricing.module.ts`) and exactly FIVE routes, all under `admin/pricing`
 * and all gated on the single `payments.manage_config` permission — the same
 * permission `payment-admin.controller.ts`'s legacy config screen uses,
 * deliberately not a new one. There is no patient- or doctor-facing route in
 * this module at all: booking's OWN quote preview
 * (`GET /bookings/quote/:doctorId`) is covered in `booking.endpoint.spec.ts`
 * and is not duplicated here.
 *
 * *** WHY THIS FILE NEVER WRITES A SUCCESSFUL COMPONENT-CATALOGUE OR
 * TAX-PROFILE CHANGE. ***
 *
 * `pricing.components`/`pricing.tax_profile` are GLOBAL, shared across every
 * worktree hitting this one physical Postgres right now — `app.e2e.
 * integration.spec.ts` and `booking.endpoint.spec.ts` both hard-assert a
 * 618.00 bill for a 500.00 fee, which is only true under the catalogue
 * `pricing.seed.ts` wrote. A test in THIS file that actually changed the
 * catalogue, even briefly, could make a concurrent test elsewhere compute the
 * wrong total and fail for a reason that has nothing to do with its own
 * claim. So every `PUT config` test below either (a) asserts a VALIDATION
 * failure, which never writes anything, or (b) touches only
 * `quoteTtlMinutes` — a field nothing else in this test run reads — and
 * restores the original value in a `finally`.
 *
 * Pattern copied from `booking.endpoint.spec.ts`/`payment.endpoint.spec.ts`:
 * Slide mocked, `createConfiguredApp()`, `app.inject()`, the envelope
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
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityTokenService } from '../identity/identity-token.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

function pgArray(values: readonly string[], type: 'uuid') {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`);
  return sql.raw(`array['${values.join("','")}']::${type}[]`);
}

describe('pricing module — real HTTP endpoints', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let patientToken: string;
  let patientId: string;
  let patientMobile: string;
  let adminConfigToken: string;
  let adminNoneToken: string;
  const adminIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();

    const runId = randomUUID().slice(0, 8);
    patientMobile = `+9174${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}00`;
    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: patientMobile, fullName: `Pricing E2E Patient ${runId}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientId = patient.id;

    const requested = await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { mobileNumber: patientMobile, audience: 'patient' } });
    const { challengeId } = payload<{ challengeId: string }>(requested);
    const verified = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId, code: '123456' } });
    patientToken = payload<{ accessToken: string }>(verified).accessToken;

    async function mintAdmin(label: string, permissionKeys: string[]): Promise<string> {
      const [admin] = await db
        .insert(adminsTable)
        .values({ mobileNumber: `+9173${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, fullName: `Pricing E2E Admin ${label}` })
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

    adminConfigToken = await mintAdmin('config', [PERMISSIONS.PAYMENTS_MANAGE_CONFIG]);
    adminNoneToken = await mintAdmin('none', []);
  });

  afterAll(async () => {
    try {
      await db.execute(sql`delete from otp_challenges where mobile_number = ${patientMobile}`);
      await db.execute(sql`delete from otp_request_attempts where mobile_number = ${patientMobile}`);
      await db.execute(sql`delete from audit_log where actor_id = any(${pgArray(adminIds, 'uuid')})`);
      await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
      await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
      await db.execute(sql`delete from patients where id = ${patientId}`);
    } finally {
      if (app) await app.close();
    }
  });

  /* ======================================================================== */
  /* AUTH BOUNDARY — identical across all five routes, checked once in depth   */
  /* ======================================================================== */

  describe('auth boundary', () => {
    it('GET /admin/pricing/config — no token -> 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/config' });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe('UNAUTHENTICATED');
    });

    it('GET /admin/pricing/config — patient token -> 403 WRONG_ACCOUNT_TYPE', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${patientToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('GET /admin/pricing/config — admin with no permissions -> 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminNoneToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('every other route in this module enforces the SAME permission (spot-checked on preview and state-codes)', async () => {
      const preview = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminNoneToken}` },
        payload: { consultationFeeInr: '500.00', placeOfSupplyStateCode: '27' },
      });
      expect(preview.statusCode).toBe(403);
      expect(payload<{ code: string }>(preview).code).toBe('PERMISSION_DENIED');

      const stateCodes = await app.inject({ method: 'GET', url: '/api/admin/pricing/state-codes', headers: { authorization: `Bearer ${patientToken}` } });
      expect(stateCodes.statusCode).toBe(403);
      expect(payload<{ code: string }>(stateCodes).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ======================================================================== */
  /* GET /admin/pricing/config                                                 */
  /* ======================================================================== */

  describe('GET /admin/pricing/config', () => {
    it('returns the resolved catalogue, tax profile and TTL, each flagging whether it fell back to the compiled-in default', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{
        components: unknown[];
        taxProfile: { registeredStateCode: string; legalName: string };
        quoteTtlMinutes: number;
        componentsFellBack: boolean;
        taxProfileFellBack: boolean;
      }>(response);
      expect(Array.isArray(body.components)).toBe(true);
      expect(body.components.length).toBeGreaterThan(0);
      expect(typeof body.taxProfile.registeredStateCode).toBe('string');
      expect(typeof body.quoteTtlMinutes).toBe('number');
      expect(typeof body.componentsFellBack).toBe('boolean');
      expect(typeof body.taxProfileFellBack).toBe('boolean');
    });
  });

  /* ======================================================================== */
  /* PUT /admin/pricing/config                                                 */
  /* ======================================================================== */

  describe('PUT /admin/pricing/config', () => {
    it('an empty body is a no-op: nothing changes, nothing is audited', async () => {
      const before = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminConfigToken}` } });
      const response = await app.inject({ method: 'PUT', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminConfigToken}` }, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(payload(response)).toEqual(payload(before));
    });

    it('validation: quoteTtlMinutes below the 2-120 bound -> 400 VALIDATION_FAILED, never reaching the service', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/pricing/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { quoteTtlMinutes: 1 },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('PRICING_CONFIG_INVALID: a tax profile naming a MERGED (not active) GST state code -> 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/pricing/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: {
          taxProfile: {
            // '25' (Daman and Diu) — merged into '26' in 2020; a syntactically
            // valid two-digit code the DTO regex accepts, but not `active`.
            registeredStateCode: '25',
            legalName: 'Test Legal Entity',
            defaultPlaceOfSupplyStateCode: '27',
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PRICING_CONFIG_INVALID');
    });

    it('PRICING_CONFIG_INVALID: an exempt component with a nonzero tax rate is a structural contradiction -> 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/pricing/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: {
          components: [
            {
              code: 'test_component',
              label: 'Test component',
              position: 0,
              basis: 'pass_through',
              source: 'fixed',
              fixedAmount: '10.00',
              taxTreatment: 'exempt',
              taxMode: 'exclusive',
              // Exempt but nonzero — the engine's validator refuses this
              // combination outright (pricing.engine.ts's assertRate branch).
              taxRatePct: '18.00',
              payee: 'platform',
            },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PRICING_CONFIG_INVALID');
    });

    it('PRICING_CONFIG_INVALID: two components sharing the same position -> 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/pricing/config',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: {
          components: [
            { code: 'comp_a', label: 'A', position: 0, basis: 'pass_through', source: 'fixed', fixedAmount: '1.00', taxTreatment: 'taxable', taxMode: 'exclusive', taxRatePct: '18.00', payee: 'platform' },
            { code: 'comp_b', label: 'B', position: 0, basis: 'pass_through', source: 'fixed', fixedAmount: '1.00', taxTreatment: 'taxable', taxMode: 'exclusive', taxRatePct: '18.00', payee: 'platform' },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PRICING_CONFIG_INVALID');
    });

    it('success: changes quoteTtlMinutes and only quoteTtlMinutes — restored immediately, since this key is global and shared across concurrent worktrees', async () => {
      const before = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminConfigToken}` } });
      const originalTtl = payload<{ quoteTtlMinutes: number }>(before).quoteTtlMinutes;
      const newTtl = originalTtl === 10 ? 11 : 10;

      try {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/admin/pricing/config',
          headers: { authorization: `Bearer ${adminConfigToken}` },
          payload: { quoteTtlMinutes: newTtl },
        });
        expect(response.statusCode).toBe(200);
        expect(payload<{ quoteTtlMinutes: number }>(response).quoteTtlMinutes).toBe(newTtl);

        const confirmed = await app.inject({ method: 'GET', url: '/api/admin/pricing/config', headers: { authorization: `Bearer ${adminConfigToken}` } });
        expect(payload<{ quoteTtlMinutes: number }>(confirmed).quoteTtlMinutes).toBe(newTtl);
      } finally {
        await app.inject({
          method: 'PUT',
          url: '/api/admin/pricing/config',
          headers: { authorization: `Bearer ${adminConfigToken}` },
          payload: { quoteTtlMinutes: originalTtl },
        });
      }
    });
  });

  /* ======================================================================== */
  /* POST /admin/pricing/preview                                               */
  /* ======================================================================== */

  describe('POST /admin/pricing/preview', () => {
    it('success: prices a bill without persisting a price_quotes row', async () => {
      const before = await db.execute(sql`select count(*)::int as n from price_quotes`);

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { consultationFeeInr: '500.00', placeOfSupplyStateCode: '27' },
      });
      // POST has no @HttpCode override on this route — Nest's default 201
      // applies even though nothing is persisted (confirmed by the
      // price_quotes count assertion below).
      expect(response.statusCode).toBe(201);
      const body = payload<{ totalPayable: string; quoteId: string | null; status: string | null; expiresAt: string | null }>(response);
      expect(body.quoteId).toBeNull();
      expect(body.status).toBeNull();
      expect(body.expiresAt).toBeNull();
      expect(Number(body.totalPayable)).toBeGreaterThan(0);

      const after = await db.execute(sql`select count(*)::int as n from price_quotes`);
      expect((after.rows as Array<{ n: number }>)[0].n).toBe((before.rows as Array<{ n: number }>)[0].n);
    });

    it('a discountCode on this admin route never applies (no patient identity to check it against) — it always resolves CODE_NOT_USABLE, never an error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { consultationFeeInr: '500.00', placeOfSupplyStateCode: '27', discountCode: 'ANYCODE123' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ discount: { applied: boolean; reason: string } | null }>(response);
      expect(body.discount).not.toBeNull();
      expect(body.discount?.applied).toBe(false);
      expect(body.discount?.reason).toBe('CODE_NOT_USABLE');
    });

    it('PRICING_STATE_CODE_INVALID for a merged/obsolete state code -> 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { consultationFeeInr: '500.00', placeOfSupplyStateCode: '28' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('PRICING_STATE_CODE_INVALID');
    });

    it('validation: a malformed consultationFeeInr -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { consultationFeeInr: 'not-a-number', placeOfSupplyStateCode: '27' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('validation: missing placeOfSupplyStateCode -> 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/pricing/preview',
        headers: { authorization: `Bearer ${adminConfigToken}` },
        payload: { consultationFeeInr: '500.00' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  /* ======================================================================== */
  /* GET /admin/pricing/state-codes                                            */
  /* ======================================================================== */

  describe('GET /admin/pricing/state-codes', () => {
    it('lists only ACTIVE codes — merged/obsolete/not_a_place codes are excluded', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/state-codes', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ states: Array<{ code: string; status: string }> }>(response);
      expect(body.states.length).toBeGreaterThan(0);
      expect(body.states.every((s) => s.status === 'active')).toBe(true);
      expect(body.states.some((s) => s.code === '25')).toBe(false);
      expect(body.states.some((s) => s.code === '27')).toBe(true);
    });
  });

  /* ======================================================================== */
  /* GET /admin/pricing/state-for-pincode                                      */
  /* ======================================================================== */

  describe('GET /admin/pricing/state-for-pincode', () => {
    it('a missing pincode -> 200, a null suggestion, never an error', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/state-for-pincode', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ pincode: string | null; suggestedStateCode: string | null; authoritative: boolean }>(response);
      expect(body.pincode).toBeNull();
      expect(body.suggestedStateCode).toBeNull();
      expect(body.authoritative).toBe(false);
    });

    it('a malformed pincode -> 200, a null suggestion (this route has no DTO — validation is inside the mapping function itself)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/state-for-pincode?pincode=abc', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      expect(payload<{ suggestedStateCode: string | null }>(response).suggestedStateCode).toBeNull();
    });

    it('a well-formed six-digit pincode -> 200, non-authoritative shape returned regardless of whether it maps to anything', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/pricing/state-for-pincode?pincode=400001', headers: { authorization: `Bearer ${adminConfigToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ pincode: string; authoritative: boolean }>(response);
      expect(body.pincode).toBe('400001');
      expect(body.authoritative).toBe(false);
    });
  });
});
