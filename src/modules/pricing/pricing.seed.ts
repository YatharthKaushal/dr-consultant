/**
 * Standalone seed script — no Nest DI, no decorators. Same shape as
 * `payment.seed.ts`, `identity.seed.ts` and `catalogue.seed.ts`: idempotent,
 * re-runnable, insert-only.
 *
 * Writes the three `pricing.*` `app_config` rows:
 *
 *   pricing.components          the ordered catalogue — doctor fee EXEMPT,
 *                               convenience fee TAXABLE at 18%
 *   pricing.tax_profile         the org's registered state, GSTIN and legal name
 *   pricing.quote_ttl_minutes   15
 *
 * `ON CONFLICT DO NOTHING`, so a re-run never overwrites a catalogue an admin
 * has since tuned — the same discipline `payment.seed.ts` applies to its rates.
 *
 * ===========================================================================
 * *** THE CLIENT'S CA OWNS THE GST TREATMENT. ***
 *
 * SRS §8: "GST wording, tax treatment and invoice structure must be confirmed
 * with the client's CA or legal advisor before launch. The developer builds the
 * billing display and configuration to the confirmed structure." SRS §2.5 says
 * the same.
 *
 * The seeded catalogue takes the ORTHODOX reading of Notification 12/2017 entry
 * 74 — a doctor's consultation fee is GST-exempt, the platform's convenience fee
 * is not — which prices a 500 fee at 500 + 100 + 18 = 618.
 *
 * *** THAT IS NOT WHAT FR-7.3 SAYS. *** FR-7.3's worked example taxes BOTH
 * components and totals 708. Both readings are one configuration change apart,
 * which is the entire reason tax treatment is per-component and stored rather
 * than a migration. Neither figure is tax advice.
 *
 * *** THE TAX PROFILE BELOW IS A PLACEHOLDER. *** A null GSTIN and a stand-in
 * legal name do not make a valid tax invoice. The client must set them before
 * issuing one, and the GST state-code table in `pricing-gst.constants.ts`
 * likewise needs CA confirmation — public sources disagree on several codes.
 * ===========================================================================
 */
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { PRICING_APP_CONFIG_DEFAULTS, PRICING_AUDIT_ENTITY_TYPES } from './pricing.constants';

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
    for (const [key, value] of Object.entries(PRICING_APP_CONFIG_DEFAULTS)) {
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
        entityType: PRICING_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: { before: null, after: value, source: 'pricing.seed', caSignOffRequired: true },
      });
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`pricing.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      "pricing.seed: NOTE — the seeded catalogue treats the doctor's fee as GST-EXEMPT and the convenience fee as taxable at 18% (500 -> 618), which is the orthodox reading of Notification 12/2017 entry 74. FR-7.3's worked example instead taxes BOTH components (500 -> 708). Which is correct is a question for the client's CA (SRS section 8), and switching between them is a configuration change, not a release. The tax profile is a PLACEHOLDER: the GSTIN is null and the legal name is a stand-in, and neither makes a valid tax invoice.\n",
    );
    process.stdout.write(
      'pricing.seed: NOTE — once these rows exist, PUT /api/admin/payments/config REFUSES with PAYMENT_CONFIG_SUPERSEDED. The convenience fee and GST rate are now set per component at PUT /api/admin/pricing/config.\n',
    );
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pricing.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
