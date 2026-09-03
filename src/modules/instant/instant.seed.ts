/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:instant`. Same shape as `identity.seed.ts`,
 * `catalogue.seed.ts`, `search.seed.ts`, `storage.seed.ts` and
 * `payment.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * Writes the two `instant.*` `app_config` rows M-13 owns:
 *
 *   instant.acceptance_window_seconds = 60
 *   instant.payment_window_seconds    = 300
 *
 * `ON CONFLICT DO NOTHING`, so a re-run never overwrites a window an operator
 * has since tuned — the same discipline `payment.seed.ts` applies to the GST
 * rate and `search.seed.ts` to the crisis keywords.
 *
 * Nothing else is seeded: `instant_consultancy` is a transactional table with
 * no reference data, and `doctors.presence` is realtime state that the boot
 * sweep resets rather than a value anyone seeds.
 *
 * ===========================================================================
 * *** ONE OF THESE KEYS IS RESERVED BY THE ERD; THE OTHER IS NEW. ***
 *
 * `instant.acceptance_window_seconds` appears in `docs/erd.sql` twice — in
 * `app_config`'s own comment listing "everything the admin can change without
 * a release", and on `instant_consultancy.expires_at` ("acceptance window,
 * configured in app_config") — but no default is stated anywhere and nothing
 * had ever declared it. Sixty seconds is this module's choice, argued in
 * `instant.constants.ts#INSTANT_CONFIG_FALLBACKS`.
 *
 * `instant.payment_window_seconds` is GENUINELY NEW: not in the ERD's key
 * list, not in any SRS section. It exists because FR-10.2 orders the instant
 * flow request -> accept -> PAY, which creates a second window with no
 * counterpart in the scheduled flow — a doctor who has accepted and a patient
 * who has not paid. *** IT IS NOT THE SAME TRADE AS `booking.slot_hold_
 * minutes` AND MUST NOT BE SET LIKE IT: *** that one is deliberately LONGER
 * than the gateway's checkout window so a slot is never lost, and doing that
 * here would hold a live doctor idle for twenty minutes. See
 * `instant-expiry.service.ts`'s header for the full argument and for the
 * mechanism that catches a payment landing after the release.
 *
 * Both are editable from the admin panel with no release
 * (`PUT /api/admin/instant-consults/config`), which is the whole reason they
 * live in `app_config` rather than in code (SRS 6.6).
 * ===========================================================================
 */
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { INSTANT_APP_CONFIG_DEFAULTS, INSTANT_AUDIT_ENTITY_TYPES } from './instant.constants';

interface SeedSummary {
  configKeysInserted: string[];
  configKeysAlreadyPresent: string[];
}

async function seed(): Promise<SeedSummary> {
  loadEnvFiles();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = { configKeysInserted: [], configKeysAlreadyPresent: [] };

  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(INSTANT_APP_CONFIG_DEFAULTS)) {
      const inserted = await tx
        .insert(appConfigTable)
        .values({ key, value })
        .onConflictDoNothing({ target: appConfigTable.key })
        .returning({ id: appConfigTable.id });

      if (inserted.length === 0) {
        summary.configKeysAlreadyPresent.push(key);
        continue;
      }

      summary.configKeysInserted.push(key);

      // A configuration value coming into existence is an audited event,
      // exactly as an admin later changing it is. `docs/MODULES.md` §7: "Every
      // module touching clinical or financial data writes audit entries from
      // its first release, not later." These two windows decide how long a
      // patient waits and how long a doctor is held, so they qualify.
      await tx.insert(auditLogTable).values({
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: INSTANT_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: { before: null, after: value, source: 'instant.seed' },
      });
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`instant.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      'instant.seed: NOTE — instant.payment_window_seconds is deliberately SHORTER than booking.slot_hold_minutes. It holds a live doctor, not a slot; see instant-expiry.service.ts before changing it.\n',
    );
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`instant.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
