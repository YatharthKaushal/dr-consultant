/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:storage` (see package.json). Same shape as
 * `catalogue.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * Writes exactly the two rows this module will ever have: `s3` (priority 10,
 * tried first) and `cloudinary` (priority 20, automatic secondary). `config`
 * is seeded empty — bucket/region/endpoint/cloudName are real deployment
 * values an admin fills in via `PATCH /admin/storage/providers/:id` once the
 * infrastructure exists, not something to invent here (same reasoning
 * `catalogue.seed.ts` gives for leaving specialty templates at their column
 * defaults). Never invent real-looking placeholder credentials — there are
 * none to invent, since this table holds no secrets at all; see
 * `storage-providers.schema.ts`.
 *
 * `ON CONFLICT (provider) DO NOTHING` — never overwrites an admin's edits to
 * an existing row (config, isActive, priority). Run it once after the first
 * `db:migrate`; running it again is always a no-op.
 */
import { eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { storageProvidersTable } from '../../schema/storage-providers.schema';
import { STORAGE_AUDIT_ENTITY_TYPES } from './storage.constants';

interface SeedProvider {
  provider: string;
  priority: number;
  isActive: boolean;
  config: Record<string, unknown>;
}

const SEED_PROVIDERS: readonly SeedProvider[] = [
  { provider: 's3', priority: 10, isActive: true, config: {} },
  { provider: 'cloudinary', priority: 20, isActive: true, config: {} },
];

interface SeedSummary {
  inserted: string[];
  alreadyPresent: string[];
}

async function seed(): Promise<SeedSummary> {
  loadEnvFiles();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = { inserted: [], alreadyPresent: [] };

  await db.transaction(async (tx) => {
    for (const provider of SEED_PROVIDERS) {
      const [existing] = await tx
        .select({ id: storageProvidersTable.id })
        .from(storageProvidersTable)
        .where(eq(storageProvidersTable.provider, provider.provider))
        .limit(1);

      if (existing) {
        summary.alreadyPresent.push(provider.provider);
        continue;
      }

      const [row] = await tx
        .insert(storageProvidersTable)
        .values(provider)
        .onConflictDoNothing({ target: storageProvidersTable.provider })
        .returning({ id: storageProvidersTable.id });

      if (row) {
        summary.inserted.push(provider.provider);
        await tx.insert(auditLogTable).values({
          actorType: 'system',
          actorId: null,
          action: 'create',
          entityType: STORAGE_AUDIT_ENTITY_TYPES.STORAGE_PROVIDER,
          entityId: row.id,
          metadata: { after: provider, source: 'storage.seed' },
        });
      } else {
        // Lost a race with a concurrent seed run — treat as already present.
        summary.alreadyPresent.push(provider.provider);
      }
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`storage.seed: done — ${JSON.stringify(summary)}\n`);
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`storage.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
