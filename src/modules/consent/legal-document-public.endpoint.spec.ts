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
 * *** WHY `refund_policy`, AUDIENCE `'patient'`/`'doctor'` — NEVER `'all'`. ***
 * `consent.endpoint.spec.ts`'s own header explains the discipline this file
 * follows: pick a (document type, audience) cell nothing else in the
 * codebase touches, so parallel Jest workers hitting the same real Postgres
 * can never race each other's "current version" state. `refund_policy`'s
 * `'all'` cell already belongs to `consent.endpoint.spec.ts`'s own v1->v2
 * flow — this file only ever writes to its PATIENT and DOCTOR cells, which
 * were free the day the `audience` column was added and stay free as long
 * as nothing else claims them.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';
import { permissionsTable } from '../../schema/permissions.schema';
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
  adminId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const [admin] = await db.insert(adminsTable).values({ mobileNumber: `+9187${runId.slice(0, 6)}01`, fullName: `Legal Public Admin ${runId}` }).returning({ id: adminsTable.id });

  const [perm] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, 'compliance.manage_legal_documents'));
  if (!perm) throw new Error('Expected compliance.manage_legal_documents to be seeded.');
  await db.insert(adminPermissionGrantsTable).values({ adminId: admin.id, permissionId: perm.id });

  return { runId, adminId: admin.id };
}

async function teardown(db: Database, fixtures: Fixtures, createdLegalDocumentIds: string[]): Promise<void> {
  if (createdLegalDocumentIds.length > 0) {
    await db.delete(legalDocumentsTable).where(inArray(legalDocumentsTable.id, createdLegalDocumentIds));
  }
  await db.delete(adminPermissionGrantsTable).where(eq(adminPermissionGrantsTable.adminId, fixtures.adminId));
  await db.delete(adminsTable).where(eq(adminsTable.id, fixtures.adminId));
}

describe('Public legal-document route — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let adminToken: string;
  const createdLegalDocumentIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    fixtures = await seedFixtures(db);

    const tokenService = app.get(IdentityTokenService);
    adminToken = (await tokenService.mintTokenPair('admin', fixtures.adminId, 0)).accessToken;

    // Publish a real current refund_policy/patient and refund_policy/doctor
    // version through the actual admin API — this file's own dedicated cells.
    const publish = async (audience: 'patient' | 'doctor', body: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { documentType: 'refund_policy', audience, version: `${audience}-${fixtures.runId}`, title: `Refund Policy (${audience})`, body, publish: true },
      });
      const created = payload<{ id: string }>(res);
      createdLegalDocumentIds.push(created.id);
    };

    await publish('patient', '# Refund Policy\n\nWe refund within **7 days**.');
    await publish('doctor', 'Doctor-facing refund terms.');
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures, createdLegalDocumentIds);
    } finally {
      if (app) await app.close();
    }
  });

  describe('no token required at all', () => {
    it('200s with no Authorization header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/refund_policy?audience=patient' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('content negotiation', () => {
    it('Accept: application/json returns the raw Markdown body, unrendered', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/refund_policy?audience=patient',
        headers: { accept: 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const body = payload<{ documentType: string; audience: string; format: string; body: string }>(res);
      expect(body.documentType).toBe('refund_policy');
      expect(body.audience).toBe('patient');
      expect(body.format).toBe('markdown');
      expect(body.body).toContain('**7 days**'); // raw, not rendered
      expect(body.body).not.toContain('<strong>');
    });

    it('Accept: text/html returns a rendered HTML page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/refund_policy?audience=patient',
        headers: { accept: 'text/html,application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<strong>7 days</strong>');
      expect(res.body).toContain('<h1>Refund Policy</h1>');
      expect(res.body).toContain(`Version patient-${fixtures.runId}`);
    });

    it('no Accept header at all defaults to JSON, not HTML', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/refund_policy?audience=patient' });
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('?format=html forces HTML even when Accept prefers JSON', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/refund_policy?audience=patient&format=html',
        headers: { accept: 'application/json' },
      });
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('?format=json forces JSON even when Accept prefers HTML', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/legal/refund_policy?audience=patient&format=json',
        headers: { accept: 'text/html' },
      });
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  describe('per-app audience', () => {
    it('serves the doctor-audience document separately from the patient one', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/refund_policy?audience=doctor', headers: { accept: 'application/json' } });
      const body = payload<{ audience: string; body: string }>(res);
      expect(body.audience).toBe('doctor');
      expect(body.body).toBe('Doctor-facing refund terms.');
    });
  });

  describe('errors', () => {
    it('404s NO_CURRENT_LEGAL_DOCUMENT when nothing is published for the type at all (terms_of_use, deliberately left empty)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/legal/terms_of_use?audience=doctor' });
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
      // Falls back to 'all' (empty for terms_of_use) rather than a 400 —
      // an unknown query value degrading to the safe default, same posture
      // `release-config.service.ts` takes for a malformed stored value.
      expect(res.statusCode).toBe(404);
    });
  });
});
