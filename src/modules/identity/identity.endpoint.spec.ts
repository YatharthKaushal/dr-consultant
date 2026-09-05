/**
 * *** REAL-HTTP ENDPOINT TESTS — `identity` MODULE. ***
 *
 * Drives every route in `identity.controller.ts` and `identity-admin.controller.ts`
 * through `app.inject()` against `createConfiguredApp()` — the exact application
 * `main.ts` boots, guards/pipes/interceptors/filters included — not a hand-built
 * lookalike. Follows the fixture/mocking discipline established by
 * `src/app.e2e.integration.spec.ts` (read in full before writing this file):
 * only `@synquic/slide`'s `SlideClient` is mocked, everything else is real.
 *
 * Every fixture is namespaced per run (`RUN_ID`) so this is safe to run
 * concurrently with the other endpoint spec files and other worktrees against
 * the one shared database, and torn down in `afterAll` in reverse-FK order.
 */
import { randomUUID } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* SLIDE. Mocked before anything imports the application.                      */
/* -------------------------------------------------------------------------- */

/**
 * Unlike `app.e2e.integration.spec.ts`'s mock (which always "verifies"), this
 * one can actually reject a wrong code — `otp.verify` throws a real
 * `SlideValidationError` (via `jest.requireActual`, so `identity-otp.service
 * .ts`'s `instanceof` mapping resolves) whenever the submitted code isn't
 * `CORRECT_OTP_CODE`. That is what lets this file exercise `INVALID_OTP` and
 * `TOO_MANY_ATTEMPTS` for real, not just the happy path.
 */
const CORRECT_OTP_CODE = '123456';
const identifiersByRequestId = new Map<string, string>();

const slideOtpMock = {
  send: jest.fn(async ({ identifier }: { widgetId: string; identifier: string }) => {
    const requestId = `otpreq_${randomUUID()}`;
    identifiersByRequestId.set(requestId, identifier);
    return { requestId };
  }),
  retry: jest.fn(async ({ requestId }: { requestId: string }) => ({ requestId })),
  verify: jest.fn(async ({ requestId, otp }: { requestId: string; otp: string }) => {
    if (otp !== CORRECT_OTP_CODE) {
      const { SlideValidationError } = jest.requireActual('@synquic/slide');
      throw new SlideValidationError('wrong code');
    }
    return { accessToken: `slide_at_${requestId}` };
  }),
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

/* Imported AFTER the mock, so the application's Slide client is the fake one. */
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminRolesTable } from '../../schema/admin-roles.schema';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { otpChallengesTable } from '../../schema/otp-challenges.schema';
import { otpRequestAttemptsTable } from '../../schema/otp-request-attempts.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { rolesTable } from '../../schema/roles.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { IDENTITY_APP_CONFIG_DEFAULTS, IDENTITY_APP_CONFIG_KEYS, IDENTITY_ERROR_CODES } from './identity.constants';
import { IdentityTokenService } from './identity-token.service';

jest.setTimeout(120_000);

/** `shared/errors`'s envelope: `{success:true,data}` or `{success:false,error}`. See `app.e2e.integration.spec.ts`'s identical helper for why this is required. */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

const RUN_ID = randomUUID().slice(0, 8);

/**
 * *** EVERY REQUEST IN THIS FILE USES A FRESH, RANDOM FAKE REMOTE ADDRESS BY
 * DEFAULT — THIS IS LOAD-BEARING, NOT COSMETIC. ***
 *
 * `IdentityService#requestOtp` rate-limits `POST /auth/otp/request` by IP as
 * well as by mobile number (`otp.request.max_per_ip_per_hour`, default 20 —
 * see `identity.service.ts#assertNotRateLimited`). `otp_request_attempts` is
 * real, persistent Postgres state with no per-run namespacing on IP address.
 *
 * A first attempt at fixing this pinned ONE random address for the whole
 * file (isolating different runs/files from each other) — that still failed,
 * because THIS FILE ON ITS OWN makes well over 20 `/auth/otp/request` calls
 * across the request/verify/resend/refresh describe blocks, so it tripped
 * its own per-IP limit by its 21st call regardless of any other run. The
 * fix that actually holds: mint a brand-new random address for every single
 * call by default, so no two calls ever share a bucket unless a test
 * deliberately asks to reuse one (none here need to — this file's own
 * dedicated per-NUMBER rate-limit test already covers that code path, and
 * the per-IP branch is the same `assertNotRateLimited` function with the
 * same `IDENTITY_ERROR_CODES.REQUEST_RATE_LIMITED` outcome, just keyed
 * differently).
 */
function randomTestIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
}

/** Set once in `beforeAll` below — declared at module scope so `injectRequest` can close over it. */
let app: NestFastifyApplication;

interface InjectRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}

function injectRequest(options: InjectRequestOptions) {
  return app.inject({ remoteAddress: randomTestIp(), ...options });
}

const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
let phoneSeq = 10;
/** A valid-looking Indian E.164 number — required because `OtpRequestDto#mobileNumber` carries `@IsPhoneNumber('IN')`. */
const nextPhone = (): string => `+9178${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

interface Fixtures {
  doctorMobile: string;
  doctorId: string;
  adminMobile: string;
  adminId: string;
  /** Never inserted anywhere — used to prove doctor/admin sign-in refuses an unknown number. */
  noAccountMobile: string;
  /** Used only by the resend-cooldown/limit tests — kept isolated so its otp_request_attempts rows never interfere with the rate-limit tests. */
  resendTestMobile: string;
  /** Fresh admin with NO roles/grants — the RBAC "insufficient permission" and mutation-target admin. */
  targetAdminId: string;
  targetAdminMobile: string;
  /** Fresh admin granted ONLY `admins.read` directly. */
  readerAdminId: string;
  readerAdminMobile: string;
  /** Fresh admin granted ONLY `admins.manage` directly. */
  managerAdminId: string;
  managerAdminMobile: string;
  /** A throwaway admin whose token is minted BEFORE suspension, to prove suspension revokes it. */
  suspendCandidateId: string;
  suspendCandidateMobile: string;
  contentRoleId: string;
  patientsReadPermissionId: string;
  adminsReadPermissionId: string;
  adminsManagePermissionId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const doctorMobile = nextPhone();
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: doctorMobile, fullName: `Identity Endpoint Doctor ${RUN_ID}` })
    .returning({ id: doctorsTable.id });

  const adminMobile = nextPhone();
  const [admin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: adminMobile, fullName: `Identity Endpoint Admin ${RUN_ID}` })
    .returning({ id: adminsTable.id });

  const targetAdminMobile = nextPhone();
  const [targetAdmin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: targetAdminMobile, fullName: `Identity Endpoint Target ${RUN_ID}` })
    .returning({ id: adminsTable.id });

  const readerAdminMobile = nextPhone();
  const [readerAdmin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: readerAdminMobile, fullName: `Identity Endpoint Reader ${RUN_ID}` })
    .returning({ id: adminsTable.id });

  const managerAdminMobile = nextPhone();
  const [managerAdmin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: managerAdminMobile, fullName: `Identity Endpoint Manager ${RUN_ID}` })
    .returning({ id: adminsTable.id });

  const suspendCandidateMobile = nextPhone();
  const [suspendCandidate] = await db
    .insert(adminsTable)
    .values({ mobileNumber: suspendCandidateMobile, fullName: `Identity Endpoint Suspendee ${RUN_ID}` })
    .returning({ id: adminsTable.id });

  const [contentRole] = await db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.code, 'content')).limit(1);
  if (!contentRole) throw new Error('Fixture precondition failed: no "content" role found — run identity.seed.ts first.');

  const [patientsReadPermission] = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.key, PERMISSIONS.PATIENTS_READ))
    .limit(1);
  if (!patientsReadPermission) throw new Error(`Fixture precondition failed: permission "${PERMISSIONS.PATIENTS_READ}" not seeded.`);

  const [adminsReadPermission] = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.key, PERMISSIONS.ADMINS_READ))
    .limit(1);
  if (!adminsReadPermission) throw new Error(`Fixture precondition failed: permission "${PERMISSIONS.ADMINS_READ}" not seeded.`);

  const [adminsManagePermission] = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.key, PERMISSIONS.ADMINS_MANAGE))
    .limit(1);
  if (!adminsManagePermission) throw new Error(`Fixture precondition failed: permission "${PERMISSIONS.ADMINS_MANAGE}" not seeded.`);

  await db
    .insert(adminPermissionGrantsTable)
    .values([
      { adminId: readerAdmin!.id, permissionId: adminsReadPermission.id },
      { adminId: managerAdmin!.id, permissionId: adminsManagePermission.id },
    ]);

  return {
    doctorMobile,
    doctorId: doctor!.id,
    adminMobile,
    adminId: admin!.id,
    noAccountMobile: nextPhone(),
    resendTestMobile: nextPhone(),
    targetAdminId: targetAdmin!.id,
    targetAdminMobile,
    readerAdminId: readerAdmin!.id,
    readerAdminMobile,
    managerAdminId: managerAdmin!.id,
    managerAdminMobile,
    suspendCandidateId: suspendCandidate!.id,
    suspendCandidateMobile,
    contentRoleId: contentRole.id,
    patientsReadPermissionId: patientsReadPermission.id,
    adminsReadPermissionId: adminsReadPermission.id,
    adminsManagePermissionId: adminsManagePermission.id,
  };
}

/** Every patient row this file's OTP-verify flow creates — patients are self-signup, so they don't exist until verified. Tracked so teardown can find them by id, not by guessing mobile numbers. */
const createdPatientIds: string[] = [];
/** Extra admins created via `POST /admin/admins` during the tests themselves. */
const createdAdminIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const allMobiles = [
    fixtures.doctorMobile,
    fixtures.adminMobile,
    fixtures.noAccountMobile,
    fixtures.resendTestMobile,
    fixtures.targetAdminMobile,
    fixtures.readerAdminMobile,
    fixtures.managerAdminMobile,
    fixtures.suspendCandidateMobile,
  ];

  await db.execute(sql`delete from otp_challenges where mobile_number = any(${sql.raw(`array['${allMobiles.join("','")}']::varchar[]`)})`);
  await db.execute(
    sql`delete from otp_request_attempts where mobile_number = any(${sql.raw(`array['${allMobiles.join("','")}']::varchar[]`)})`,
  );

  const adminIds = [
    fixtures.adminId,
    fixtures.targetAdminId,
    fixtures.readerAdminId,
    fixtures.managerAdminId,
    fixtures.suspendCandidateId,
    ...createdAdminIds,
  ];
  const allActorEntityIds = [...adminIds, fixtures.doctorId, ...createdPatientIds];
  if (allActorEntityIds.length > 0) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.actorId, allActorEntityIds));
    await db.delete(auditLogTable).where(inArray(auditLogTable.entityId, allActorEntityIds));
  }

  if (adminIds.length > 0) {
    // `admin_roles.adminId`/`admin_permission_grants.adminId` cascade on
    // delete (see both schema files), so a fixture admin's OWN roles/grants
    // are cleaned up automatically. `granted_by_admin_id` on both tables is
    // NOT cascading, though (deliberately — "a role is never deleted, a FK
    // violation there is a bug worth surfacing"), and one fixture admin here
    // routinely grants a role/permission to ANOTHER fixture admin over HTTP
    // during the tests — so a row belonging to admin A can point at admin B
    // as its granter. Deleting B first would then hit a bare FK violation.
    // Null that column out for every row this run could have touched before
    // deleting any admin row, regardless of which admin ends up owning it.
    await db.update(adminRolesTable).set({ grantedByAdminId: null }).where(inArray(adminRolesTable.grantedByAdminId, adminIds));
    await db
      .update(adminPermissionGrantsTable)
      .set({ grantedByAdminId: null })
      .where(inArray(adminPermissionGrantsTable.grantedByAdminId, adminIds));
    await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  }
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  if (createdPatientIds.length > 0) await db.delete(patientsTable).where(inArray(patientsTable.id, createdPatientIds));
}

/* -------------------------------------------------------------------------- */

describe('identity module — real HTTP endpoint tests', () => {
  let db: Database;
  let fixtures: Fixtures;
  let maxRequestsPerNumberPerHour: number;
  let maxVerifyAttempts: number;
  let maxResendsPerChallenge: number;

  let managerToken: string;
  let readerToken: string;
  let noPermsAdminToken: string;
  let doctorToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const appConfig = app.get(AppConfigService);
    maxRequestsPerNumberPerHour = await appConfig.getNumber(
      IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_NUMBER_PER_HOUR,
      IDENTITY_APP_CONFIG_DEFAULTS[IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_NUMBER_PER_HOUR],
    );
    maxVerifyAttempts = await appConfig.getNumber(
      IDENTITY_APP_CONFIG_KEYS.OTP_VERIFY_MAX_ATTEMPTS_PER_CHALLENGE,
      IDENTITY_APP_CONFIG_DEFAULTS[IDENTITY_APP_CONFIG_KEYS.OTP_VERIFY_MAX_ATTEMPTS_PER_CHALLENGE],
    );
    maxResendsPerChallenge = await appConfig.getNumber(
      IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_MAX_PER_CHALLENGE,
      IDENTITY_APP_CONFIG_DEFAULTS[IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_MAX_PER_CHALLENGE],
    );

    // Minted directly — bypasses OTP for the RBAC/me/logout-all tests, which
    // are not testing sign-in itself. `tokenVersion` starts at 0 for every
    // fresh row seeded above.
    const tokenService = app.get(IdentityTokenService);
    managerToken = (await tokenService.mintTokenPair('admin', fixtures.managerAdminId, 0)).accessToken;
    readerToken = (await tokenService.mintTokenPair('admin', fixtures.readerAdminId, 0)).accessToken;
    noPermsAdminToken = (await tokenService.mintTokenPair('admin', fixtures.targetAdminId, 0)).accessToken;
    doctorToken = (await tokenService.mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ====================================================================== */
  /* POST /auth/otp/request                                                  */
  /* ====================================================================== */

  describe('POST /auth/otp/request', () => {
    it('a patient may request an OTP for ANY number — open self sign-up', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: nextPhone(), audience: 'patient' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ challengeId: string; resendsRemaining: number }>(response);
      expect(typeof body.challengeId).toBe('string');
      expect(body.resendsRemaining).toBe(maxResendsPerChallenge);
    });

    it('a doctor may request an OTP for an EXISTING doctor number', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: fixtures.doctorMobile, audience: 'doctor' },
      });
      expect(response.statusCode).toBe(201);
    });

    it('an admin may request an OTP for an EXISTING admin number', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: fixtures.adminMobile, audience: 'admin' },
      });
      expect(response.statusCode).toBe(201);
    });

    it('refuses a doctor sign-in for a number with no doctor account — 403 ACCOUNT_NOT_FOUND_FOR_ROLE, not 404 (no existence leak either way)', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: fixtures.noAccountMobile, audience: 'doctor' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ACCOUNT_NOT_FOUND_FOR_ROLE);
    });

    it('refuses an admin sign-in for a number with no admin account', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: fixtures.noAccountMobile, audience: 'admin' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ACCOUNT_NOT_FOUND_FOR_ROLE);
    });

    it('VALIDATION: missing mobileNumber is refused 400 by the real ValidationPipe', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { audience: 'patient' },
      });
      expect(response.statusCode).toBe(400);
      const body = payload<{ code: string }>(response);
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('VALIDATION: an unrecognised audience is refused 400', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: nextPhone(), audience: 'superuser' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rate-limits requests for the SAME number — the Nth+1 request in the window is refused 429 REQUEST_RATE_LIMITED, even though every prior call actually reached Slide (a locally-refused doctor/admin lookup still counts)', async () => {
      const mobile = nextPhone();
      let last;
      for (let i = 0; i < maxRequestsPerNumberPerHour; i += 1) {
        last = await injectRequest({
          method: 'POST',
          url: '/api/auth/otp/request',
          payload: { mobileNumber: mobile, audience: 'patient' },
        });
        expect(last.statusCode).toBe(201);
      }
      const blocked = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: mobile, audience: 'patient' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(payload<{ code: string }>(blocked).code).toBe(IDENTITY_ERROR_CODES.REQUEST_RATE_LIMITED);
    });
  });

  /* ====================================================================== */
  /* POST /auth/otp/verify                                                   */
  /* ====================================================================== */

  describe('POST /auth/otp/verify', () => {
    async function requestChallenge(mobileNumber: string, audience: 'patient' | 'doctor' | 'admin'): Promise<string> {
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber, audience },
      });
      expect(requested.statusCode).toBe(201);
      return payload<{ challengeId: string }>(requested).challengeId;
    }

    it('SUCCESS (patient, brand-new number): verifies, creates the patient row, mints tokens, isNewAccount true', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');

      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ accessToken: string; refreshToken: string; account: { id: string; accountType: string; isNewAccount: boolean } }>(
        response,
      );
      expect(body.account.accountType).toBe('patient');
      expect(body.account.isNewAccount).toBe(true);
      createdPatientIds.push(body.account.id);

      const row = await db.select().from(patientsTable).where(eq(patientsTable.id, body.account.id));
      expect(row).toHaveLength(1);

      const challenge = await db.select().from(otpChallengesTable).where(eq(otpChallengesTable.id, challengeId));
      expect(challenge[0]!.verifiedAt).not.toBeNull();
    });

    it('SUCCESS (doctor, existing number): isNewAccount is false, no new doctor row is created', async () => {
      const challengeId = await requestChallenge(fixtures.doctorMobile, 'doctor');
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ account: { id: string; isNewAccount: boolean } }>(response);
      expect(body.account.id).toBe(fixtures.doctorId);
      expect(body.account.isNewAccount).toBe(false);
    });

    it('an incorrect code is refused 400 INVALID_OTP, and the challenge survives for a retry', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');

      const wrong = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: '000000' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(payload<{ code: string }>(wrong).code).toBe(IDENTITY_ERROR_CODES.INVALID_OTP);

      // The SAME challenge still works with the right code afterwards.
      const right = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(right.statusCode).toBe(201);
      createdPatientIds.push(payload<{ account: { id: string } }>(right).account.id);
    });

    it('locks out after the configured max wrong attempts — 429 TOO_MANY_ATTEMPTS, refused LOCALLY (Slide is not called again)', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');

      for (let i = 0; i < maxVerifyAttempts; i += 1) {
        const attempt = await injectRequest({
          method: 'POST',
          url: '/api/auth/otp/verify',
          payload: { challengeId, code: '000000' },
        });
        expect(attempt.statusCode).toBe(400);
      }

      const verifyCallsBeforeLockout = slideOtpMock.verify.mock.calls.length;
      // Even the CORRECT code is refused now — the lockout is unconditional.
      const lockedOut = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(lockedOut.statusCode).toBe(429);
      expect(payload<{ code: string }>(lockedOut).code).toBe(IDENTITY_ERROR_CODES.TOO_MANY_ATTEMPTS);
      expect(slideOtpMock.verify.mock.calls.length).toBe(verifyCallsBeforeLockout);
    });

    it('an unknown challengeId is refused 404 CHALLENGE_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId: randomUUID(), code: CORRECT_OTP_CODE },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.CHALLENGE_NOT_FOUND);
    });

    it('a challenge that was already used is refused 410 CHALLENGE_ALREADY_USED on the second verify', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');
      const first = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(first.statusCode).toBe(201);
      createdPatientIds.push(payload<{ account: { id: string } }>(first).account.id);

      const second = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(second.statusCode).toBe(410);
      expect(payload<{ code: string }>(second).code).toBe(IDENTITY_ERROR_CODES.CHALLENGE_ALREADY_USED);
    });

    it('an expired challenge is refused 410 CHALLENGE_EXPIRED', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');
      // Backdate the challenge's own expiry estimate directly — this is our
      // bookkeeping deadline, checked before Slide is ever asked.
      await db
        .update(otpChallengesTable)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(otpChallengesTable.id, challengeId));

      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      expect(response.statusCode).toBe(410);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.CHALLENGE_EXPIRED);
    });

    it('VALIDATION: a code that is not 4-8 digits is refused 400 before Slide is ever called', async () => {
      const mobile = nextPhone();
      const challengeId = await requestChallenge(mobile, 'patient');
      const callsBefore = slideOtpMock.verify.mock.calls.length;

      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: 'abcd' },
      });
      expect(response.statusCode).toBe(400);
      expect(slideOtpMock.verify.mock.calls.length).toBe(callsBefore);
    });
  });

  /* ====================================================================== */
  /* POST /auth/otp/resend                                                   */
  /* ====================================================================== */

  describe('POST /auth/otp/resend', () => {
    it('an unknown challengeId is refused 404 CHALLENGE_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/resend',
        payload: { challengeId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.CHALLENGE_NOT_FOUND);
    });

    it('resending immediately after the initial send is refused 429 RESEND_COOLDOWN (the cooldown window has not elapsed)', async () => {
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: fixtures.resendTestMobile, audience: 'patient' },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);

      const resend = await injectRequest({ method: 'POST', url: '/api/auth/otp/resend', payload: { challengeId } });
      expect(resend.statusCode).toBe(429);
      expect(payload<{ code: string }>(resend).code).toBe(IDENTITY_ERROR_CODES.RESEND_COOLDOWN);
    });

    it('reaching the max resend count is refused 429 RESEND_LIMIT_REACHED, even once the cooldown has elapsed', async () => {
      const mobile = nextPhone();
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: mobile, audience: 'patient' },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);

      // Directly set resendCount to the limit and push lastSentAt into the
      // past so the cooldown branch can't fire first and mask this one.
      await db
        .update(otpChallengesTable)
        .set({ resendCount: maxResendsPerChallenge, lastSentAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(otpChallengesTable.id, challengeId));

      const resend = await injectRequest({ method: 'POST', url: '/api/auth/otp/resend', payload: { challengeId } });
      expect(resend.statusCode).toBe(429);
      expect(payload<{ code: string }>(resend).code).toBe(IDENTITY_ERROR_CODES.RESEND_LIMIT_REACHED);
    });

    it('a challenge already used cannot be resent — 410 CHALLENGE_ALREADY_USED', async () => {
      const mobile = nextPhone();
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: mobile, audience: 'patient' },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);
      const verified = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      createdPatientIds.push(payload<{ account: { id: string } }>(verified).account.id);

      const resend = await injectRequest({ method: 'POST', url: '/api/auth/otp/resend', payload: { challengeId } });
      expect(resend.statusCode).toBe(410);
      expect(payload<{ code: string }>(resend).code).toBe(IDENTITY_ERROR_CODES.CHALLENGE_ALREADY_USED);
    });
  });

  /* ====================================================================== */
  /* POST /auth/token/refresh                                                */
  /* ====================================================================== */

  describe('POST /auth/token/refresh', () => {
    it('SUCCESS: a real refresh token mints a new working access token', async () => {
      const mobile = nextPhone();
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: mobile, audience: 'patient' },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);
      const verified = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      const { refreshToken, account } = payload<{ refreshToken: string; account: { id: string } }>(verified);
      createdPatientIds.push(account.id);

      const refreshed = await injectRequest({ method: 'POST', url: '/api/auth/token/refresh', payload: { refreshToken } });
      expect(refreshed.statusCode).toBe(201);
      const { accessToken } = payload<{ accessToken: string }>(refreshed);

      const me = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
      expect(me.statusCode).toBe(200);
      expect(payload<{ id: string }>(me).id).toBe(account.id);
    });

    it('a garbage refresh token is refused 401 INVALID_REFRESH_TOKEN', async () => {
      const response = await injectRequest({ method: 'POST', url: '/api/auth/token/refresh', payload: { refreshToken: 'not-a-real-token' } });
      expect(response.statusCode).toBe(401);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.INVALID_REFRESH_TOKEN);
    });

    it('a refresh token issued before logout-all is refused after the tokenVersion bump', async () => {
      const mobile = nextPhone();
      const requested = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/request',
        payload: { mobileNumber: mobile, audience: 'patient' },
      });
      const { challengeId } = payload<{ challengeId: string }>(requested);
      const verified = await injectRequest({
        method: 'POST',
        url: '/api/auth/otp/verify',
        payload: { challengeId, code: CORRECT_OTP_CODE },
      });
      const { refreshToken, accessToken, account } = payload<{ refreshToken: string; accessToken: string; account: { id: string } }>(
        verified,
      );
      createdPatientIds.push(account.id);

      const logout = await injectRequest({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${accessToken}` } });
      expect(logout.statusCode).toBe(204);

      const refreshed = await injectRequest({ method: 'POST', url: '/api/auth/token/refresh', payload: { refreshToken } });
      expect(refreshed.statusCode).toBe(401);
      expect(payload<{ code: string }>(refreshed).code).toBe(IDENTITY_ERROR_CODES.INVALID_REFRESH_TOKEN);
    });
  });

  /* ====================================================================== */
  /* GET /auth/me                                                            */
  /* ====================================================================== */

  describe('GET /auth/me', () => {
    it('AUTH BOUNDARY: no token at all is refused 401 UNAUTHENTICATED', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('AUTH BOUNDARY: a garbage bearer token is refused 401', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer not-a-real-jwt' } });
      expect(response.statusCode).toBe(401);
    });

    it('a doctor sees their own profile, with no roles/permissions fields', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${doctorToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; accountType: string; roles?: string[]; permissions?: string[] }>(response);
      expect(body.id).toBe(fixtures.doctorId);
      expect(body.accountType).toBe('doctor');
      expect(body.roles).toBeUndefined();
      expect(body.permissions).toBeUndefined();
    });

    it('an admin sees their roles and effective permissions', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${managerToken}` } });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; accountType: string; roles: string[]; permissions: string[] }>(response);
      expect(body.id).toBe(fixtures.managerAdminId);
      expect(body.accountType).toBe('admin');
      expect(body.permissions).toContain(PERMISSIONS.ADMINS_MANAGE);
    });
  });

  /* ====================================================================== */
  /* POST /auth/logout-all                                                   */
  /* ====================================================================== */

  describe('POST /auth/logout-all', () => {
    it('AUTH BOUNDARY: no token is refused 401', async () => {
      const response = await injectRequest({ method: 'POST', url: '/api/auth/logout-all' });
      expect(response.statusCode).toBe(401);
    });

    it('revokes every token for the account — a subsequent call with the old access token 401s', async () => {
      const token = (await app.get(IdentityTokenService).mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
      // Sanity: works before logout.
      const before = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
      expect(before.statusCode).toBe(200);

      const logout = await injectRequest({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${token}` } });
      expect(logout.statusCode).toBe(204);

      const after = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
      expect(after.statusCode).toBe(401);

      // Restore doctorToken (bumped tokenVersion invalidated it too) for later tests in this file.
      doctorToken = (await app.get(IdentityTokenService).mintTokenPair('doctor', fixtures.doctorId, 1)).accessToken;
    });
  });

  /* ====================================================================== */
  /* Admin RBAC surface — /admin/*                                           */
  /* ====================================================================== */

  describe('admin RBAC — account-type and permission boundaries', () => {
    it('AUTH BOUNDARY: a doctor token hitting an admin-only route is refused 403 WRONG_ACCOUNT_TYPE (AccountTypeGuard, before PermissionGuard even runs)', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/admin/roles', headers: { authorization: `Bearer ${doctorToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('PERMISSION BOUNDARY: an admin with no grants at all is refused 403 PERMISSION_DENIED on a read route', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/admin/roles', headers: { authorization: `Bearer ${noPermsAdminToken}` } });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('PERMISSION BOUNDARY: admins.read alone is not enough for an admins.manage route', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/admin/admins',
        headers: { authorization: `Bearer ${readerToken}` },
        payload: { mobileNumber: nextPhone(), fullName: 'Should Not Be Created' },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });

    it('GET /admin/roles: with admins.read, lists all 6 seeded roles', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/admin/roles', headers: { authorization: `Bearer ${readerToken}` } });
      expect(response.statusCode).toBe(200);
      const roles = payload<Array<{ code: string }>>(response);
      expect(roles.map((r) => r.code)).toEqual(expect.arrayContaining(['super_admin', 'content']));
    });

    it('GET /admin/permissions: with admins.read, lists the full permission catalog', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/admin/permissions', headers: { authorization: `Bearer ${readerToken}` } });
      expect(response.statusCode).toBe(200);
      const permissions = payload<Array<{ key: string }>>(response);
      expect(permissions.map((p) => p.key)).toEqual(expect.arrayContaining([PERMISSIONS.ADMINS_READ, PERMISSIONS.ADMINS_MANAGE]));
    });

    it('GET /admin/admins: with admins.read, lists admins including our fixtures', async () => {
      const response = await injectRequest({ method: 'GET', url: '/api/admin/admins', headers: { authorization: `Bearer ${readerToken}` } });
      expect(response.statusCode).toBe(200);
      const admins = payload<Array<{ id: string }>>(response);
      expect(admins.map((a) => a.id)).toEqual(expect.arrayContaining([fixtures.readerAdminId, fixtures.managerAdminId]));
      // `tokenVersion` must never be exposed — an internal revocation counter, not client data.
      expect(admins[0]).not.toHaveProperty('tokenVersion');
    });
  });

  describe('POST /admin/admins — create', () => {
    it('SUCCESS: creates a new admin', async () => {
      const mobile = nextPhone();
      const response = await injectRequest({
        method: 'POST',
        url: '/api/admin/admins',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { mobileNumber: mobile, fullName: 'Fresh Admin' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; mobileNumber: string }>(response);
      expect(body.mobileNumber).toBe(mobile);
      createdAdminIds.push(body.id);
    });

    it('a duplicate mobile number is refused 409 MOBILE_NUMBER_TAKEN', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/admin/admins',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { mobileNumber: fixtures.targetAdminMobile, fullName: 'Duplicate' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.MOBILE_NUMBER_TAKEN);
    });

    it('VALIDATION: a missing fullName is refused 400', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: '/api/admin/admins',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { mobileNumber: nextPhone() },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /admin/admins/:id/access', () => {
    it('SUCCESS: returns the admin, its roles and its grants', async () => {
      const response = await injectRequest({
        method: 'GET',
        url: `/api/admin/admins/${fixtures.readerAdminId}/access`,
        headers: { authorization: `Bearer ${readerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ admin: { id: string }; grants: Array<{ permissionId: string }> }>(response);
      expect(body.admin.id).toBe(fixtures.readerAdminId);
      expect(body.grants.map((g) => g.permissionId)).toContain(fixtures.adminsReadPermissionId);
    });

    it('a nonexistent admin id is refused 404 ADMIN_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'GET',
        url: `/api/admin/admins/${randomUUID()}/access`,
        headers: { authorization: `Bearer ${readerToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
    });
  });

  describe('PATCH /admin/admins/:id', () => {
    it('SUCCESS: updates fullName', async () => {
      const response = await injectRequest({
        method: 'PATCH',
        url: `/api/admin/admins/${fixtures.targetAdminId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { fullName: 'Renamed Target' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ fullName: string }>(response).fullName).toBe('Renamed Target');
    });

    it('a nonexistent admin id is refused 404', async () => {
      const response = await injectRequest({
        method: 'PATCH',
        url: `/api/admin/admins/${randomUUID()}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { fullName: 'Nobody' },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
    });

    it('VALIDATION: an invalid status enum value is refused 400', async () => {
      const response = await injectRequest({
        method: 'PATCH',
        url: `/api/admin/admins/${fixtures.targetAdminId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { status: 'not-a-real-status' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('suspending an admin bumps tokenVersion and immediately revokes a token minted before the suspension', async () => {
      const tokenBefore = (await app.get(IdentityTokenService).mintTokenPair('admin', fixtures.suspendCandidateId, 0)).accessToken;
      const before = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokenBefore}` } });
      expect(before.statusCode).toBe(200);

      const suspend = await injectRequest({
        method: 'PATCH',
        url: `/api/admin/admins/${fixtures.suspendCandidateId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { status: 'suspended' },
      });
      expect(suspend.statusCode).toBe(200);
      expect(payload<{ status: string }>(suspend).status).toBe('suspended');

      const after = await injectRequest({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokenBefore}` } });
      expect(after.statusCode).toBe(401);
    });
  });

  describe('role assignment — POST/DELETE /admin/admins/:id/roles', () => {
    it('SUCCESS: assigns a role, is idempotent on a repeat assignment, then revokes it (also idempotent)', async () => {
      const assign = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: fixtures.contentRoleId },
      });
      expect(assign.statusCode).toBe(204);

      const reassign = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: fixtures.contentRoleId },
      });
      expect(reassign.statusCode).toBe(204);

      const rows = await db
        .select()
        .from(adminRolesTable)
        .where(eq(adminRolesTable.adminId, fixtures.targetAdminId));
      expect(rows.filter((r) => r.roleId === fixtures.contentRoleId)).toHaveLength(1);

      const access = await injectRequest({
        method: 'GET',
        url: `/api/admin/admins/${fixtures.targetAdminId}/access`,
        headers: { authorization: `Bearer ${readerToken}` },
      });
      expect(payload<{ roles: Array<{ roleId: string }> }>(access).roles.map((r) => r.roleId)).toContain(fixtures.contentRoleId);

      const revoke = await injectRequest({
        method: 'DELETE',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles/${fixtures.contentRoleId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(revoke.statusCode).toBe(204);

      const revokeAgain = await injectRequest({
        method: 'DELETE',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles/${fixtures.contentRoleId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(revokeAgain.statusCode).toBe(204);
    });

    it('an unknown roleId is refused 404 ROLE_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ROLE_NOT_FOUND);
    });

    it('an unknown target admin id is refused 404 ADMIN_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${randomUUID()}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: fixtures.contentRoleId },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
    });

    it('an admin cannot assign a role to THEMSELVES — 403 CANNOT_MODIFY_SELF', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.managerAdminId}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: fixtures.contentRoleId },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.CANNOT_MODIFY_SELF);
    });

    it('VALIDATION: a non-UUID roleId is refused 400', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/roles`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { roleId: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('direct permission grants — POST/DELETE /admin/admins/:id/permissions', () => {
    it('SUCCESS: grants a permission with a reason, is visible in access, then revokes it (idempotent both ways)', async () => {
      const grant = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { permissionId: fixtures.patientsReadPermissionId, reason: 'endpoint test fixture' },
      });
      expect(grant.statusCode).toBe(204);

      const regrant = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { permissionId: fixtures.patientsReadPermissionId },
      });
      expect(regrant.statusCode).toBe(204);

      const rows = await db
        .select()
        .from(adminPermissionGrantsTable)
        .where(eq(adminPermissionGrantsTable.adminId, fixtures.targetAdminId));
      expect(rows.filter((r) => r.permissionId === fixtures.patientsReadPermissionId)).toHaveLength(1);

      const revoke = await injectRequest({
        method: 'DELETE',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions/${fixtures.patientsReadPermissionId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(revoke.statusCode).toBe(204);

      const revokeAgain = await injectRequest({
        method: 'DELETE',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions/${fixtures.patientsReadPermissionId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(revokeAgain.statusCode).toBe(204);
    });

    it('an unknown permissionId is refused 404 PERMISSION_NOT_FOUND', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { permissionId: randomUUID() },
      });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.PERMISSION_NOT_FOUND);
    });

    it('an admin cannot grant a permission to THEMSELVES — 403 CANNOT_MODIFY_SELF', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.managerAdminId}/permissions`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { permissionId: fixtures.patientsReadPermissionId },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe(IDENTITY_ERROR_CODES.CANNOT_MODIFY_SELF);
    });

    it('VALIDATION: a missing permissionId is refused 400', async () => {
      const response = await injectRequest({
        method: 'POST',
        url: `/api/admin/admins/${fixtures.targetAdminId}/permissions`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
