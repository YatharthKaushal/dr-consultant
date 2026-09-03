/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:promotions`. Same shape as `identity.seed.ts`,
 * `catalogue.seed.ts`, `search.seed.ts` and `payment.seed.ts`: idempotent,
 * re-runnable, insert-only.
 *
 * *** THE `package.json` SCRIPT LINE IS NOT ADDED BY THIS BRANCH. *** Four
 * worktrees are in flight and `package.json` is one of the highest-conflict
 * files in the repository. The line for the coordinator to add is:
 *
 *     "db:seed:promotions": "ts-node -r tsconfig-paths/register src/modules/promotion/promotion.seed.ts"
 *
 * Writes the seven `promotion.*` `app_config` rows this module owns, at the
 * compiled-in defaults in `promotion.constants.ts`. `ON CONFLICT DO NOTHING`,
 * so a re-run never overwrites a value an admin has since tuned — the same
 * discipline `search.seed.ts` applies to crisis keywords. Nothing else is
 * seeded: every other table this module owns is transactional, with no
 * reference data. In particular NO `affiliate_partners` ROW IS CREATED, and
 * that is deliberate — see below.
 *
 * ===========================================================================
 * *** THE CLIENT'S LEGAL ADVISOR OWNS THE AFFILIATE DECISION. ***
 *
 * `promotion.affiliate_enabled` is seeded `false`, and it must stay `false`
 * until the client's LEGAL ADVISOR has signed off in writing.
 *
 * India's NMC Registered Medical Practitioner (Professional Conduct)
 * Regulations, 2023 prohibit a registered practitioner from giving, soliciting
 * or receiving any gift, gratuity, COMMISSION or bonus in consideration of, or
 * return for, referring, recommending or procuring a patient. The NMC issued a
 * specific crackdown on referral commissions; the stated penalty is suspension,
 * up to removal from the register.
 *
 * Paying a doctor a commission when a patient they referred books a consult is,
 * on its face, the arrangement that regulation names — AND THE EXPOSURE LANDS
 * ON THE DOCTOR, not only on the platform.
 *
 * The product owner has confirmed the decision: BUILD IT, SHIP IT DISABLED. The
 * mechanism is complete and tested; enabling it is a business and legal call,
 * recorded in writing, in exactly the way `docs/SRS.md` §8 assigns the GST
 * treatment to the client's CA. IT IS NOT A DEVELOPER'S CALL, AND IT MUST NOT
 * BECOME ONE BY DEFAULT.
 *
 * Every row this script writes for that key carries
 * `legalSignOffRequired: true` in its `audit_log` metadata — the direct
 * counterpart of `payment.seed.ts`'s `caSignOffRequired`, so the two most
 * consequential unreviewed defaults in the system are findable by the same
 * shape of query.
 * ===========================================================================
 *
 * ── AND READ THIS ONE TOO, BECAUSE IT IS SILENT RATHER THAN LOUD ──────────
 *
 * `promotion.referral_qualifying_statuses` is seeded
 * `["awaiting_documentation","completed"]`. BOTH ARE SET BY M-15 (clinical
 * records), WHICH DOES NOT EXIST YET. Until it does, nothing in this codebase
 * moves a consultation into either status, so NO REFERRAL REWARD AND NO
 * AFFILIATE COMMISSION WILL EVER ACCRUE.
 *
 * That is the safe direction, not an oversight: the alternative default
 * (`scheduled`, which M-11/M-12 do set today) re-opens the farming hole the
 * two-state referral design exists to close — refer a burner account, book,
 * pay, take the discount, cancel inside the free-cancellation window that
 * `booking-policy.engine.ts` already auto-refunds, and the referrer keeps a
 * reward the platform funded out of nothing.
 *
 * It is one `app_config` edit away from changing, from the admin panel, with no
 * release. If the client wants rewards live before M-15, that trade is the one
 * to put in front of them.
 */
import { eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import {
  PROMOTION_APP_CONFIG_DEFAULTS,
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_CONFIG_KEYS,
} from './promotion.constants';

interface SeedSummary {
  configKeysInserted: string[];
  configKeysAlreadyPresent: string[];
  /** Read back from the database AFTER the writes, so the banner reports what is actually in force rather than what this script intended. */
  affiliateEnabled: unknown;
}

async function seed(): Promise<SeedSummary> {
  loadEnvFiles();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = { configKeysInserted: [], configKeysAlreadyPresent: [], affiliateEnabled: null };

  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(PROMOTION_APP_CONFIG_DEFAULTS)) {
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
        entityType: PROMOTION_AUDIT_ENTITY_TYPES.CONFIG,
        entityId: key,
        metadata: {
          before: null,
          after: value,
          source: 'promotion.seed',
          // *** THE FLAG THAT MAKES THE ONE DANGEROUS DEFAULT FINDABLE. ***
          // The direct counterpart of `payment.seed.ts`'s `caSignOffRequired`.
          ...(key === PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED
            ? {
                legalSignOffRequired: true,
                signOffOwner: "the client's legal advisor",
                regulation: 'NMC Registered Medical Practitioner (Professional Conduct) Regulations, 2023',
              }
            : {}),
          ...(key === PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES
            ? { blockedOnModule: 'M-15 (clinical records)', rewardsInertUntilThen: true }
            : {}),
        },
      });
    }
  });

  // Read the LIVE value back rather than reporting the intended one: on a
  // re-run the row may already exist with a value somebody changed, and a
  // banner that says "disabled" when it is enabled is worse than no banner.
  const [row] = await db
    .select({ value: appConfigTable.value })
    .from(appConfigTable)
    .where(eq(appConfigTable.key, PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED));
  summary.affiliateEnabled = row?.value ?? null;

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(
      `promotion.seed: done — ${JSON.stringify({
        configKeysInserted: summary.configKeysInserted,
        configKeysAlreadyPresent: summary.configKeysAlreadyPresent,
      })}\n`,
    );

    process.stdout.write(
      '\n' +
        '===========================================================================\n' +
        '*** AFFILIATE COMMISSIONS ARE SWITCHED OFF, AND THIS REQUIRES LEGAL SIGN-OFF. ***\n' +
        '\n' +
        `  promotion.affiliate_enabled = ${JSON.stringify(summary.affiliateEnabled)}\n` +
        '\n' +
        "  India's NMC Registered Medical Practitioner (Professional Conduct)\n" +
        '  Regulations, 2023 prohibit a registered practitioner from receiving any\n' +
        '  gift, gratuity, COMMISSION or bonus in return for referring, recommending\n' +
        '  or procuring a patient. The stated penalty is suspension, up to removal\n' +
        '  from the register, and THE EXPOSURE LANDS ON THE DOCTOR.\n' +
        '\n' +
        '  The mechanism is built and tested. Turning it on is a decision for THE\n' +
        "  CLIENT'S LEGAL ADVISOR, recorded in writing — the same way SRS section 8\n" +
        "  assigns the GST treatment to the client's CA. It is not a developer's\n" +
        '  call. Every affiliate partner also ships `paused` independently, so\n' +
        '  enabling the switch alone still pays nobody.\n' +
        '===========================================================================\n' +
        '\n' +
        '*** REFERRAL REWARDS ARE INERT UNTIL M-15 OR A CONFIG EDIT. ***\n' +
        '\n' +
        '  promotion.referral_qualifying_statuses = ["awaiting_documentation","completed"]\n' +
        '\n' +
        '  Both statuses are set by M-15 (clinical records), which does not exist\n' +
        '  yet — so no referral reward and no affiliate commission will accrue until\n' +
        '  it does. That is deliberate: qualifying at `scheduled` instead would let\n' +
        '  somebody refer a burner account, book, pay, take the discount and cancel\n' +
        '  inside the free-cancellation window that already auto-refunds.\n' +
        '\n' +
        '  Widenable from the admin panel with no release, if the client accepts\n' +
        '  that trade.\n' +
        '\n',
    );

    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`promotion.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
