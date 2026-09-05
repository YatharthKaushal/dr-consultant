/**
 * *** REAL-HTTP ENDPOINT TESTS — `consent` MODULE. ***
 *
 * Drives every route in `legal-document.controller.ts`,
 * `legal-document-admin.controller.ts`, `consent.controller.ts`,
 * `data-deletion.controller.ts` and `data-deletion-admin.controller.ts`
 * through `createConfiguredApp()` + `app.inject()` — real guards, real
 * `ValidationPipe`, real database. No vendor to mock (this module never
 * calls Slide/Razorpay/LiveKit); every account's token is minted directly
 * via `IdentityTokenService.mintTokenPair`, the same real signer a genuine
 * OTP sign-in hands its result to.
 *
 * *** WHY refund_policy, NOT teleconsultation_consent, CARRIES THIS FILE'S
 * VERSIONING FLOW. *** `teleconsultation_consent` already has a real current
 * version shared by every other real-database spec in this codebase
 * (`app.e2e.integration.spec.ts` reuses it and refuses to touch it once it
 * exists — see that file's `seedFixtures`). Superseding it here to test
 * `SUPERSEDED_LEGAL_DOCUMENT` would risk breaking every other suite running
 * concurrently against the one shared database. `refund_policy` has zero
 * rows in a fresh dev database and nothing else in this codebase currently
 * publishes it, so this file publishes its OWN v1 -> v2 there, deterministic
 * and fully torn down at the end — never depending on ambient state, except
 * the one explicitly-marked case below that reads live state because the
 * thing under test (a document type with literally nothing published) has
 * no other way to be constructed.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { dataDeletionRequestsTable } from '../../schema/data-deletion-requests.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import type { AccountType } from '../../schema/enums.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';
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

function pgArray(values: readonly string[], type: 'uuid' | 'varchar') {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`);
  return sql.raw(`array['${values.join("','")}']::${type}[]`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixtures {
  runId: string;
  patientId: string;
  otherPatientId: string;
  doctorId: string;
  adminAllId: string;
  adminNoneId: string;
}

async function permissionId(db: Database, key: string): Promise<string> {
  const [row] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, key)).limit(1);
  if (!row) {
    throw new Error(`Fixture precondition failed: permission "${key}" not found — run identity.seed.ts against this database first.`);
  }
  return row.id;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9177${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Consent Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [otherPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Consent Other Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Consent Doctor ${runId}` })
    .returning({ id: doctorsTable.id });

  const [adminAll] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Consent Admin All ${runId}` })
    .returning({ id: adminsTable.id });
  const [adminNone] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Consent Admin None ${runId}` })
    .returning({ id: adminsTable.id });

  for (const key of [PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS, PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS]) {
    const permId = await permissionId(db, key);
    await db.insert(adminPermissionGrantsTable).values({ adminId: adminAll.id, permissionId: permId });
  }

  return { runId, patientId: patient.id, otherPatientId: otherPatient.id, doctorId: doctor.id, adminAllId: adminAll.id, adminNoneId: adminNone.id };
}

/** Legal document ids this file creates via HTTP — tracked for teardown. */
const createdLegalDocumentIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.patientId, fixtures.otherPatientId];
  const adminIds = [fixtures.adminAllId, fixtures.adminNoneId];

  await db.execute(sql`delete from consents where patient_id = any(${pgArray(patientIds, 'uuid')}) or doctor_id = ${fixtures.doctorId}`);
  await db.delete(dataDeletionRequestsTable).where(sql`${dataDeletionRequestsTable.patientId} = any(${pgArray(patientIds, 'uuid')})`);
  await db.delete(legalDocumentsTable).where(sql`${legalDocumentsTable.id} = any(${pgArray(createdLegalDocumentIds, 'uuid')})`);

  await db.execute(sql`delete from admin_permission_grants where admin_id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from admins where id = any(${pgArray(adminIds, 'uuid')})`);
  await db.execute(sql`delete from patients where id = any(${pgArray(patientIds, 'uuid')})`);
  await db.execute(sql`delete from doctors where id = ${fixtures.doctorId}`);

  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...createdLegalDocumentIds], 'varchar')}) or actor_id = any(${pgArray([...patientIds, fixtures.doctorId, ...adminIds], 'uuid')})`,
  );
}

/* -------------------------------------------------------------------------- */

describe('consent module — real HTTP endpoint tests', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;
  let tokenService: IdentityTokenService;

  const tokens: Record<string, string> = {};
  /** Populated by the version-lifecycle block, consumed by the consent-recording block. */
  const refundPolicy: { v1Id?: string; v1Version?: string; v2Id?: string; v2Version?: string } = {};
  let doctorAgreementCurrentId: string;

  async function mint(accountType: AccountType, accountId: string): Promise<string> {
    const pair = await tokenService.mintTokenPair(accountType, accountId, 0);
    return pair.accessToken;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    tokenService = app.get(IdentityTokenService);

    fixtures = await seedFixtures(db);

    tokens.patient = await mint('patient', fixtures.patientId);
    tokens.otherPatient = await mint('patient', fixtures.otherPatientId);
    tokens.doctor = await mint('doctor', fixtures.doctorId);
    tokens.adminAll = await mint('admin', fixtures.adminAllId);
    tokens.adminNone = await mint('admin', fixtures.adminNoneId);

    // A CURRENT doctor_agreement, published directly (not through the admin
    // HTTP route) purely as fixture setup — its own creation is exercised via
    // HTTP separately below (refund_policy). Doctor accepts it for real.
    const [doc] = await db
      .insert(legalDocumentsTable)
      .values({
        documentType: 'doctor_agreement',
        version: `da-${fixtures.runId}`,
        title: 'Doctor Agreement (fixture)',
        body: 'Fixture doctor agreement text.',
        isCurrent: true,
      })
      .returning({ id: legalDocumentsTable.id });
    doctorAgreementCurrentId = doc.id;
    createdLegalDocumentIds.push(doc.id);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      if (app) await app.close();
    }
  });

  /* ====================================================================== */
  /* Admin legal-documents — the version lifecycle refund_policy proves      */
  /* ====================================================================== */

  describe('admin/legal-documents — auth boundary', () => {
    it('a doctor token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/legal-documents', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/legal-documents' });
      expect(response.statusCode).toBe(401);
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/legal-documents', headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('POST /admin/legal-documents (v1, unpublished)', () => {
    it('creates a new version WITHOUT publishing it — isCurrent stays false', async () => {
      refundPolicy.v1Version = `v1-${fixtures.runId}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: auth(tokens.adminAll),
        payload: { documentType: 'refund_policy', version: refundPolicy.v1Version, title: 'Refund Policy v1', body: 'v1 body text.' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; isCurrent: boolean; version: string }>(response);
      expect(body.isCurrent).toBe(false);
      refundPolicy.v1Id = body.id;
      createdLegalDocumentIds.push(body.id);
    });

    it('a duplicate (documentType, version) pair is refused — 409 LEGAL_DOCUMENT_VERSION_TAKEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: auth(tokens.adminAll),
        payload: { documentType: 'refund_policy', version: refundPolicy.v1Version, title: 'Duplicate', body: 'x' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('LEGAL_DOCUMENT_VERSION_TAKEN');
    });

    it('a missing required field (body) is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: auth(tokens.adminAll),
        payload: { documentType: 'refund_policy', version: `bad-${fixtures.runId}`, title: 'No body' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('an invalid version format is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: auth(tokens.adminAll),
        payload: { documentType: 'refund_policy', version: 'has spaces!', title: 'Bad version', body: 'x' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /admin/legal-documents (v2, publish: true) — publishing supersedes v1', () => {
    it('creates v2 published in the same transaction; v1 is demoted', async () => {
      refundPolicy.v2Version = `v2-${fixtures.runId}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/legal-documents',
        headers: auth(tokens.adminAll),
        payload: { documentType: 'refund_policy', version: refundPolicy.v2Version, title: 'Refund Policy v2', body: 'v2 body text.', publish: true },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; isCurrent: boolean }>(response);
      expect(body.isCurrent).toBe(true);
      refundPolicy.v2Id = body.id;
      createdLegalDocumentIds.push(body.id);

      const [v1Row] = await db.select({ isCurrent: legalDocumentsTable.isCurrent }).from(legalDocumentsTable).where(eq(legalDocumentsTable.id, refundPolicy.v1Id!));
      expect(v1Row.isCurrent).toBe(false);
    });
  });

  describe('GET /admin/legal-documents and /admin/legal-documents/:id (COMPLIANCE_MANAGE_LEGAL_DOCUMENTS)', () => {
    it('lists the version history, filterable by documentType', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/legal-documents?documentType=refund_policy',
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(200);
      const ids = payload<Array<{ id: string }>>(response).map((d) => d.id);
      expect(ids).toEqual(expect.arrayContaining([refundPolicy.v1Id, refundPolicy.v2Id]));
    });

    it('a nonexistent id is 404 LEGAL_DOCUMENT_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/legal-documents/${randomUUID()}`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('LEGAL_DOCUMENT_NOT_FOUND');
    });
  });

  describe('POST /admin/legal-documents/:id/publish', () => {
    it('re-publishing the already-current v2 is idempotent — 200, still current', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/legal-documents/${refundPolicy.v2Id}/publish`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(201);
      expect(payload<{ isCurrent: boolean }>(response).isCurrent).toBe(true);
    });

    it('publishing v1 again promotes it back and demotes v2', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/legal-documents/${refundPolicy.v1Id}/publish`,
        headers: auth(tokens.adminAll),
      });
      expect(response.statusCode).toBe(201);
      expect(payload<{ isCurrent: boolean }>(response).isCurrent).toBe(true);

      const [v2Row] = await db.select({ isCurrent: legalDocumentsTable.isCurrent }).from(legalDocumentsTable).where(eq(legalDocumentsTable.id, refundPolicy.v2Id!));
      expect(v2Row.isCurrent).toBe(false);

      // Publish v2 back so the rest of this file (and the consent flow below) sees the version order it expects.
      const restore = await app.inject({ method: 'POST', url: `/api/admin/legal-documents/${refundPolicy.v2Id}/publish`, headers: auth(tokens.adminAll) });
      expect(restore.statusCode).toBe(201);
    });

    it('a nonexistent id is 404 LEGAL_DOCUMENT_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'POST', url: `/api/admin/legal-documents/${randomUUID()}/publish`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* Public legal-document reads (FR-2.4)                                    */
  /* ====================================================================== */

  describe('GET /legal-documents', () => {
    it('a patient sees refund_policy v2 but never doctor_agreement', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const list = payload<Array<{ id: string; documentType: string }>>(response);
      expect(list.map((d) => d.id)).toContain(refundPolicy.v2Id);
      expect(list.map((d) => d.documentType)).not.toContain('doctor_agreement');
    });

    it('a doctor DOES see doctor_agreement — only patients are filtered', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(200);
      const list = payload<Array<{ id: string }>>(response);
      expect(list.map((d) => d.id)).toContain(doctorAgreementCurrentId);
    });

    it('refuses an unauthenticated call — 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /legal-documents/:documentType', () => {
    it('returns the current refund_policy in full, including body', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents/refund_policy', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ id: string; body: string }>(response);
      expect(body.id).toBe(refundPolicy.v2Id);
      expect(body.body).toBe('v2 body text.');
    });

    it('*** EXISTENCE/READABILITY *** a patient reading doctor_agreement is 403 DOCUMENT_TYPE_NOT_READABLE_BY_ACTOR', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents/doctor_agreement', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('DOCUMENT_TYPE_NOT_READABLE_BY_ACTOR');
    });

    it('a doctor reading doctor_agreement succeeds', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents/doctor_agreement', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(200);
      expect(payload<{ id: string }>(response).id).toBe(doctorAgreementCurrentId);
    });

    it('an unknown documentType path segment is a clean 400 UNKNOWN_DOCUMENT_TYPE, not a raw enum error', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/legal-documents/not_a_real_type', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('UNKNOWN_DOCUMENT_TYPE');
    });

    /**
     * *** READS LIVE STATE, DELIBERATELY — SEE THIS FILE'S HEADER. *** This is
     * the one case in this file with no self-contained construction: it needs
     * a document TYPE with literally zero published rows anywhere, and this
     * codebase provides no route to un-publish a type back to "nothing" once
     * anything has ever been current for it. `terms_of_use` has no rows in a
     * fresh dev database and nothing else in this codebase publishes it — if
     * that is no longer true when this runs (another suite published one
     * concurrently), the test still records what actually happened rather
     * than asserting a stale assumption.
     */
    it('a document type with nothing currently published answers 404 NO_CURRENT_LEGAL_DOCUMENT (or 200 if another process published one concurrently)', async () => {
      const [current] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(and(eq(legalDocumentsTable.documentType, 'terms_of_use'), eq(legalDocumentsTable.isCurrent, true)))
        .limit(1);

      const response = await app.inject({ method: 'GET', url: '/api/legal-documents/terms_of_use', headers: auth(tokens.patient) });
      if (!current) {
        expect(response.statusCode).toBe(404);
        expect(payload<{ code: string }>(response).code).toBe('NO_CURRENT_LEGAL_DOCUMENT');
      } else {
        expect(response.statusCode).toBe(200);
      }
    });
  });

  /* ====================================================================== */
  /* Consents (FR-2.3)                                                       */
  /* ====================================================================== */

  describe('consents — auth boundary', () => {
    it('an admin token is refused as the wrong account type on POST /consents', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/consents',
        headers: auth(tokens.adminAll),
        payload: { legalDocumentId: refundPolicy.v2Id },
      });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/consents', payload: { legalDocumentId: refundPolicy.v2Id } });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /consents — the version lifecycle', () => {
    it('a nonexistent legalDocumentId is 404 LEGAL_DOCUMENT_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: randomUUID() } });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('LEGAL_DOCUMENT_NOT_FOUND');
    });

    it('a missing legalDocumentId is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: {} });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('*** BUSINESS RULE *** a patient offered doctor_agreement is refused — 409 DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/consents',
        headers: auth(tokens.patient),
        payload: { legalDocumentId: doctorAgreementCurrentId },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR');
    });

    it('*** BUSINESS RULE, OPPOSITE DIRECTION *** a doctor offered refund_policy is refused — 409 DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/consents',
        headers: auth(tokens.doctor),
        payload: { legalDocumentId: refundPolicy.v2Id },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR');
    });

    it('a doctor accepts the current doctor_agreement', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/consents',
        headers: auth(tokens.doctor),
        payload: { legalDocumentId: doctorAgreementCurrentId },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ legalDocumentId: string; documentType: string }>(response);
      expect(body.legalDocumentId).toBe(doctorAgreementCurrentId);
      expect(body.documentType).toBe('doctor_agreement');
    });

    it('a patient accepts refund_policy v1 while it is current', async () => {
      // v1 was republished current-then-demoted above and restored to v2 —
      // republish v1 again just for this step, then supersede it again below,
      // exactly mirroring the real-world sequence "accepted v1, then v2 shipped".
      const publishV1 = await app.inject({ method: 'POST', url: `/api/admin/legal-documents/${refundPolicy.v1Id}/publish`, headers: auth(tokens.adminAll) });
      expect(publishV1.statusCode).toBe(201);

      const response = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: refundPolicy.v1Id } });
      expect(response.statusCode).toBe(201);
      expect(payload<{ legalDocumentId: string }>(response).legalDocumentId).toBe(refundPolicy.v1Id);
    });

    it('GET /consents/status reports hasCurrentConsent true against v1 while v1 is current', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/status?documentType=refund_policy', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ hasCurrentConsent: boolean; acceptedVersion: string | null; currentVersion: string | null }>(response);
      expect(body.hasCurrentConsent).toBe(true);
      expect(body.acceptedVersion).toBe(refundPolicy.v1Version);
      expect(body.currentVersion).toBe(refundPolicy.v1Version);
    });

    it('admin re-publishes v2 — v1 is now superseded', async () => {
      const response = await app.inject({ method: 'POST', url: `/api/admin/legal-documents/${refundPolicy.v2Id}/publish`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(201);
    });

    it('*** BUSINESS RULE *** the patient re-offering the now-superseded v1 is refused — 409 SUPERSEDED_LEGAL_DOCUMENT', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: refundPolicy.v1Id } });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('SUPERSEDED_LEGAL_DOCUMENT');
    });

    it('GET /consents/status now reports hasCurrentConsent false — accepted v1, current is v2', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/status?documentType=refund_policy', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const body = payload<{ hasCurrentConsent: boolean; acceptedVersion: string | null; currentVersion: string | null }>(response);
      expect(body.hasCurrentConsent).toBe(false);
      expect(body.acceptedVersion).toBe(refundPolicy.v1Version);
      expect(body.currentVersion).toBe(refundPolicy.v2Version);
    });

    it('GET /consents/status is patient-only — a doctor token is refused (method-level @AccountType overrides the class)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/status?documentType=refund_policy', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('the patient accepts v2 — the current version', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: refundPolicy.v2Id } });
      expect(response.statusCode).toBe(201);
      expect(payload<{ legalDocumentId: string }>(response).legalDocumentId).toBe(refundPolicy.v2Id);
    });

    it('re-accepting v2 is idempotent — same id and timestamp returned, not a new row', async () => {
      const first = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: refundPolicy.v2Id } });
      const second = await app.inject({ method: 'POST', url: '/api/consents', headers: auth(tokens.patient), payload: { legalDocumentId: refundPolicy.v2Id } });
      const firstBody = payload<{ id: string; acceptedAt: string }>(first);
      const secondBody = payload<{ id: string; acceptedAt: string }>(second);
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.acceptedAt).toBe(firstBody.acceptedAt);
    });

    it('GET /consents/status now reports hasCurrentConsent true against v2', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/status?documentType=refund_policy', headers: auth(tokens.patient) });
      expect(payload<{ hasCurrentConsent: boolean; currentVersion: string | null }>(response).hasCurrentConsent).toBe(true);
    });
  });

  describe('GET /consents/me', () => {
    it("lists the patient's own history, newest first, with no ipAddress field", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/me', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ legalDocumentId: string; ipAddress?: unknown }>>(response);
      expect(rows.map((r) => r.legalDocumentId)).toEqual(expect.arrayContaining([refundPolicy.v1Id, refundPolicy.v2Id]));
      expect(rows.every((r) => !('ipAddress' in r))).toBe(true);
    });

    it("a doctor's own history lists only what they accepted", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/consents/me', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ legalDocumentId: string }>>(response);
      expect(rows.map((r) => r.legalDocumentId)).toEqual([doctorAgreementCurrentId]);
    });
  });

  /* ====================================================================== */
  /* Data-deletion requests — patient side (FR-2.5)                          */
  /* ====================================================================== */

  describe('data-deletion-requests — auth boundary', () => {
    it('a doctor token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/data-deletion-requests', headers: auth(tokens.doctor) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('no token is 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/data-deletion-requests' });
      expect(response.statusCode).toBe(401);
    });
  });

  let dataDeletionRequestId: string;

  describe('POST /data-deletion-requests', () => {
    it('raises a request with a reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/data-deletion-requests',
        headers: auth(tokens.patient),
        payload: { reason: 'No longer using the platform.' },
      });
      expect(response.statusCode).toBe(201);
      const body = payload<{ id: string; status: string; reason: string | null; executedAt: string | null }>(response);
      expect(body.status).toBe('requested');
      expect(body.reason).toBe('No longer using the platform.');
      expect(body.executedAt).toBeNull();
      dataDeletionRequestId = body.id;
    });

    it('*** IDEMPOTENT WHILE OPEN *** raising a second request returns the SAME open one, not a new row', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(tokens.patient), payload: {} });
      expect(response.statusCode).toBe(201);
      expect(payload<{ id: string }>(response).id).toBe(dataDeletionRequestId);
    });

    it('a reason longer than 1000 characters is a clean 400 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/data-deletion-requests',
        headers: auth(tokens.otherPatient),
        payload: { reason: 'x'.repeat(1001) },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /data-deletion-requests and /data-deletion-requests/:id', () => {
    it("lists the caller's own requests", async () => {
      const response = await app.inject({ method: 'GET', url: '/api/data-deletion-requests', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      expect(payload<Array<{ id: string }>>(response).map((r) => r.id)).toContain(dataDeletionRequestId);
    });

    it('reads one of the caller\'s own requests by id', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/data-deletion-requests/${dataDeletionRequestId}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(200);
      expect(payload<{ id: string }>(response).id).toBe(dataDeletionRequestId);
    });

    it('*** OWNERSHIP LEAK CHECK *** a DIFFERENT patient reading this id gets 404, never 403 — indistinguishable from a nonexistent id', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/data-deletion-requests/${dataDeletionRequestId}`, headers: auth(tokens.otherPatient) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DATA_DELETION_REQUEST_NOT_FOUND');
    });

    it('a genuinely nonexistent id answers the identical 404 shape', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/data-deletion-requests/${randomUUID()}`, headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DATA_DELETION_REQUEST_NOT_FOUND');
    });
  });

  /* ====================================================================== */
  /* Data-deletion requests — admin side                                     */
  /* ====================================================================== */

  describe('admin/data-deletion-requests — auth boundary', () => {
    it('a patient token is refused as the wrong account type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/data-deletion-requests', headers: auth(tokens.patient) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('WRONG_ACCOUNT_TYPE');
    });

    it('an admin with no grants is refused — 403 PERMISSION_DENIED', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/data-deletion-requests', headers: auth(tokens.adminNone) });
      expect(response.statusCode).toBe(403);
      expect(payload<{ code: string }>(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /admin/data-deletion-requests and /:id', () => {
    it('lists the queue, filterable by status', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/data-deletion-requests?status=requested', headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      const rows = payload<Array<{ id: string; status: string }>>(response);
      expect(rows.map((r) => r.id)).toContain(dataDeletionRequestId);
      expect(rows.every((r) => r.status === 'requested')).toBe(true);
    });

    it('respects limit/offset pagination', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/data-deletion-requests?limit=1&offset=0', headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(200);
      expect(payload<unknown[]>(response).length).toBeLessThanOrEqual(1);
    });

    it('a nonexistent id is 404 DATA_DELETION_REQUEST_NOT_FOUND', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/admin/data-deletion-requests/${randomUUID()}`, headers: auth(tokens.adminAll) });
      expect(response.statusCode).toBe(404);
      expect(payload<{ code: string }>(response).code).toBe('DATA_DELETION_REQUEST_NOT_FOUND');
    });
  });

  describe('PATCH /admin/data-deletion-requests/:id/review — the state machine', () => {
    it('requested -> in_review succeeds, and executedAt/executionOutcome stay null', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${dataDeletionRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'in_review', reviewNote: 'Looking into it.' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string; reviewedByAdminId: string; executedAt: string | null; executionOutcome: unknown }>(response);
      expect(body.status).toBe('in_review');
      expect(body.reviewedByAdminId).toBe(fixtures.adminAllId);
      expect(body.executedAt).toBeNull();
      expect(body.executionOutcome).toBeNull();
    });

    it('in_review -> approved succeeds', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${dataDeletionRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'approved' },
      });
      expect(response.statusCode).toBe(200);
      const body = payload<{ status: string; executedAt: string | null }>(response);
      expect(body.status).toBe('approved');
      expect(body.executedAt).toBeNull();
    });

    it('*** BUSINESS RULE *** approved is terminal from this module — 409 DATA_DELETION_ILLEGAL_TRANSITION back to in_review', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${dataDeletionRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'in_review' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string; currentStatus: string }>(response).code).toBe('DATA_DELETION_ILLEGAL_TRANSITION');
    });

    it('*** BUSINESS RULE *** rejected is also unreachable from approved — 409 DATA_DELETION_ILLEGAL_TRANSITION', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${dataDeletionRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'rejected' },
      });
      expect(response.statusCode).toBe(409);
      expect(payload<{ code: string }>(response).code).toBe('DATA_DELETION_ILLEGAL_TRANSITION');
    });

    it('a fresh request can go straight from requested to rejected', async () => {
      const raise = await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(tokens.otherPatient), payload: {} });
      const otherRequestId = payload<{ id: string }>(raise).id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${otherRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'rejected', reviewNote: 'Not eligible.' },
      });
      expect(response.statusCode).toBe(200);
      expect(payload<{ status: string }>(response).status).toBe('rejected');

      // *** IDEMPOTENCY BOUNDARY, NOT A BUG *** — a rejected request is terminal, so
      // this same patient may now raise a genuinely NEW request (their old one is no
      // longer "open": findOpenByPatient only matches requested/in_review).
      const raiseAgain = await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(tokens.otherPatient), payload: {} });
      expect(payload<{ id: string }>(raiseAgain).id).not.toBe(otherRequestId);
    });

    it('a nonexistent id is 404 DATA_DELETION_REQUEST_NOT_FOUND', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${randomUUID()}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'approved' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('an out-of-vocabulary status (e.g. "executed", M-21-only) is a clean 400 VALIDATION_FAILED, not reachable through this route', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/data-deletion-requests/${dataDeletionRequestId}/review`,
        headers: auth(tokens.adminAll),
        payload: { status: 'executed' },
      });
      expect(response.statusCode).toBe(400);
      expect(payload<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
    });

    it('*** FINAL PROOF *** re-reading the request straight from Postgres confirms executed_at/execution_outcome were never touched by any review transition above', async () => {
      const row = await db
        .select({ executedAt: dataDeletionRequestsTable.executedAt, executionOutcome: dataDeletionRequestsTable.executionOutcome, status: dataDeletionRequestsTable.status })
        .from(dataDeletionRequestsTable)
        .where(eq(dataDeletionRequestsTable.id, dataDeletionRequestId));
      expect(row[0].status).toBe('approved');
      expect(row[0].executedAt).toBeNull();
      expect(row[0].executionOutcome).toBeNull();
    });
  });
});
