/**
 * *** HTTP-LEVEL ENDPOINT TESTS FOR `legal-document-public.controller.ts`. ***
 *
 * Everything the AUDIENCE RESOLUTION does (per-app override wins, falls
 * back to the shared `'all'` document, 404 when neither exists) is already
 * proven at the unit level in `legal-document.service.spec.ts`. This file
 * proves what is unique to the HTTP layer: `Accept`-header negotiation, the
 * `?format=` override, the rendered HTML page, and the raw-JSON shape a
 * mobile client reads.
 *
 * *** PURELY READ-ONLY — NO FIXTURE WRITES, NO TEARDOWN. *** Reads the REAL,
 * PERMANENT `privacy_policy`/`terms_of_use` rows `consent.seed.ts` publishes
 * (`patient`/`doctor` audience, never `'all'`). Earlier drafts of this file
 * admin-published a throwaway `refund_policy` version for `patient`/`doctor`
 * audience instead — that broke `consent.endpoint.spec.ts`'s own
 * `refund_policy` patient-consent-status assertions running concurrently in
 * another Jest worker, because "does this patient's own audience override
 * win" is exactly the FEATURE under test: publishing one, even briefly,
 * changes what every OTHER caller's consent check for that type sees, not
 * just this file's own requests. `privacy_policy`/`terms_of_use` are safe
 * because nothing anywhere ever `POST /consents` accepts them (only
 * `teleconsultation_consent`, `refund_policy`, `reconsult_policy` and
 * `doctor_agreement` are ever offered for acceptance) — reading them can
 * never change another test's answer, and reading permanent seeded rows
 * needs no admin token, no writes, and no cleanup.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { loadEnvFiles } from '../../config/env/env.validation';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

describe('Public legal-document route — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('no token required at all', () => {
    it('200s with no Authorization header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/privacy_policy?audience=patient' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('content negotiation', () => {
    it('Accept: application/json returns the raw Markdown body, unrendered', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/privacy_policy?audience=patient',
        headers: { accept: 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const body = payload<{ documentType: string; audience: string; format: string; body: string }>(res);
      expect(body.documentType).toBe('privacy_policy');
      expect(body.audience).toBe('patient');
      expect(body.format).toBe('markdown');
      expect(body.body).toContain('## 1. What we collect'); // raw, not rendered
      expect(body.body).not.toContain('<h2>');
    });

    it('Accept: text/html returns a rendered HTML page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/privacy_policy?audience=patient',
        headers: { accept: 'text/html,application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<h1>Privacy Policy (Patient App)</h1>');
      expect(res.body).toContain('<a href="mailto:privacy@example.com"');
      expect(res.body).toContain('Version placeholder-v1');
    });

    it('no Accept header at all defaults to JSON, not HTML', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/privacy_policy?audience=patient' });
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('?format=html forces HTML even when Accept prefers JSON', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/privacy_policy?audience=patient&format=html',
        headers: { accept: 'application/json' },
      });
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('?format=json forces JSON even when Accept prefers HTML', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/privacy_policy?audience=patient&format=json',
        headers: { accept: 'text/html' },
      });
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  describe('per-app audience', () => {
    it('serves the doctor-audience document separately from the patient one', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/terms_of_use?audience=doctor', headers: { accept: 'application/json' } });
      const body = payload<{ audience: string; body: string }>(res);
      expect(body.audience).toBe('doctor');
      expect(body.body).toContain('## 1. Conduct'); // the doctor-only section — the patient body has no such heading
      expect(body.body).not.toContain('## 1. The service'); // the patient-only section
    });
  });

  describe('errors', () => {
    /**
     * *** WHY `?audience=all`, NOT AN UNAUDIENCED TYPE. *** `consent.seed.ts`
     * permanently publishes a real `privacy_policy`/`terms_of_use` for BOTH
     * `patient` and `doctor` — every real document type now has something
     * published for some audience, so "a type with nothing published,
     * anywhere" no longer exists to test against. What the seed deliberately
     * NEVER touches is the shared `'all'` cell of either type (its own
     * header states this explicitly) — an explicit `?audience=all` request
     * resolves straight to that cell with no per-app fallback (see
     * `legal-document.service.ts#resolveCurrent`), so it stays a reliable,
     * permanent 404.
     */
    it('404s NO_CURRENT_LEGAL_DOCUMENT for an explicit audience=all request where only per-app overrides are published', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/terms_of_use?audience=all' });
      expect(res.statusCode).toBe(404);
      expect(payload<{ code: string }>(res).code).toBe('NO_CURRENT_LEGAL_DOCUMENT');
    });

    it('400s an unknown documentType path segment before any query runs', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/not-a-real-type' });
      expect(res.statusCode).toBe(400);
      expect(payload<{ code: string }>(res).code).toBe('UNKNOWN_DOCUMENT_TYPE');
    });

    it('an unrecognised ?audience= value is treated as "all", not rejected', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/terms_of_use?audience=nonsense' });
      // Falls back to 'all' (empty here) rather than a 400 — an unknown
      // query value degrading to the safe default, same posture
      // `release-config.service.ts` takes for a malformed stored value.
      expect(res.statusCode).toBe(404);
    });
  });
});
