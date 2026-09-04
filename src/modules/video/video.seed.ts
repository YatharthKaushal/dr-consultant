/**
 * Standalone seed script — no Nest DI, no decorators. Same shape as
 * `identity.seed.ts`, `catalogue.seed.ts`, `payment.seed.ts` and
 * `instant.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * *** THERE IS NO `db:seed:video` NPM SCRIPT YET, AND THIS TRACK DID NOT ADD
 * ONE. *** `package.json` is one of the highest-conflict files in the
 * repository and three worktrees were in flight, so the one-line addition —
 * `"db:seed:video": "ts-node -r tsconfig-paths/register
 * src/modules/video/video.seed.ts"`, beside the eight that are already there —
 * is left to the COORDINATOR. Until then it runs with exactly that command.
 *
 * Nothing depends on the seed having run: every read falls back to the
 * compiled-in default in `video.constants.ts#VIDEO_CONFIG_FALLBACKS`, which is
 * the same value this script inserts.
 *
 * Writes the two `video.*` `app_config` rows M-14 owns:
 *
 *   video.join_token_ttl_seconds = 300
 *   video.join_window_minutes    = 15
 *
 * `ON CONFLICT DO NOTHING`, so a re-run never overwrites a value an operator
 * has since tuned — the same discipline `payment.seed.ts` applies to the GST
 * rate and `instant.seed.ts` to its two windows.
 *
 * Nothing else is seeded. `consultation_participants` is a transactional table
 * with no reference data, there is no rooms table and no tokens table
 * (`docs/erd.sql` gives M-14 exactly one table, and the room is a function of
 * the consultation id), and the LiveKit URL, key and secret are environment
 * variables rather than config rows — `docs/erd.sql` says so on `app_config`
 * itself: "The LiveKit server URL is NOT here ... and the API key and secret
 * are environment secrets. Secrets are NEVER stored here."
 *
 * ===========================================================================
 * *** BOTH KEYS ARE RESERVED BY THE ERD AND NEITHER HAD A STATED DEFAULT. ***
 *
 * `app_config`'s own table comment lists both under "everything the admin can
 * change without a release" and defines them: "`video.join_window_minutes` is
 * how early before scheduled_start_at the backend will mint a join token, and
 * `video.join_token_ttl_seconds` is how long that token stays good."
 *
 * No value is stated for either, anywhere — the same situation
 * `instant.seed.ts` documents for `instant.acceptance_window_seconds`. Five
 * minutes and fifteen minutes are this module's choice, argued in
 * `video.constants.ts#VIDEO_CONFIG_FALLBACKS`. The short version: the TTL bounds
 * how long a LEAKED token is worth anything and NOT how long the call may run
 * (LiveKit checks the token at connect, and the session then lives on its own),
 * so it is set long enough to survive FR-8.2's device-permission prompts and no
 * longer; and the window is the ordinary "the waiting room is open" figure.
 *
 * Both are editable from the admin panel with no release
 * (`PUT /api/admin/video/config`), which is the whole reason they live in
 * `app_config` rather than in code (SRS 6.6).
 * ===========================================================================
 */
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { VIDEO_APP_CONFIG_DEFAULTS, VIDEO_AUDIT_ENTITY_TYPES } from './video.constants';

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
    for (const [key, value] of Object.entries(VIDEO_APP_CONFIG_DEFAULTS)) {
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
      // exactly as an admin later changing it is. `docs/erd.sql` on
      // `app_config`: "Every change is an audit_log row carrying the actor and
      // the before/after value." The token TTL is an access-control parameter,
      // so it qualifies twice over.
      await tx.insert(auditLogTable).values({
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: VIDEO_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: { before: null, after: value, source: 'video.seed' },
      });
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`video.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      'video.seed: NOTE — video.join_token_ttl_seconds bounds how long a LEAKED token is usable, not how long a call may run. Read video.constants.ts before lengthening it.\n',
    );
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`video.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
