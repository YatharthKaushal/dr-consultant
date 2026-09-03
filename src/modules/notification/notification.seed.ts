/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:notifications` (see package.json). Same shape as
 * `identity.seed.ts`, `catalogue.seed.ts`, `search.seed.ts` and
 * `payment.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * Writes the one `app_config` row M-08 owns:
 *
 *   notifications.templates = { <code>: { title, body }, ... }
 *
 * with default copy for the nine template codes `notifications.template_code`'s
 * own schema comment names. `docs/erd.sql`'s `app_config` comment lists
 * `notifications.templates` by name, which is why there is no templates TABLE
 * and no migration here: copy is configuration, not an entity.
 *
 * `ON CONFLICT DO NOTHING`, so a re-run never overwrites copy an admin has
 * since edited — the same discipline `search.seed.ts` applies to crisis
 * keywords and `payment.seed.ts` to the GST rate. Nothing else is seeded:
 * `notifications` is a transactional table with no reference data, and device
 * tokens are registered by the apps themselves.
 *
 * *** THE SEED IS NOT REQUIRED FOR CORRECTNESS. *** Every read of
 * `notifications.templates` falls back per code to
 * `NOTIFICATION_TEMPLATE_DEFAULTS`, so a deployment that never runs this
 * still sends the right copy. The row exists so the copy is VISIBLE and
 * EDITABLE in the admin panel from day one (FR-16.3), not so that sending
 * works.
 *
 * ===========================================================================
 * *** CLIENT AND CLINICIAN SIGN-OFF REQUIRED BEFORE LAUNCH. ***
 *
 * SRS §8: "All clinical content ... must be reviewed and approved by a
 * qualified clinician before launch." `docs/MODULES.md` §7: "All clinical
 * content and clinical rules are authored and approved by the client before
 * launch; modules provide the tools, not the wording."
 *
 * Every string this script writes is a DEVELOPER STARTER SET, written so the
 * mechanism is demonstrable end to end on day one. It is not the client's
 * voice and it is not clinically reviewed. All of it is editable from the
 * admin panel with no app release (FR-16.3, via
 * `PUT /api/admin/notifications/templates/:code`), which is the whole reason
 * it lives in `app_config`.
 *
 * The copy is deliberately EVENT-SHAPED, never clinical — FR-16.2, "no
 * notification names a diagnosis". This script re-checks every default
 * against that rule before writing it, and refuses to write at all if one
 * fails, so a bad edit to the defaults cannot reach a database even by
 * accident.
 * ===========================================================================
 */
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { screenForDiagnosis } from './notification-diagnosis.util';
import {
  NOTIFICATION_APP_CONFIG_DEFAULTS,
  NOTIFICATION_AUDIT_ENTITY_TYPES,
  NOTIFICATION_TEMPLATE_DEFAULTS,
} from './notification.constants';

interface SeedSummary {
  configKeysInserted: string[];
  configKeysAlreadyPresent: string[];
  templatesSeeded: number;
}

/** FR-16.2, before anything reaches the database. A failure here is a bug in the defaults, not a bad environment. */
function assertDefaultsNameNoDiagnosis(): void {
  for (const [code, template] of Object.entries(NOTIFICATION_TEMPLATE_DEFAULTS)) {
    for (const [field, text] of [
      ['title', template.title],
      ['body', template.body],
    ] as const) {
      const screening = screenForDiagnosis(text);
      if (!screening.clean) {
        throw new Error(
          `FR-16.2: default template "${code}" ${field} names a diagnosis ("${screening.construction ?? ''}"). Refusing to seed.`,
        );
      }
    }
  }
}

async function seed(): Promise<SeedSummary> {
  assertDefaultsNameNoDiagnosis();

  loadEnvFiles();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = {
    configKeysInserted: [],
    configKeysAlreadyPresent: [],
    templatesSeeded: Object.keys(NOTIFICATION_TEMPLATE_DEFAULTS).length,
  };

  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(NOTIFICATION_APP_CONFIG_DEFAULTS)) {
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

      // Copy coming into existence is an audited event, exactly as an admin
      // later editing it is — and the before/after here is what makes the
      // first edit's `before` meaningful. Same discipline as
      // `payment.seed.ts`.
      await tx.insert(auditLogTable).values({
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: NOTIFICATION_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: { before: null, after: value, source: 'notification.seed', clinicianSignOffRequired: true },
      });
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`notification.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      'notification.seed: NOTE — the template copy is a DEVELOPER STARTER SET, not the client\'s voice and not clinically reviewed. SRS section 8 requires clinician/client sign-off before launch. Every string is editable from the admin panel with no app release (FR-16.3).\n',
    );
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`notification.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
