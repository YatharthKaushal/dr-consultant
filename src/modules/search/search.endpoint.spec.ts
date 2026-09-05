/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR M-09 SEARCH. ***
 *
 * Every other spec touching this module calls `SearchService`/
 * `GuidedIntakeService`/`SearchConfigService` or the pure
 * `search-discovery.engine.ts` stages directly. This file drives every route
 * on `SearchController` and `SearchAdminController` through `app.inject()`
 * against the REAL application (`createConfiguredApp()`), with real guards,
 * `ValidationPipe`, and Postgres in the loop — the same mechanism and the
 * same JWT-minting shortcut (`IdentityTokenService.mintTokenPair`, resolved
 * from the real container) `app.e2e.integration.spec.ts` documents as
 * sanctioned.
 *
 * *** NO REAL LLM CALL IS EVER MADE HERE. *** No `agent_credentials` row
 * exists in the shared test database (those are admin-created via
 * `ai-admin.controller.ts`, exercised in `ai.endpoint.spec.ts`), so
 * `AiRotationService#isAvailable` genuinely returns `false` and every
 * `discover`/`guided` call in the "deterministic" describe block below
 * degrades to the curated matcher with NO stub required — this is search's
 * own designed AI-outage path, exercised for real. The one test that DOES
 * need the `source: 'ai'` branch stubs `AiFacade` — resolved from the real DI
 * container and `jest.spyOn`'d, exactly as `app.e2e.integration.spec.ts`
 * stubs `RazorpayClient`/`ClinicalPdfService` — so the interpretation-mapping
 * code is exercised without ever reaching a network.
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
import { concernsTable } from '../../schema/concerns.schema';
import { doctorAvailabilityTable } from '../../schema/doctor-availability.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { searchQueriesTable } from '../../schema/search-queries.schema';
import { searchRateLimitsTable } from '../../schema/search-rate-limits.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AiFacade } from '../ai/ai.facade';
import { IdentityTokenService } from '../identity/identity-token.service';

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
  specialtyCode: string;
  concernId: string;
  concernCode: string;
  patientId: string;
  doctorId: string;
  adminReadQueriesId: string; // search.read_queries only
  adminManageMappingId: string; // search.manage_mapping only
  adminNoPermId: string;
}

