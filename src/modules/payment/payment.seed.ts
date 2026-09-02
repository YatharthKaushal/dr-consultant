/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:payments` (see package.json). Same shape as
 * `identity.seed.ts`, `catalogue.seed.ts` and `search.seed.ts`: idempotent,
 * re-runnable, insert-only.
 *
 * Writes the two `payments.*` `app_config` rows FR-7.5 requires to be
 * admin-editable, at the defaults `docs/SRS.md` FR-7.3's worked example uses:
 *
 *   payments.convenience_fee_pct = 20
 *   payments.gst_rate            = 18
 *
 * `ON CONFLICT DO NOTHING`, so a re-run never overwrites a rate an admin has
 * since tuned — the same discipline `search.seed.ts` applies to crisis
 * keywords. Nothing else is seeded: `payments`, `refunds` and `payment_events`
 * are all transactional tables with no reference data.
 *
 * ===========================================================================
 * *** THE CLIENT'S CA OWNS THE GST TREATMENT. ***
 *
 * SRS §8: "GST wording, tax treatment and invoice structure must be confirmed
 * with the client's CA or legal advisor before launch. The developer builds
 * the billing display and configuration to the confirmed structure." SRS §2.5
 * says the same: "the client confirms GST and invoice structure with its CA or
 * legal advisor."
 *
 * 18 is the rate the SRS's own worked example uses, and 20 the convenience fee
 * it names. Both are DEFAULTS so the mechanism is demonstrable end to end on
 * day one — neither is tax advice, and both are editable from the admin panel
 * with no release (FR-7.5, via `PUT /api/admin/payments/config`), which is the
 * whole reason they live in `app_config` rather than in code.
 * ===========================================================================
 */
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { PAYMENT_APP_CONFIG_DEFAULTS, PAYMENT_AUDIT_ENTITY_TYPES } from './payment.constants';

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
    for (const [key, value] of Object.entries(PAYMENT_APP_CONFIG_DEFAULTS)) {
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

      // A financial configuration value coming into existence is an audited
      // event, exactly as an admin later changing it is. `docs/MODULES.md` §7:
      // "Every module touching clinical or financial data writes audit entries
      // from its first release, not later."
      await tx.insert(auditLogTable).values({
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: PAYMENT_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: { before: null, after: value, source: 'payment.seed', caSignOffRequired: true },
      });
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`payment.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      'payment.seed: NOTE — the GST rate and convenience fee are DEFAULTS from the SRS worked example, not tax advice. GST treatment and invoice structure must be confirmed with the client\'s CA before launch (SRS section 8). Both are editable from the admin panel with no release.\n',
    );
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`payment.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
