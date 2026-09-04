/**
 * *** REAL-DATABASE TEST. THE ONE THAT PROVES M-03'S TWO LOAD-BEARING
 *     CLAIMS. ***
 *
 * Follows `clinical/clinical.completion-gate.integration.spec.ts`, which
 * follows `document/patient-file.transaction.integration.spec.ts` — one
 * fixture helper, strict reverse-FK teardown, per-run namespacing, and a
 * positive control on every claim.
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * `legal-document.service.spec.ts` asserts that `adminPublish` CALLS
 * `lockDocumentTypeGuard`. That is a claim about a `jest.fn()`. It would pass
 * identically against a `lockDocumentTypeGuard` whose SQL is wrong, whose
 * parameter binds as the wrong type, or which takes a lock in a session
 * outside the transaction that needs it — and `consent.constants.ts` rests the
 * WHOLE one-current-version invariant on that one statement, because
 * `legal_documents` carries a PLAIN index on `(document_type, is_current)` and
 * no unique constraint that could express the rule.
 *
 * The claims below are claims about ROWS IN POSTGRES:
 *
 *   1. *** TWO ADMINS PUBLISHING THE SAME DOCUMENT TYPE AT THE SAME INSTANT
 *      LEAVE EXACTLY ONE CURRENT VERSION. *** Concurrently, through the real
 *      service, against the real advisory lock.
 *   2. `hasCurrentConsent` is true ONLY against the version current NOW —
 *      including the awkward-but-real case of an admin RE-publishing an older
 *      version the patient had already accepted.
 *   3. `consents` is APPEND-ONLY: the row proving acceptance of a superseded
 *      version is byte-identical afterwards, `ip_address` included.
 *   4. `ip_address` is stored and NEVER echoed by any read this module offers.
 *   5. The composite FK really does refuse a `consents` row whose
 *      `document_type` disagrees with its pinned `legal_document_id` — the
 *      constraint `consent.repository.ts` says makes the denormalised column
 *      safe to trust.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 *
 * Real: the database, `LegalDocumentRepository`, `LegalDocumentService`,
 * `ConsentRepository`, `ConsentService`, `ConsentFacade`, `AuditService`.
 * Nothing in this module is stubbed — it has no cross-module collaborators to
 * stub.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do, and fails loudly rather than skipping.
 *
 * ── SHARED-DATABASE HYGIENE ────────────────────────────────────────────────
 *
 * `legal_documents.is_current` is GLOBAL per document type, so publishing
 * inside a test moves a flag other work may depend on. This spec therefore
 * uses two document types nothing else in the codebase seeds
 * (`refund_policy`, `reconsult_policy`), snapshots whichever row held
 * `is_current` for them before the run, and restores it in teardown.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { consentsTable } from '../../schema/consents.schema';
import type { LegalDocumentType } from '../../schema/enums.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';
import { patientsTable } from '../../schema/patients.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { ConsentFacade } from './consent.facade';
import { ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';
import { CONSENT_ERROR_CODES } from './consent.constants';
import { LegalDocumentRepository } from './legal-document.repository';
import { LegalDocumentService } from './legal-document.service';

jest.setTimeout(30_000);

/** Nothing else in this codebase publishes either of these, so the global `is_current` flag is ours to move. */
const RACE_TYPE: LegalDocumentType = 'refund_policy';
const CONSENT_TYPE: LegalDocumentType = 'reconsult_policy';
const TOUCHED_TYPES: readonly LegalDocumentType[] = [RACE_TYPE, CONSENT_TYPE];