/** The unique phrase this module's own concern matcher is guaranteed to score 1 against — see `concern-matcher.service.ts#scorePhrase`. */
const MATCH_PHRASE = 'zzzsearchendpointphrase';

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9195${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const specialtyCode = `sep_${runId}`;
  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: specialtyCode, name: `Search Endpoint Specialty ${runId}`, canPrescribe: false, isActive: true })
    .returning({ id: specialtiesTable.id });

  const concernCode = `sep_concern_${runId}`;
  const [concern] = await db
    .insert(concernsTable)
    .values({
      specialtyId: specialty.id,
      code: concernCode,
      name: `Search Endpoint Concern ${runId}`,
      matchPhrases: [MATCH_PHRASE],
      isActive: true,
    })
    .returning({ id: concernsTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Search Endpoint Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Search Endpoint Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '400.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id, isPrimary: true });
  // Wide-open availability every day, same shape `app.e2e.integration.spec.ts` uses, so ranking's earliest-slot lookup never depends on time of day.
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await db.insert(doctorAvailabilityTable).values({
      doctorId: doctor.id,
      ruleType: 'weekly',
      dayOfWeek,
      specificDate: null,
      startTime: '00:00:00',
      endTime: '23:59:00',
    });
  }

  async function makeAdmin(label: string): Promise<string> {
    const [row] = await db
      .insert(adminsTable)
      .values({ mobileNumber: nextPhone(), fullName: `${label} ${runId}` })
      .returning({ id: adminsTable.id });
    return row.id;
  }
  const adminReadQueriesId = await makeAdmin('Search Admin ReadQueries');
  const adminManageMappingId = await makeAdmin('Search Admin ManageMapping');
  const adminNoPermId = await makeAdmin('Search Admin NoPerm');

  const permissionRows = await db
    .select({ id: permissionsTable.id, key: permissionsTable.key })
    .from(permissionsTable)
    .where(inArray(permissionsTable.key, ['search.read_queries', 'search.manage_mapping']));
  const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (idByKey.size !== 2) {
    throw new Error(`Expected search.read_queries/search.manage_mapping to be seeded — found ${idByKey.size}/2.`);
  }
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminReadQueriesId, permissionId: idByKey.get('search.read_queries')! });
  await db.insert(adminPermissionGrantsTable).values({ adminId: adminManageMappingId, permissionId: idByKey.get('search.manage_mapping')! });

  return {
    runId,
    specialtyId: specialty.id,
    specialtyCode,
    concernId: concern.id,
    concernCode,
    patientId: patient.id,
    doctorId: doctor.id,
    adminReadQueriesId,
    adminManageMappingId,
    adminNoPermId,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const adminIds = [fixtures.adminReadQueriesId, fixtures.adminManageMappingId, fixtures.adminNoPermId];

  await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
  await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
  await db.delete(searchRateLimitsTable).where(eq(searchRateLimitsTable.patientId, fixtures.patientId));
  await db.delete(searchQueriesTable).where(eq(searchQueriesTable.patientId, fixtures.patientId));
  await db.delete(doctorAvailabilityTable).where(eq(doctorAvailabilityTable.doctorId, fixtures.doctorId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(concernsTable).where(eq(concernsTable.id, fixtures.concernId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/* -------------------------------------------------------------------------- */

describe('M-09 Search — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let patientToken: string;
  let doctorToken: string;
  let adminReadQueriesToken: string;
  let adminManageMappingToken: string;
  let adminNoPermToken: string;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    patientToken = (await tokenService.mintTokenPair('patient', fixtures.patientId, 0)).accessToken;
    // Only used to prove the account-type gate — this route never reads doctor data.
    doctorToken = (await tokenService.mintTokenPair('doctor', fixtures.doctorId, 0)).accessToken;
    adminReadQueriesToken = (await tokenService.mintTokenPair('admin', fixtures.adminReadQueriesId, 0)).accessToken;
    adminManageMappingToken = (await tokenService.mintTokenPair('admin', fixtures.adminManageMappingId, 0)).accessToken;
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
  /* POST /search/discover                                                   */
  /* ====================================================================== */

  describe('POST /search/discover', () => {
    it('a crisis phrase short-circuits the whole pipeline: emergency guidance, ZERO results, no doctor read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/discover',
        headers: auth(patientToken),
        payload: { queryText: 'I feel like I want to attempt suicide tonight' },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{
        crisis: { message: string; helplines: unknown[] } | null;
        results: unknown[];
        meta: { crisisGuardrailFired: boolean; interpretation: string; resultCount: number };
      }>(res);
      expect(body.crisis).not.toBeNull();
      expect(body.crisis!.helplines.length).toBeGreaterThan(0);
      expect(body.results).toEqual([]);
      expect(body.meta.crisisGuardrailFired).toBe(true);
      expect(body.meta.resultCount).toBe(0);

      const rows = await db
        .select({ crisisGuardrailFired: searchQueriesTable.crisisGuardrailFired, resultCount: searchQueriesTable.resultCount })
        .from(searchQueriesTable)
        .where(eq(searchQueriesTable.patientId, fixtures.patientId));
      expect(rows.some((row) => row.crisisGuardrailFired === true && row.resultCount === 0)).toBe(true);
    });

    it('a deterministic, non-AI query matches the seeded concern/specialty and finds the seeded doctor — no AI credential exists, so this exercises the real outage path, not a stub', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/discover',
        headers: auth(patientToken),
        payload: { queryText: `I have been struggling with ${MATCH_PHRASE} for weeks` },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{
        crisis: unknown;
        matchedConcerns: Array<{ id: string }>;
        matchedSpecialties: Array<{ id: string }>;
        results: Array<{ doctorId: string }>;
        meta: { interpretation: string; aiEnabled: boolean };
        disclaimer: string;
      }>(res);
      expect(body.crisis).toBeNull();
      expect(body.matchedConcerns.map((c) => c.id)).toContain(fixtures.concernId);
      expect(body.matchedSpecialties.map((s) => s.id)).toContain(fixtures.specialtyId);
      expect(body.results.map((r) => r.doctorId)).toContain(fixtures.doctorId);
      expect(body.meta.interpretation).toBe('deterministic');
      expect(typeof body.disclaimer).toBe('string');
      expect(body.disclaimer.length).toBeGreaterThan(0);
    });

    it('the AI-assisted path, stubbed at the real DI-resolved AiFacade — the interpretation-mapping code runs, no network call is made', async () => {
      const ai = app.get(AiFacade);
      const isAvailableSpy = jest.spyOn(ai, 'isAvailable').mockResolvedValue(true);
      const completeSpy = jest.spyOn(ai, 'completeStructured').mockResolvedValue({
        value: {
          concernCodes: [fixtures.concernCode],
          professionalTypes: [fixtures.specialtyCode],
          guidance: `You can talk to a {{specialty:${fixtures.specialtyCode}}} about {{concern:${fixtures.concernCode}}}.`,
        },
        model: 'test-stub-model',
        latencyMs: 3,
        profileId: 'test-stub-profile',
      });

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/search/discover',
          headers: auth(patientToken),
          payload: { queryText: 'a completely different phrasing the ai would interpret' },
        });
        expect(res.statusCode).toBe(201);
        const body = payload<{
          meta: { interpretation: string };
          guidance: { text: string; source: string; references: Array<{ code: string }> };
          matchedConcerns: Array<{ id: string }>;
        }>(res);
        expect(body.meta.interpretation).toBe('ai');
        expect(body.guidance.source).toBe('model');
        expect(body.guidance.references.some((r) => r.code === fixtures.concernCode || r.code === fixtures.specialtyCode)).toBe(true);
        expect(body.matchedConcerns.map((c) => c.id)).toContain(fixtures.concernId);
        expect(completeSpy).toHaveBeenCalledTimes(1);

        // The AI-path rate limiter really recorded the attempt in Postgres.
        const rateLimitRows = await db.select().from(searchRateLimitsTable).where(eq(searchRateLimitsTable.patientId, fixtures.patientId));
        expect(rateLimitRows.length).toBeGreaterThan(0);
      } finally {
        isAvailableSpy.mockRestore();
        completeSpy.mockRestore();
      }
    });

    it('exhausting search.rate_limit_per_hour on the AI path is refused 429 SEARCH_RATE_LIMITED — a crisis query is unaffected by the same throttle', async () => {
      const ai = app.get(AiFacade);
      const isAvailableSpy = jest.spyOn(ai, 'isAvailable').mockResolvedValue(true);
      const completeSpy = jest.spyOn(ai, 'completeStructured').mockResolvedValue({
        value: { concernCodes: [], professionalTypes: [], guidance: 'general guidance with no tokens' },
        model: 'test-stub-model',
        latencyMs: 1,
        profileId: 'test-stub-profile',
      });

      try {
        // Fill the bucket to the seeded `search.rate_limit_per_hour` (30) for this patient.
        const rows = Array.from({ length: 30 }, () => ({ patientId: fixtures.patientId, source: 'app' as const }));
        await db.insert(searchRateLimitsTable).values(rows);

        const throttled = await app.inject({
          method: 'POST',
          url: '/api/search/discover',
          headers: auth(patientToken),
          payload: { queryText: 'one more ai-assisted question please' },
        });
        expect(throttled.statusCode).toBe(429);
        const body = payload<{ code: string; retryAfterSeconds: number }>(throttled);
        expect(body.code).toBe('SEARCH_RATE_LIMITED');
        expect(typeof body.retryAfterSeconds).toBe('number');

        // The crisis gate runs BEFORE the rate limiter and is never throttled.
        const crisisStillWorks = await app.inject({
          method: 'POST',
          url: '/api/search/discover',
          headers: auth(patientToken),
          payload: { queryText: 'I want to end my life' },
        });
        expect(crisisStillWorks.statusCode).toBe(201);
        expect(payload<{ crisis: unknown }>(crisisStillWorks).crisis).not.toBeNull();
      } finally {
        isAvailableSpy.mockRestore();
        completeSpy.mockRestore();
      }
    });

    it('validation: an empty queryText is refused 400 VALIDATION_FAILED', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/search/discover', headers: auth(patientToken), payload: { queryText: '' } });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401, wrong account type (doctor token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'POST', url: '/api/search/discover', payload: { queryText: 'anything' } });
      expect(anon.statusCode).toBe(401);

      const wrongType = await app.inject({ method: 'POST', url: '/api/search/discover', headers: auth(doctorToken), payload: { queryText: 'anything' } });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* POST /search/guided                                                     */
  /* ====================================================================== */

  describe('POST /search/guided', () => {
    it('a preselected concern floors its score and always survives, even with off-topic phrasing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/guided',
        headers: auth(patientToken),
        payload: { concernIds: [fixtures.concernId], forSelf: true, ageBand: 'adult', supportPreference: 'talking' },
      });
      expect(res.statusCode).toBe(201);
      const body = payload<{ matchedConcerns: Array<{ id: string }>; matchedSpecialties: Array<{ id: string }> }>(res);
      expect(body.matchedConcerns.map((c) => c.id)).toContain(fixtures.concernId);
      expect(body.matchedSpecialties.map((s) => s.id)).toContain(fixtures.specialtyId);
    });

    it('with nothing chosen, still returns a valid 200-shaped response (browse suggestions) rather than an error', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/search/guided', headers: auth(patientToken), payload: { forSelf: false } });
      expect(res.statusCode).toBe(201);
      const body = payload<{ suggestions: { concerns: unknown[]; specialties: unknown[] } }>(res);
      expect(Array.isArray(body.suggestions.concerns)).toBe(true);
    });

    it('validation: forSelf is required — omitting it is refused 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/search/guided', headers: auth(patientToken), payload: {} });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401, wrong account type is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'POST', url: '/api/search/guided', payload: { forSelf: true } });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'POST', url: '/api/search/guided', headers: auth(doctorToken), payload: { forSelf: true } });
      expect(wrongType.statusCode).toBe(403);
    });
  });

  /* ====================================================================== */
  /* GET /search/recent                                                      */
  /* ====================================================================== */

  describe('GET /search/recent', () => {
    it("lists this patient's own non-crisis searches, newest first, and never a crisis-fired one", async () => {
      await app.inject({
        method: 'POST',
        url: '/api/search/discover',
        headers: auth(patientToken),
        payload: { queryText: `recent test query ${MATCH_PHRASE}` },
      });

      const res = await app.inject({ method: 'GET', url: '/api/search/recent', headers: auth(patientToken) });
      expect(res.statusCode).toBe(200);
      const recents = payload<Array<{ queryText: string }>>(res);
      expect(recents.some((r) => r.queryText.includes(MATCH_PHRASE))).toBe(true);
      // The crisis-fired query from an earlier test is never present here.
      expect(recents.some((r) => r.queryText.toLowerCase().includes('suicide'))).toBe(false);
    });

    it('validation: limit above the hard cap (10) is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/recent?limit=11', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/recent' });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* GET /search/popular, /search/concerns, /search/professional-types       */
  /* ====================================================================== */

  describe('browse surfaces', () => {
    it('GET /search/popular returns the admin-edited popular list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/popular', headers: auth(patientToken) });
      expect(res.statusCode).toBe(200);
      const list = payload<Array<{ label: string; query: string }>>(res);
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toHaveProperty('label');
      expect(list[0]).toHaveProperty('query');
    });

    it('GET /search/concerns lists the seeded concern, filterable by specialtyId', async () => {
      const all = await app.inject({ method: 'GET', url: '/api/search/concerns', headers: auth(patientToken) });
      expect(all.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(all).map((c) => c.id)).toContain(fixtures.concernId);

      const filtered = await app.inject({ method: 'GET', url: `/api/search/concerns?specialtyId=${fixtures.specialtyId}`, headers: auth(patientToken) });
      expect(payload<Array<{ id: string }>>(filtered).map((c) => c.id)).toContain(fixtures.concernId);
    });

    it('GET /search/concerns validation: a malformed specialtyId is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/concerns?specialtyId=not-a-uuid', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('GET /search/professional-types lists the seeded specialty', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/professional-types', headers: auth(patientToken) });
      expect(res.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(res).map((s) => s.id)).toContain(fixtures.specialtyId);
    });

    it('unauthenticated is 401 for all three', async () => {
      const popular = await app.inject({ method: 'GET', url: '/api/search/popular' });
      const concerns = await app.inject({ method: 'GET', url: '/api/search/concerns' });
      const types = await app.inject({ method: 'GET', url: '/api/search/professional-types' });
      expect(popular.statusCode).toBe(401);
      expect(concerns.statusCode).toBe(401);
      expect(types.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* GET /search/doctors                                                     */
  /* ====================================================================== */

  describe('GET /search/doctors — plain filtered listing, no query or concern mapping', () => {
    it('lists the seeded doctor under its specialty, sortable by fee', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/search/doctors?specialtyId=${fixtures.specialtyId}&sort=fee_asc`,
        headers: auth(patientToken),
      });
      expect(res.statusCode).toBe(200);
      const doctors = payload<Array<{ doctorId: string; consultationFeeInr: string }>>(res);
      expect(doctors.map((d) => d.doctorId)).toContain(fixtures.doctorId);
    });

    it('validation: an unknown sort value is refused 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/doctors?sort=not_a_real_sort', headers: auth(patientToken) });
      expect(res.statusCode).toBe(400);
    });

    it('unauthenticated is 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search/doctors' });
      expect(res.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* Admin: GET /admin/search/queries                                        */
  /* ====================================================================== */

  describe('GET /admin/search/queries — permission-gated on search.read_queries', () => {
    it('403 without the permission (even holding a different search permission), 200 with it', async () => {
      const wrongPerm = await app.inject({ method: 'GET', url: '/api/admin/search/queries', headers: auth(adminManageMappingToken) });
      expect(wrongPerm.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongPerm).code).toBe('PERMISSION_DENIED');

      const rightPerm = await app.inject({ method: 'GET', url: '/api/admin/search/queries', headers: auth(adminReadQueriesToken) });
      expect(rightPerm.statusCode).toBe(200);
      expect(Array.isArray(payload<unknown[]>(rightPerm))).toBe(true);
    });

    it('filters by maxResultCount=0 (FR-5.7\'s "phrasings that returned nothing")', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/search/queries?maxResultCount=0', headers: auth(adminReadQueriesToken) });
      expect(res.statusCode).toBe(200);
      const rows = payload<Array<{ resultCount: number }>>(res);
      expect(rows.every((row) => row.resultCount <= 0)).toBe(true);
    });

    it('unauthenticated is 401, wrong account type (patient token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/search/queries' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/search/queries', headers: auth(patientToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });

  /* ====================================================================== */
  /* Admin: GET/PUT /admin/search/config                                     */
  /* ====================================================================== */

  describe('GET/PUT /admin/search/config — permission-gated on search.manage_mapping', () => {
    it('GET: 403 without the permission (even holding search.read_queries), 200 with it', async () => {
      const wrongPerm = await app.inject({ method: 'GET', url: '/api/admin/search/config', headers: auth(adminReadQueriesToken) });
      expect(wrongPerm.statusCode).toBe(403);

      const rightPerm = await app.inject({ method: 'GET', url: '/api/admin/search/config', headers: auth(adminManageMappingToken) });
      expect(rightPerm.statusCode).toBe(200);
      const config = payload<{ maxResults: number; aiEnabled: boolean; rateLimitPerHour: number }>(rightPerm);
      expect(typeof config.maxResults).toBe('number');
    });

    it('PUT: 403 without the permission; with it, a partial update writes only the given key and is restored immediately after', async () => {
      const noPerm = await app.inject({ method: 'PUT', url: '/api/admin/search/config', headers: auth(adminReadQueriesToken), payload: { maxResults: 5 } });
      expect(noPerm.statusCode).toBe(403);

      const before = payload<{ maxResults: number }>(
        await app.inject({ method: 'GET', url: '/api/admin/search/config', headers: auth(adminManageMappingToken) }),
      );

      const updated = await app.inject({
        method: 'PUT',
        url: '/api/admin/search/config',
        headers: auth(adminManageMappingToken),
        payload: { maxResults: 7 },
      });
      expect(updated.statusCode).toBe(200);
      expect(payload<{ maxResults: number }>(updated).maxResults).toBe(7);

      // Restored immediately — this is a shared, global `app_config` row, not a namespaced fixture.
      const restored = await app.inject({
        method: 'PUT',
        url: '/api/admin/search/config',
        headers: auth(adminManageMappingToken),
        payload: { maxResults: before.maxResults },
      });
      expect(payload<{ maxResults: number }>(restored).maxResults).toBe(before.maxResults);
    });

    it('validation: an empty crisisKeywords array is refused 400 by the DTO before it ever reaches the service (never actually written)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/search/config',
        headers: auth(adminManageMappingToken),
        payload: { crisisKeywords: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('VALIDATION_FAILED');
    });

    it('unauthenticated is 401, wrong account type (doctor token) is 403 WRONG_ACCOUNT_TYPE', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/admin/search/config' });
      expect(anon.statusCode).toBe(401);
      const wrongType = await app.inject({ method: 'GET', url: '/api/admin/search/config', headers: auth(doctorToken) });
      expect(wrongType.statusCode).toBe(403);
      expect(payload<{ code: string }>(wrongType).code).toBe('WRONG_ACCOUNT_TYPE');
    });
  });
});
