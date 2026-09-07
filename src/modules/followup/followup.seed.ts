/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:followup`. Same shape as `identity.seed.ts`,
 * `catalogue.seed.ts` and `demo.seed.ts`'s `seedLegalDocument`: idempotent,
 * re-runnable, and it never overwrites a version an admin has since
 * published or edited.
 *
 * ===========================================================================
 * *** WHY THIS SCRIPT EXISTS: WITHOUT IT, M-16 IS SILENTLY DEAD FOR EVERY
 * REAL CONSULTATION. ***
 *
 * `followup-clinical.listener.ts`'s own header says it plainly: "`followup
 * _pathways` ships with no seed data — `assignPathway` throws
 * `PATHWAY_NOT_FOUND` until `POST /admin/followup-pathways` has been used at
 * least once per code." `CONCERN_TO_PATHWAY_CODE` in that listener names
 * five codes: `depression_anxiety`, `sleep`, `substance_use`,
 * `bipolar_psychosis`, `general` (the deliberate catch-all). This script
 * publishes version 1 of all five, so `FollowupService#assignPathway`
 * succeeds for every consultation from the moment it runs.
 *
 * ── Shape, per pathway (FR-13.1 through FR-13.7) ───────────────────────────
 *
 * Every pathway shares one SAFETY CORE — `buildSafetyQuestions`/
 * `buildSafetyRedFlagRules` below — asking the same nine safety questions in
 * the same words and firing the same seven RED rules, one per FR-13.5
 * category (self-harm thoughts, severe worsening, confusion or agitation,
 * violence risk, severe withdrawal, medication side effects, feeling
 * unsafe), plus four AMBER rules for FR-13.3 (missed medicine, mild side
 * effects, mild withdrawal, symptoms somewhat worse). That is deliberate:
 * FR-13.4/13.5 describe red-flag detection as a property of a check-in, not
 * of a diagnosis, and `general` — the pathway ANY concern falls back to —
 * must carry full safety coverage on its own. Each pathway then adds a
 * pathway-specific "primary check" question (FR-13.1: "distinct sets") and,
 * for `depression_anxiety`, `sleep`, `substance_use` and `bipolar_psychosis`,
 * one or two extra content questions plus extra rules layered on top of the
 * shared core.
 *
 * Every `redFlagRules[].reason` is written to describe the ANSWER or RISK
 * that fired — never a diagnostic label — and this script calls the exact
 * same `validateQuestions`/`validateRedFlagRules` (and therefore the exact
 * same `assertReasonNamesNoDiagnosis` blocklist) `POST /admin/followup-
 * pathways` runs, BEFORE writing anything, so a bad edit to this file fails
 * loudly here rather than reaching a patient's check-in screen.
 *
 * `durationDays: 7` throughout — the schema's own default
 * (`followup-pathways.schema.ts`), and there is no pathway-specific reason
 * to deviate: FR-13 names a "seven-day follow-up" uniformly, not a per-
 * pathway window.
 *
 * ===========================================================================
 * *** DEVELOPER STARTER CONTENT — NOT CLINICALLY REVIEWED. ***
 *
 * SRS §8 / `docs/MODULES.md` §7: "All clinical content and clinical rules
 * are authored and approved by the client before launch; modules provide the
 * tools, not the wording." Every question and every `reason` string below is
 * a DEVELOPER STARTER SET, written so the mechanism — pathway assignment,
 * daily check-ins, red-flag detection and alerting — is demonstrable and
 * testable end to end. It is not the client's voice and has not been
 * clinically reviewed. Every string is editable from the admin panel with no
 * app release (FR-13.7, via `POST /admin/followup-pathways` to publish a new
 * version), which is the whole reason `followup_pathways` is a table and not
 * a constant. Each row created here is audited with
 * `clinicallyReviewed: false` in `audit_log.metadata` so this gap stays
 * findable.
 * ===========================================================================
 *
 * ── ALSO REACHABLE FROM `demo.seed.ts` ─────────────────────────────────────
 *
 * `seedPathway` and `GENERAL_PATHWAY_DEFINITION` are exported, and
 * `demo.seed.ts` calls them for the `general` code specifically: a fresh
 * database that has only ever run `demo.seed.ts` (not this script) can still
 * finalise a consultation and see M-16 work, because `general` is the code
 * EVERY concern falls back to (`CONCERN_TO_PATHWAY_CODE`'s `DEFAULT_PATHWAY
 * _CODE`). `demo.seed.ts` does not re-author the row — it calls this file's
 * own idempotent `seedPathway`, so the two scripts can never disagree about
 * what `general` v1 looks like.
 *
 * ── IDEMPOTENT AND RE-RUNNABLE ─────────────────────────────────────────────
 *
 * For each code: if a CURRENT version already exists (an admin publish, or a
 * previous run of this script), it is left exactly alone — never
 * overwritten, matching `catalogue.seed.ts`'s and `demo.seed.ts`'s own
 * discipline. Only when no current version exists for a code does this
 * script write one (reusing an existing, un-published version 1 row if
 * there is one — the same "promote rather than duplicate" move
 * `demo.seed.ts#seedLegalDocument` makes for `legal_documents`).
 */
import { and, eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { followupPathwaysTable, type FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import { FOLLOWUP_AUDIT_ENTITY_TYPES } from './followup.constants';
import type { FollowupQuestion, RedFlagRule } from './followup-question.types';
import { validateQuestions, validateRedFlagRules } from './followup-scoring.util';

/* -------------------------------------------------------------------------- */
/* The safety core — identical questions and identical red/amber rules on    */
/* every pathway. See the header for why this is shared rather than          */
/* re-authored five times.                                                   */
/* -------------------------------------------------------------------------- */

function buildSafetyQuestions(primaryCheck: FollowupQuestion): FollowupQuestion[] {
  return [
    primaryCheck,
    {
      id: 'symptom_change',
      text: 'On a scale of 1 to 5, how do your symptoms feel today compared to yesterday? (1 = much worse, 5 = much better)',
      type: 'scale_1_5',
      required: true,
    },
    {
      id: 'medication_taken',
      text: 'If you have been prescribed medicine, did you take it today as directed?',
      type: 'yes_no',
      required: false,
    },
    {
      id: 'side_effects',
      text: 'If you are on medicine, are you having any side effects from it?',
      type: 'choice',
      options: [
        { value: 'none', label: 'No side effects' },
        { value: 'mild', label: 'Mild side effects' },
        { value: 'severe', label: 'Severe side effects' },
      ],
      required: false,
    },
    {
      id: 'self_harm_thoughts',
      text: 'In the past 24 hours, have you had any thoughts of harming yourself?',
      type: 'yes_no',
      required: true,
    },
    {
      id: 'feeling_unsafe',
      text: 'Do you feel unsafe right now, wherever you are?',
      type: 'yes_no',
      required: true,
    },
    {
      id: 'confusion_agitation',
      text: 'Have you felt unusually confused, disoriented or agitated today?',
      type: 'yes_no',
      required: true,
    },
    {
      id: 'violence_risk',
      text: 'Have you had any thoughts today of hurting someone else?',
      type: 'yes_no',
      required: true,
    },
    {
      id: 'withdrawal_symptoms',
      text: 'Are you having any physical withdrawal symptoms today, such as shaking, sweating, nausea or a seizure?',
      type: 'choice',
      options: [
        { value: 'none', label: 'None' },
        { value: 'mild', label: 'Mild (e.g. slight shakiness or restlessness)' },
        { value: 'severe', label: 'Severe (e.g. heavy sweating, shaking badly, vomiting, a seizure)' },
      ],
      required: false,
    },
  ];
}

/** The seven FR-13.5 red rules, one each, plus four FR-13.3 amber rules. Fixed ids/question ids — pairs with `buildSafetyQuestions` above. */
function buildSafetyRedFlagRules(): RedFlagRule[] {
  return [
    // FR-13.5 category 1: self-harm thoughts.
    {
      id: 'self_harm',
      questionId: 'self_harm_thoughts',
      matchValues: ['yes'],
      severity: 'red',
      reason: 'Patient reported thoughts of harming themselves in the past 24 hours.',
    },
    // FR-13.5 category 2: severe worsening.
    {
      id: 'much_worse',
      questionId: 'symptom_change',
      matchValues: ['1'],
      severity: 'red',
      reason: 'Patient reported that their symptoms are much worse than yesterday.',
    },
    // FR-13.5 category 3: confusion or agitation.
    {
      id: 'confusion_agitation',
      questionId: 'confusion_agitation',
      matchValues: ['yes'],
      severity: 'red',
      reason: 'Patient reported feeling confused, disoriented or agitated today.',
    },
    // FR-13.5 category 4: violence risk.
    {
      id: 'violence_risk',
      questionId: 'violence_risk',
      matchValues: ['yes'],
      severity: 'red',
      reason: 'Patient reported thoughts of hurting someone else today.',
    },
    // FR-13.5 category 5: severe withdrawal.
    {
      id: 'severe_withdrawal',
      questionId: 'withdrawal_symptoms',
      matchValues: ['severe'],
      severity: 'red',
      reason: 'Patient reported severe physical withdrawal symptoms today.',
    },
    // FR-13.5 category 6: medication side effects.
    {
      id: 'severe_side_effects',
      questionId: 'side_effects',
      matchValues: ['severe'],
      severity: 'red',
      reason: 'Patient reported severe side effects from their medicine.',
    },
    // FR-13.5 category 7: feeling unsafe.
    {
      id: 'feeling_unsafe',
      questionId: 'feeling_unsafe',
      matchValues: ['yes'],
      severity: 'red',
      reason: 'Patient reported feeling unsafe right now.',
    },
    // FR-13.3 amber signals.
    {
      id: 'missed_medication',
      questionId: 'medication_taken',
      matchValues: ['no'],
      severity: 'amber',
      reason: 'Patient reported not taking their prescribed medicine as directed today.',
    },
    {
      id: 'mild_side_effects',
      questionId: 'side_effects',
      matchValues: ['mild'],
      severity: 'amber',
      reason: 'Patient reported mild side effects from their medicine.',
    },
    {
      id: 'mild_withdrawal',
      questionId: 'withdrawal_symptoms',
      matchValues: ['mild'],
      severity: 'amber',
      reason: 'Patient reported mild physical withdrawal symptoms today.',
    },
    {
      id: 'somewhat_worse',
      questionId: 'symptom_change',
      matchValues: ['2'],
      severity: 'amber',
      reason: 'Patient reported that their symptoms are somewhat worse than yesterday.',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The five pathways `CONCERN_TO_PATHWAY_CODE` names.                        */
/* -------------------------------------------------------------------------- */

export interface PathwayDefinition {
  code: string;
  name: string;
  durationDays: number;
  questions: FollowupQuestion[];
  redFlagRules: RedFlagRule[];
}

const GENERAL: PathwayDefinition = {
  code: 'general',
  name: 'General Follow-up',
  durationDays: 7,
  questions: buildSafetyQuestions({
    id: 'overall_wellbeing',
    text: 'On a scale of 1 to 5, how are you feeling overall today? (1 = very poor, 5 = very good)',
    type: 'scale_1_5',
    required: true,
  }),
  redFlagRules: buildSafetyRedFlagRules(),
};

const DEPRESSION_ANXIETY: PathwayDefinition = {
  code: 'depression_anxiety',
  name: 'Depression and Anxiety Follow-up',
  durationDays: 7,
  questions: [
    ...buildSafetyQuestions({
      id: 'mood_anxiety_level',
      text: 'On a scale of 1 to 5, how would you rate your mood and anxiety today? (1 = very low or very anxious, 5 = calm and good)',
      type: 'scale_1_5',
      required: true,
    }),
    {
      id: 'daily_functioning',
      text: 'Were you able to manage your usual daily activities today, such as work, chores or spending time with others?',
      type: 'yes_no',
      required: true,
    },
  ],
  redFlagRules: [
    ...buildSafetyRedFlagRules(),
    {
      id: 'daily_functioning_amber',
      questionId: 'daily_functioning',
      matchValues: ['no'],
      severity: 'amber',
      reason: 'Patient reported difficulty managing usual daily activities today.',
    },
  ],
};

const SLEEP: PathwayDefinition = {
  code: 'sleep',
  name: 'Sleep Follow-up',
  durationDays: 7,
  questions: [
    ...buildSafetyQuestions({
      id: 'sleep_quality',
      text: 'On a scale of 1 to 5, how would you rate your sleep last night? (1 = very poor, 5 = very good)',
      type: 'scale_1_5',
      required: true,
    }),
    {
      id: 'daytime_sleepiness',
      text: 'Did you feel excessively sleepy or find it hard to function during the day today?',
      type: 'yes_no',
      required: true,
    },
  ],
  redFlagRules: [
    ...buildSafetyRedFlagRules(),
    {
      id: 'daytime_sleepiness_amber',
      questionId: 'daytime_sleepiness',
      matchValues: ['yes'],
      severity: 'amber',
      reason: 'Patient reported excessive daytime sleepiness affecting their day.',
    },
  ],
};

const SUBSTANCE_USE: PathwayDefinition = {
  code: 'substance_use',
  name: 'Substance Use Follow-up',
  durationDays: 7,
  questions: [
    ...buildSafetyQuestions({
      id: 'craving_intensity',
      text: 'On a scale of 1 to 5, how strong were your urges or cravings today? (1 = none, 5 = very strong)',
      type: 'scale_1_5',
      required: true,
    }),
    {
      id: 'substance_use_today',
      text: 'Did you use the substance you are working on cutting down or stopping today?',
      type: 'yes_no',
      required: true,
    },
  ],
  redFlagRules: [
    ...buildSafetyRedFlagRules(),
    {
      id: 'strong_craving_amber',
      questionId: 'craving_intensity',
      matchValues: ['5'],
      severity: 'amber',
      reason: 'Patient reported very strong urges or cravings today.',
    },
    {
      id: 'substance_use_amber',
      questionId: 'substance_use_today',
      matchValues: ['yes'],
      severity: 'amber',
      reason: 'Patient reported using the substance they are working on stopping today.',
    },
  ],
};

const BIPOLAR_PSYCHOSIS: PathwayDefinition = {
  code: 'bipolar_psychosis',
  name: 'Bipolar and Psychosis Follow-up',
  durationDays: 7,
  questions: [
    ...buildSafetyQuestions({
      id: 'mood_stability',
      text: 'On a scale of 1 to 5, how stable did your mood feel today — not too high and not too low? (1 = very unstable, 5 = very stable)',
      type: 'scale_1_5',
      required: true,
    }),
    {
      id: 'unusual_experiences',
      text: 'Today, did you see, hear or believe anything that people around you say is not there or not true?',
      type: 'yes_no',
      required: true,
    },
    {
      id: 'sleep_change',
      text: 'Has your need for sleep changed a lot compared to normal today — sleeping much less or much more than usual?',
      type: 'yes_no',
      required: true,
    },
  ],
  redFlagRules: [
    ...buildSafetyRedFlagRules(),
    {
      id: 'unusual_experiences_red',
      questionId: 'unusual_experiences',
      matchValues: ['yes'],
      severity: 'red',
      reason: 'Patient reported experiences that people around them say are not real.',
    },
    {
      id: 'sleep_change_amber',
      questionId: 'sleep_change',
      matchValues: ['yes'],
      severity: 'amber',
      reason: 'Patient reported a large change in their need for sleep today.',
    },
  ],
};

const PATHWAY_DEFINITIONS: readonly PathwayDefinition[] = [
  GENERAL,
  DEPRESSION_ANXIETY,
  SLEEP,
  SUBSTANCE_USE,
  BIPOLAR_PSYCHOSIS,
];

/**
 * Exported so `demo.seed.ts` can fold the `general` pathway into its own
 * flow WITHOUT re-authoring its content — see this file's header and
 * `demo.seed.ts`'s own header for why `general` specifically is folded in.
 */
export { GENERAL as GENERAL_PATHWAY_DEFINITION };

/* -------------------------------------------------------------------------- */

export interface PathwaySeedResult {
  code: string;
  id: string;
  version: number;
  outcome: 'created' | 'promoted_existing_v1' | 'left_existing_current_alone';
}

/**
 * One pathway code, idempotently. Mirrors `demo.seed.ts#seedLegalDocument`'s
 * three-way branch for `legal_documents`:
 *
 *   1. A current version already exists (an admin publish, or a previous run
 *      of this script) -> leave it exactly alone.
 *   2. No current version, but an un-published version 1 row already exists
 *      (a partial previous run) -> promote it rather than mint a duplicate,
 *      since `(code, version)` is UNIQUE.
 *   3. Neither exists -> insert version 1, current, and audit it.
 *
 * Exported (not just used by this file's own `seed()`) so `demo.seed.ts` can
 * call the SAME idempotent logic for `GENERAL_PATHWAY_DEFINITION` rather than
 * duplicating the row-construction/promotion logic inline — this file's
 * header's judgment call.
 */
export async function seedPathway(db: Database, definition: PathwayDefinition): Promise<PathwaySeedResult> {
  // Self-validate with the EXACT SAME gate `POST /admin/followup-pathways`
  // applies — including `assertReasonNamesNoDiagnosis` — so a mistake in this
  // file's content fails loudly here, not against a patient's check-in.
  const questions = validateQuestions(definition.questions);
  const redFlagRules = validateRedFlagRules(definition.redFlagRules, questions);

  const [current] = await db
    .select({ id: followupPathwaysTable.id, version: followupPathwaysTable.version })
    .from(followupPathwaysTable)
    .where(and(eq(followupPathwaysTable.code, definition.code), eq(followupPathwaysTable.isCurrent, true)))
    .limit(1);
  if (current) {
    return { code: definition.code, id: current.id, version: current.version, outcome: 'left_existing_current_alone' };
  }

  const [existingV1] = await db
    .select({ id: followupPathwaysTable.id })
    .from(followupPathwaysTable)
    .where(and(eq(followupPathwaysTable.code, definition.code), eq(followupPathwaysTable.version, 1)));
  if (existingV1) {
    await db.update(followupPathwaysTable).set({ isCurrent: true }).where(eq(followupPathwaysTable.id, existingV1.id));
    return { code: definition.code, id: existingV1.id, version: 1, outcome: 'promoted_existing_v1' };
  }

  const row: FollowupPathwayRow = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(followupPathwaysTable)
      .values({
        code: definition.code,
        name: definition.name,
        version: 1,
        durationDays: definition.durationDays,
        questions,
        redFlagRules,
        isCurrent: true,
      })
      .returning();

    // Clinical content coming into existence is an audited event, same
    // discipline `pricing.seed.ts`/`promotion.seed.ts` apply to configuration
    // — `docs/MODULES.md` §7. `clinicallyReviewed: false` keeps this
    // developer-authored gap findable, the same role `caSignOffRequired` and
    // `legalSignOffRequired` play in those two scripts.
    await tx.insert(auditLogTable).values({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.FOLLOWUP_PATHWAY,
      entityId: created.id,
      metadata: {
        code: created.code,
        version: created.version,
        published: true,
        source: 'followup.seed',
        clinicallyReviewed: false,
      },
    });

    return created;
  });

  return { code: definition.code, id: row.id, version: row.version, outcome: 'created' };
}

async function seed(): Promise<PathwaySeedResult[]> {
  // `loadEnvFiles()` FIRST, never `getEnv()` — the same ordering every seed
  // and every real-database spec in this repository uses.
  loadEnvFiles();
  const db = await connectDatabase();

  const results: PathwaySeedResult[] = [];
  for (const definition of PATHWAY_DEFINITIONS) {
    results.push(await seedPathway(db, definition));
  }
  return results;
}

function report(results: PathwaySeedResult[]): string {
  const lines = [
    'followup.seed: done. THIS IS DEVELOPER STARTER CLINICAL CONTENT, NOT CLINICALLY REVIEWED — see this file\'s header.',
    '',
    ...results.map((r) => `  ${r.code.padEnd(20)} v${r.version}  id=${r.id}  ${r.outcome}`),
    '',
  ];

  const missing = ['depression_anxiety', 'sleep', 'substance_use', 'bipolar_psychosis', 'general'].filter(
    (code) => !results.some((r) => r.code === code),
  );
  if (missing.length > 0) {
    lines.push(`  *** WARNING: no result for ${missing.join(', ')} — CONCERN_TO_PATHWAY_CODE will still 404. ***`);
  } else {
    lines.push(
      '  All five codes CONCERN_TO_PATHWAY_CODE (followup-clinical.listener.ts) can produce now have a',
      '  current version. FollowupService#assignPathway will succeed on the next consultation finalised.',
    );
  }

  return lines.join('\n');
}

// Only run as a CLI when executed directly (`npm run db:seed:followup`) —
// NOT when `demo.seed.ts` imports `seedPathway`/`GENERAL_PATHWAY_DEFINITION`
// from this module, which must not trigger a second `connectDatabase`/
// `process.exit`.
if (require.main === module) {
  seed()
    .then(async (results) => {
      process.stdout.write(`${report(results)}\n`);
      await disconnectDatabase();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`followup.seed: failed — ${message}\n`);
      await disconnectDatabase();
      process.exit(1);
    });
}
