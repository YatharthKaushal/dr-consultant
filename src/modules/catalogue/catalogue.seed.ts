/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:catalogue` (see package.json). Same shape as
 * `identity.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * Writes the 5 launch specialties named in `docs/SRS.md`/`docs/erd.sql`'s
 * comments — minimal viable rows (code, name, canPrescribe). Forms/
 * templates/requiredDocuments are left at their column defaults: that's real
 * clinical content the client authors later through the admin panel, not
 * something to invent here.
 *
 * `ON CONFLICT (code) DO NOTHING` — never overwrites a specialty an admin
 * has since edited (renamed, deactivated, given a template, etc.). Run it
 * once after the first `db:migrate`; running it again is always a no-op.
 */
import { eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { specialtiesTable } from '../../schema/specialties.schema';

interface LaunchSpecialty {
  code: string;
  name: string;
  canPrescribe: boolean;
}

const LAUNCH_SPECIALTIES: readonly LaunchSpecialty[] = [
  { code: 'psychiatry', name: 'Psychiatry', canPrescribe: true },
  { code: 'psychology', name: 'Psychology', canPrescribe: false },
  { code: 'therapy', name: 'Therapy', canPrescribe: false },
  { code: 'counselling', name: 'Counselling', canPrescribe: false },
  { code: 'de_addiction', name: 'De-addiction', canPrescribe: false },
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
    for (const specialty of LAUNCH_SPECIALTIES) {
      const [existing] = await tx.select({ id: specialtiesTable.id }).from(specialtiesTable).where(eq(specialtiesTable.code, specialty.code)).limit(1);

      if (existing) {
        summary.alreadyPresent.push(specialty.code);
        continue;
      }

      const [row] = await tx
        .insert(specialtiesTable)
        .values(specialty)
        .onConflictDoNothing({ target: specialtiesTable.code })
        .returning({ id: specialtiesTable.id });

      if (row) {
        summary.inserted.push(specialty.code);
        await tx.insert(auditLogTable).values({
          actorType: 'system',
          actorId: null,
          action: 'create',
          entityType: 'specialty',
          entityId: row.id,
          metadata: { after: specialty, source: 'catalogue.seed' },
        });
      } else {
        // Lost a race with a concurrent seed run — treat as already present.
        summary.alreadyPresent.push(specialty.code);
      }
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`catalogue.seed: done — ${JSON.stringify(summary)}\n`);
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`catalogue.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
