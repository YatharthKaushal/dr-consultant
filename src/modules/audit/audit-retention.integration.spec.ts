/**
 * *** A REAL-DATABASE TEST FOR `AuditRepository.deleteEligibleBatch`. READ
 * `patient-file.transaction.integration.spec.ts`'S OWN HEADER FIRST. ***
 *
 * `audit-retention-sweep.service.spec.ts` mocks `AuditRepository` entirely,
 * so it proves the SWEEP's own batching/scheduling/audit-of-its-own-
 * deletion logic, but it cannot prove the one claim that actually matters
 * for a method whose whole job is "never delete the wrong row": that the
 * `DELETE ... WHERE id IN (SELECT ...)` this repository issues really does
 * restrict itself, against a REAL Postgres, to
 *   (a) only the `action`s passed in,
 *   (b) only rows at or before the cutoff,
 *   (c) at most `batchSize` rows, oldest first,
 * and leaves every other row — in particular every `create`/`update`/
 * `read`/`export`/`webhook` row, however old — completely untouched. A
 * mocked test cannot make that claim; only a real DELETE against a real
 * table can.
 *
 * `audit_log.entity_id`/`consultation_id` are deliberately unconstrained (no
 * FK — `audit-log.schema.ts`'s own doc comment), so this fixture needs no
 * row graph at all: every row below is a self-contained insert. Rows are
 * namespaced by a per-run `entity_id` prefix and deleted in `afterAll` by
 * that prefix, so a crashed run never collides with the next one and never
 * touches real data.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env`/
 * `.env.local` exactly as the seed scripts do, and fails loudly rather than
 * skipping if the database is unreachable.
 */
import { randomUUID } from 'node:crypto';
import { like } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import type { AuditAction } from '../../schema/enums.schema';
import { AuditRepository } from './audit.repository';

jest.setTimeout(30_000);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('AuditRepository.deleteEligibleBatch (real database)', () => {
  let db: Database;
  let repo: AuditRepository;
  let runId: string;
  let entityPrefix: string;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    repo = new AuditRepository(db);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(() => {
    runId = randomUUID().slice(0, 8);
    entityPrefix = `itest-retention-${runId}`;
  });

  afterEach(async () => {
    await db.delete(auditLogTable).where(like(auditLogTable.entityId, `${entityPrefix}%`));
  });

  async function insertRow(action: AuditAction, daysOld: number, suffix: string): Promise<void> {
    await db.insert(auditLogTable).values({
      actorType: 'patient',
      actorId: null,
      action,
      entityType: 'itest',
      entityId: `${entityPrefix}-${suffix}`,
      createdAt: new Date(Date.now() - daysOld * ONE_DAY_MS),
    });
  }

  async function countRemaining(): Promise<number> {
    const rows = await db
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(like(auditLogTable.entityId, `${entityPrefix}%`));
    return rows.length;
  }

  it('deletes only eligible-action rows at or before the cutoff, and leaves everything else', async () => {
    const cutoff = new Date(Date.now() - 30 * ONE_DAY_MS);

    await insertRow('login', 90, 'old-login'); // eligible: old + eligible action -> DELETED
    await insertRow('verify', 60, 'old-verify'); // eligible: old + eligible action -> DELETED
    await insertRow('login', 1, 'new-login'); // NOT deleted: newer than cutoff
    // *** THE CLAIM THIS WHOLE MODULE EXISTS TO PROVE. ***
    // Old, but NOT a purge-eligible action — must survive regardless of age.
    await insertRow('create', 400, 'old-create');
    await insertRow('update', 400, 'old-update');
    await insertRow('delete', 400, 'old-delete');
    await insertRow('read', 400, 'old-read');
    await insertRow('export', 400, 'old-export');
    await insertRow('webhook', 400, 'old-webhook');

    const deletedIds = await repo.deleteEligibleBatch(cutoff, ['login', 'verify'], 1_000);

    expect(deletedIds).toHaveLength(2);
    expect(await countRemaining()).toBe(7); // 9 inserted - 2 deleted
  });

  it('respects batchSize and takes the OLDEST rows first', async () => {
    const cutoff = new Date(Date.now() - 1 * ONE_DAY_MS);
    await insertRow('login', 10, 'oldest');
    await insertRow('login', 5, 'middle');
    await insertRow('login', 3, 'newest-eligible');

    const deletedIds = await repo.deleteEligibleBatch(cutoff, ['login', 'verify'], 2);

    expect(deletedIds).toHaveLength(2);
    // The one row left behind must be the NEWEST of the three (i.e. the two
    // oldest were the ones taken) — confirmed by one row still remaining.
    expect(await countRemaining()).toBe(1);
  });

  it('returns an empty array, and deletes nothing, when eligibleActions is empty', async () => {
    await insertRow('login', 90, 'untouchable');
    const cutoff = new Date();

    const deletedIds = await repo.deleteEligibleBatch(cutoff, [], 1_000);

    expect(deletedIds).toEqual([]);
    expect(await countRemaining()).toBe(1);
  });

  it('leaves a row newer than the cutoff alone even when its action is eligible', async () => {
    const cutoff = new Date(Date.now() - 30 * ONE_DAY_MS);
    await insertRow('login', 1, 'too-new');

    const deletedIds = await repo.deleteEligibleBatch(cutoff, ['login', 'verify'], 1_000);

    expect(deletedIds).toEqual([]);
    expect(await countRemaining()).toBe(1);
  });
});