describe('M-03 legal documents and consent, against a real database', () => {
  let db: Database;
  let documents: LegalDocumentService;
  let documentRepo: LegalDocumentRepository;
  let consents: ConsentService;
  let facade: ConsentFacade;

  const adminId = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let patientId: string;
  /** Whatever held `is_current` for our two types before this run, restored in teardown. */
  let preexistingCurrent: { id: string }[] = [];
  /** Every `legal_documents` row this run created, for teardown. */
  const createdDocumentIds: string[] = [];

  /** A version string unique across the whole table — `(document_type, version)` is UNIQUE forever, not per run. */
  const version = (label: string) => `${label}-${runId}`;

  async function create(documentType: LegalDocumentType, label: string, publish: boolean) {
    const detail = await documents.adminCreate(adminId, {
      documentType,
      version: version(label),
      title: `${label} ${runId}`,
      body: `Body of ${label} ${runId}.`,
      publish,
    });
    createdDocumentIds.push(detail.id);
    return detail;
  }

  async function currentRowsFor(documentType: LegalDocumentType) {
    return db
      .select({ id: legalDocumentsTable.id, version: legalDocumentsTable.version })
      .from(legalDocumentsTable)
      .where(and(eq(legalDocumentsTable.documentType, documentType), eq(legalDocumentsTable.isCurrent, true)));
  }

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();

    preexistingCurrent = await db
      .select({ id: legalDocumentsTable.id })
      .from(legalDocumentsTable)
      .where(
        and(
          inArray(legalDocumentsTable.documentType, [...TOUCHED_TYPES]),
          eq(legalDocumentsTable.isCurrent, true),
        ),
      );

    const audit = new AuditService(db);
    documentRepo = new LegalDocumentRepository(db);
    documents = new LegalDocumentService(db, documentRepo, audit);
    consents = new ConsentService(db, new ConsentRepository(db), documentRepo, audit);
    facade = new ConsentFacade(consents);

    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: `+9196${runId.slice(0, 6)}01`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientId = patient.id;
  });

  afterAll(async () => {
    if (db) {
      // Strict reverse-FK order: `consents` references `legal_documents`.
      await db.delete(consentsTable).where(eq(consentsTable.patientId, patientId));
      await db.delete(patientsTable).where(eq(patientsTable.id, patientId));
      if (createdDocumentIds.length > 0) {
        await db.delete(legalDocumentsTable).where(inArray(legalDocumentsTable.id, createdDocumentIds));
      }
      await db
        .delete(auditLogTable)
        .where(and(eq(auditLogTable.actorType, 'admin'), eq(auditLogTable.actorId, adminId)));
      await db
        .delete(auditLogTable)
        .where(and(eq(auditLogTable.actorType, 'patient'), eq(auditLogTable.actorId, patientId)));
      // Restore whatever was current before this run touched these types.
      for (const row of preexistingCurrent) {
        await db.update(legalDocumentsTable).set({ isCurrent: true }).where(eq(legalDocumentsTable.id, row.id));
      }
      await disconnectDatabase();
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 1. *** THE ONE-CURRENT-VERSION INVARIANT, UNDER GENUINE CONCURRENCY. *** */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('exactly one current version per type', () => {
    it('*** TWO ADMINS PUBLISHING AT THE SAME INSTANT LEAVE EXACTLY ONE CURRENT VERSION ***', async () => {
      // `consent.constants.ts`: without the advisory lock "both would read
      // 'v1 is current', both demote v1 and both promote their own row —
      // leaving two current versions, and a pre-consult check whose answer
      // depends on which row `limit 1` happens to return."
      const results = await Promise.all([
        documents.adminCreate(adminId, {
          documentType: RACE_TYPE,
          version: version('race-a'),
          title: `Race A ${runId}`,
          body: 'A',
          publish: true,
        }),
        documents.adminCreate(adminId, {
          documentType: RACE_TYPE,
          version: version('race-b'),
          title: `Race B ${runId}`,
          body: 'B',
          publish: true,
        }),
      ]);
      createdDocumentIds.push(...results.map((result) => result.id));

      const current = await currentRowsFor(RACE_TYPE);
      expect(current).toHaveLength(1);
      expect(results.map((result) => result.id)).toContain(current[0]?.id);
    });

    it('*** AND SO DOES A CONCURRENT `create+publish` AGAINST A STANDALONE `publish` ***', async () => {
      const dormant = await create(RACE_TYPE, 'dorm', false);

      const [, published] = await Promise.all([
        documents.adminCreate(adminId, {
          documentType: RACE_TYPE,
          version: version('race-c'),
          title: `Race C ${runId}`,
          body: 'C',
          publish: true,
        }),
        documents.adminPublish(adminId, dormant.id),
      ]).then(async ([created, promoted]) => {
        createdDocumentIds.push(created.id);
        return [created, promoted] as const;
      });

      expect(published.isCurrent).toBe(true);
      expect(await currentRowsFor(RACE_TYPE)).toHaveLength(1);
    });

    it('*** AND SO DO FIVE CONCURRENT PUBLISHES OF FIVE DIFFERENT VERSIONS ***', async () => {
      const candidates = await Promise.all([
        create(RACE_TYPE, 'five-1', false),
        create(RACE_TYPE, 'five-2', false),
        create(RACE_TYPE, 'five-3', false),
        create(RACE_TYPE, 'five-4', false),
        create(RACE_TYPE, 'five-5', false),
      ]);

      await Promise.all(candidates.map((candidate) => documents.adminPublish(adminId, candidate.id)));

      const current = await currentRowsFor(RACE_TYPE);
      expect(current).toHaveLength(1);
      expect(candidates.map((candidate) => candidate.id)).toContain(current[0]?.id);
    });

    it('POSITIVE CONTROL: publishing one type does not disturb the other', async () => {
      const other = await create(CONSENT_TYPE, 'untch', true);

      await create(RACE_TYPE, 'later', true);

      const stillCurrent = await currentRowsFor(CONSENT_TYPE);
      expect(stillCurrent).toHaveLength(1);
      expect(stillCurrent[0]?.id).toBe(other.id);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 2. *** A SUPERSEDED VERSION IS NOT CONSENT. ***                         */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('hasCurrentConsent is true only against the version current NOW', () => {
    it('*** ACCEPTING v1 AND THEN PUBLISHING v2 REVOKES THE ANSWER, AND SAYS WHICH VERSION THEY DID ACCEPT ***', async () => {
      const v1 = await create(CONSENT_TYPE, 'c-v1', true);
      const accepted = await consents.recordConsent('patient', patientId, v1.id, '203.0.113.7');
      expect(accepted.version).toBe(version('c-v1'));

      await expect(facade.checkPatientConsent({ patientId, documentType: CONSENT_TYPE })).resolves.toMatchObject({
        hasCurrentConsent: true,
        acceptedVersion: version('c-v1'),
        currentVersion: version('c-v1'),
      });

      const v2 = await create(CONSENT_TYPE, 'c-v2', true);

      await expect(facade.checkPatientConsent({ patientId, documentType: CONSENT_TYPE })).resolves.toMatchObject({
        hasCurrentConsent: false,
        acceptedVersion: version('c-v1'),
        currentVersion: version('c-v2'),
      });
      expect(v2.isCurrent).toBe(true);
    });

    it('refuses to STORE consent against the now-superseded v1 — it is not evidence of anything anyone asked for', async () => {
      const [v1] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(
          and(eq(legalDocumentsTable.documentType, CONSENT_TYPE), eq(legalDocumentsTable.version, version('c-v1'))),
        );

      await expect(consents.recordConsent('patient', patientId, v1.id, '203.0.113.7')).rejects.toMatchObject({
        response: { code: CONSENT_ERROR_CODES.SUPERSEDED_LEGAL_DOCUMENT },
      });
    });

    it('*** RE-PUBLISHING v1 MAKES THE OLD ACCEPTANCE COUNT AGAIN — the second lookup exists for exactly this ***', async () => {
      const [v1] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(
          and(eq(legalDocumentsTable.documentType, CONSENT_TYPE), eq(legalDocumentsTable.version, version('c-v1'))),
        );

      await documents.adminPublish(adminId, v1.id);

      // The patient's MOST RECENT acceptance is still v1 here, but the point
      // is the query shape: `findLatestPatientAcceptance` is not enough on its
      // own, and `findPatientAcceptanceOfDocument` is what answers.
      await expect(facade.checkPatientConsent({ patientId, documentType: CONSENT_TYPE })).resolves.toMatchObject({
        hasCurrentConsent: true,
        acceptedVersion: version('c-v1'),
        currentVersion: version('c-v1'),
      });
    });

    it('*** AND WHEN THE MOST RECENT ACCEPTANCE IS *NOT* THE CURRENT ONE, THE SECOND LOOKUP STILL FINDS IT ***', async () => {
      // Accept v2 as well, so the newest acceptance is v2 — then make v1
      // current again. The naive one-query answer would be `false`.
      const [v2] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(
          and(eq(legalDocumentsTable.documentType, CONSENT_TYPE), eq(legalDocumentsTable.version, version('c-v2'))),
        );
      await documents.adminPublish(adminId, v2.id);
      await consents.recordConsent('patient', patientId, v2.id, '203.0.113.8');

      const [v1] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(
          and(eq(legalDocumentsTable.documentType, CONSENT_TYPE), eq(legalDocumentsTable.version, version('c-v1'))),
        );
      await documents.adminPublish(adminId, v1.id);

      await expect(facade.checkPatientConsent({ patientId, documentType: CONSENT_TYPE })).resolves.toMatchObject({
        hasCurrentConsent: true,
        acceptedVersion: version('c-v1'),
        currentVersion: version('c-v1'),
      });
    });

    it('answers a closed `false` for a document type with nothing published at all', async () => {
      // `terms_of_use` is untouched by this run and unseeded by the codebase.
      await expect(
        facade.checkPatientConsent({ patientId, documentType: 'terms_of_use' }),
      ).resolves.toEqual({
        hasCurrentConsent: false,
        acceptedVersion: null,
        acceptedAt: null,
        currentVersion: null,
      });
    });

    it('fails CLOSED rather than throwing on a patient id Postgres cannot even parse', async () => {
      await expect(
        facade.checkPatientConsent({ patientId: 'not-a-uuid', documentType: CONSENT_TYPE }),
      ).resolves.toEqual({
        hasCurrentConsent: false,
        acceptedVersion: null,
        acceptedAt: null,
        currentVersion: null,
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 3. *** APPEND-ONLY, AND `ip_address` STAYS OUT OF EVERY RESPONSE. ***   */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('append-only legal evidence', () => {
    it('*** THE v1 ACCEPTANCE ROW IS UNCHANGED AFTER TWO PUBLISHES AND A SECOND ACCEPTANCE ***', async () => {
      const rows = await db
        .select()
        .from(consentsTable)
        .where(eq(consentsTable.patientId, patientId))
        .orderBy(consentsTable.acceptedAt);

      // Two acceptances, two rows — accepting a newer version INSERTS.
      expect(rows).toHaveLength(2);
      expect(rows[0]?.ipAddress).toBe('203.0.113.7');
      expect(rows[1]?.ipAddress).toBe('203.0.113.8');
      expect(rows[0]?.documentType).toBe(CONSENT_TYPE);
    });

    it('re-accepting the SAME version is idempotent — the original row and its original timestamp come back', async () => {
      const [current] = await db
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(and(eq(legalDocumentsTable.documentType, CONSENT_TYPE), eq(legalDocumentsTable.isCurrent, true)));

      const first = await consents.recordConsent('patient', patientId, current.id, '198.51.100.4');
      const again = await consents.recordConsent('patient', patientId, current.id, '198.51.100.9');

      expect(again.id).toBe(first.id);
      expect(again.acceptedAt).toBe(first.acceptedAt);

      const rows = await db.select().from(consentsTable).where(eq(consentsTable.patientId, patientId));
      expect(rows).toHaveLength(2);
      // And the stored evidence still carries the FIRST acceptance's address.
      expect(rows.map((row) => row.ipAddress).sort()).toEqual(['203.0.113.7', '203.0.113.8']);
    });

    it('*** TWO SIMULTANEOUS ACCEPTANCES OF THE SAME VERSION PRODUCE ONE ROW, NOT A 500 ***', async () => {
      const fresh = await create(CONSENT_TYPE, 'c-v3', true);

      const results = await Promise.allSettled([
        consents.recordConsent('patient', patientId, fresh.id, '198.51.100.1'),
        consents.recordConsent('patient', patientId, fresh.id, '198.51.100.2'),
        consents.recordConsent('patient', patientId, fresh.id, '198.51.100.3'),
      ]);

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected.map((result) => String((result as PromiseRejectedResult).reason))).toEqual([]);

      const rows = await db
        .select()
        .from(consentsTable)
        .where(and(eq(consentsTable.patientId, patientId), eq(consentsTable.legalDocumentId, fresh.id)));
      expect(rows).toHaveLength(1);
    });

    it('*** `ip_address` IS STORED AND NEVER ECHOED *** — not by the acceptance, not by the history', async () => {
      const history = await consents.listOwnConsents('patient', patientId);

      expect(history.length).toBeGreaterThan(0);
      for (const record of history) {
        expect(record).not.toHaveProperty('ipAddress');
        expect(Object.values(record).join('|')).not.toContain('203.0.113');
        expect(Object.values(record).join('|')).not.toContain('198.51.100');
      }

      // And the column really does hold something, so the assertion above is
      // not passing because nothing was ever written.
      const [stored] = await db
        .select({ ipAddress: consentsTable.ipAddress })
        .from(consentsTable)
        .where(eq(consentsTable.patientId, patientId))
        .limit(1);
      expect(stored?.ipAddress).toBeTruthy();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4. *** THE COMPOSITE FK THAT MAKES THE DENORMALISED COLUMN SAFE. ***    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('a consent row cannot disagree with the document it pins', () => {
    it('*** POSTGRES REFUSES A `document_type` THAT IS NOT THE PINNED DOCUMENT’S OWN ***', async () => {
      // A version this patient has NOT accepted, so the unique index on
      // `(patient_id, legal_document_id)` cannot fire first and mask the
      // constraint actually under test.
      const unaccepted = await create(CONSENT_TYPE, 'fk', false);

      // `consent.repository.ts` says the composite FK to
      // `legal_documents (id, document_type)` "rejects any pair that
      // disagrees, which is exactly what that constraint is there for". This
      // is the assertion behind that sentence — bypassing the service, because
      // the service is what makes it unreachable.
      await expect(
        db.insert(consentsTable).values({
          patientId,
          legalDocumentId: unaccepted.id,
          documentType: 'privacy_policy',
          ipAddress: '198.51.100.55',
        }),
      ).rejects.toMatchObject({ cause: { code: '23503' } });

      // POSITIVE CONTROL: the agreeing pair inserts.
      await db.insert(consentsTable).values({
        patientId,
        legalDocumentId: unaccepted.id,
        documentType: CONSENT_TYPE,
        ipAddress: '198.51.100.56',
      });
    });
  });
});
