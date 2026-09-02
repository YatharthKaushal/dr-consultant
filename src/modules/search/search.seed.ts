/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:search` (see package.json). Same shape as
 * `catalogue.seed.ts` and `identity.seed.ts`: idempotent, re-runnable,
 * insert-only. Run it AFTER `db:seed:catalogue`, which creates the
 * specialties these concerns hang off.
 *
 * ===========================================================================
 * *** CLINICIAN SIGN-OFF REQUIRED BEFORE LAUNCH. ***
 *
 * SRS §8: "All clinical content, including ... emergency guidance wording and
 * THE SYMPTOM-TO-SPECIALTY MAPPING, must be reviewed and approved by a
 * qualified clinician before launch." `docs/MODULES.md` §7 says the same:
 * "All clinical content and clinical rules are authored and approved by the
 * client before launch; modules provide the tools, not the wording."
 *
 * Everything below — the nine concerns' specialty assignments, their
 * `matchWeight` values, every `matchPhrase`, and the crisis keyword and
 * emergency-guidance defaults written into `app_config` — is a DEVELOPER
 * STARTER SET. It exists so the mechanism is demonstrable and testable end to
 * end on day one, not because these are the right clinical words. The client's
 * clinician owns the wording and must review it before this goes to patients.
 *
 * Every one of these values is editable from the admin panel with no release
 * (FR-5.7, via `PATCH /admin/concerns/:id/mapping` and
 * `PUT /admin/search/config`), which is the whole reason they live in data.
 * ===========================================================================
 *
 * Idempotency: concerns are keyed on `(specialty_id, code)` — the table's own
 * unique index — and skipped if present, so a re-run never overwrites a
 * phrase list a clinician has since corrected. `app_config` defaults are
 * `ON CONFLICT DO NOTHING` for the same reason.
 */
import { and, eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { concernsTable } from '../../schema/concerns.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { SEARCH_APP_CONFIG_DEFAULTS } from './search.constants';

interface StarterConcern {
  /** `specialties.code` this concern hangs off. */
  specialtyCode: string;
  code: string;
  name: string;
  /**
   * English, Hindi (Devanagari) and Hinglish/romanised trigger phrases. The
   * deterministic matcher scores against these, and they are also fed to the
   * model as the synonym cue for informal phrasing (FR-5.1) — so an admin
   * edit here changes BOTH paths, which is what FR-5.7 requires.
   */
  matchPhrases: string[];
  /** Relative pull when several concerns match one query. Not a severity, not a priority — a matching weight. */
  matchWeight: number;
}

/** The nine concerns named in FR-5.2, under the specialties `catalogue.seed.ts` creates. */
const STARTER_CONCERNS: readonly StarterConcern[] = [
  {
    specialtyCode: 'psychiatry',
    code: 'depression',
    name: 'Depression and low mood',
    matchWeight: 5,
    matchPhrases: [
      'depression', 'depressed', 'low mood', 'feeling low', 'feeling sad', 'sadness', 'hopeless', 'no interest',
      'lost interest', 'cannot enjoy anything', 'crying all the time', 'feeling empty', 'no energy', 'worthless',
      'उदासी', 'निराशा', 'मन नहीं लगता', 'दुखी', 'डिप्रेशन', 'मन उदास', 'कुछ अच्छा नहीं लगता', 'रोना आता है',
      'udaasi', 'man nahi lagta', 'dukhi', 'depression hai', 'mood kharab', 'kuch acha nahi lagta', 'nirasha',
    ],
  },
  {
    specialtyCode: 'psychiatry',
    code: 'anxiety',
    name: 'Anxiety and stress',
    matchWeight: 5,
    matchPhrases: [
      'anxiety', 'anxious', 'panic', 'panic attack', 'worry', 'worried all the time', 'overthinking', 'restless',
      'nervous', 'stress', 'stressed', 'tension', 'heart racing', 'fear', 'work stress', 'exam stress',
      'चिंता', 'घबराहट', 'बेचैनी', 'तनाव', 'डर लगता है', 'दिल तेज़ धड़कता', 'ज़्यादा सोचना', 'पैनिक',
      'chinta', 'ghabrahat', 'bechaini', 'tanav', 'tension hai', 'dar lagta hai', 'panic hota hai', 'zyada sochna',
    ],
  },
  {
    specialtyCode: 'psychiatry',
    code: 'sleep',
    name: 'Sleep problems',
    matchWeight: 5,
    matchPhrases: [
      'sleep', 'cannot sleep', 'cant sleep', 'not sleeping', 'insomnia', 'trouble sleeping', 'sleepless',
      'waking up at night', 'disturbed sleep', 'sleeping too much', 'no sleep', 'awake all night', 'bad dreams',
      'नींद', 'नींद नहीं आती', 'नींद की समस्या', 'रात भर जागना', 'नींद टूट जाती', 'ठीक से नहीं सोता',
      'neend', 'neend nahi aati', 'neend na aana', 'raat bhar jagta', 'so nahi pata', 'nind nahi aati',
    ],
  },
  {
    specialtyCode: 'psychiatry',
    code: 'ocd',
    name: 'Obsessive thoughts and compulsions',
    matchWeight: 4,
    matchPhrases: [
      'ocd', 'obsessive', 'obsession', 'compulsion', 'repeated thoughts', 'unwanted thoughts', 'intrusive thoughts',
      'checking again and again', 'washing hands again and again', 'cleanliness obsession', 'repeating rituals',
      'बार बार हाथ धोना', 'बार बार चेक करना', 'अनचाहे विचार', 'सफाई की आदत', 'दोहराना',
      'baar baar haath dhona', 'baar baar check karna', 'anchahe vichar', 'ocd hai', 'safai ki aadat',
    ],
  },
  {
    specialtyCode: 'de_addiction',
    code: 'substance_use',
    name: 'Alcohol, tobacco and substance use',
    matchWeight: 5,
    matchPhrases: [
      'alcohol', 'drinking', 'drinking too much', 'want to quit drinking', 'stop drinking', 'addiction', 'addicted',
      'smoking', 'quit smoking', 'tobacco', 'gutkha', 'drugs', 'substance', 'de addiction', 'deaddiction',
      'withdrawal', 'cannot stop', 'ganja', 'weed',
      'शराब', 'शराब छोड़ना', 'नशा', 'नशा छोड़ना', 'सिगरेट', 'तंबाकू', 'लत', 'गुटखा',
      'sharab', 'sharab chodna', 'nasha', 'nasha chodna', 'lat lag gayi', 'cigarette chodna', 'tambaku',
    ],
  },
  {
    specialtyCode: 'psychiatry',
    code: 'psychosis',
    name: 'Unusual experiences and confusion',
    matchWeight: 5,
    matchPhrases: [
      'hearing voices', 'seeing things', 'voices in my head', 'people are after me', 'being followed',
      'strange thoughts', 'not making sense', 'confused thinking', 'suspicious of everyone', 'talking to himself',
      'talking to herself', 'behaving strangely',
      'आवाज़ें सुनाई देती', 'दिखाई देता है', 'शक होता है', 'अजीब बातें', 'खुद से बात करना', 'अजीब व्यवहार',
      'awaz sunai deti hai', 'shak hota hai', 'ajeeb baatein', 'khud se baat karta', 'ajeeb vyavhar',
    ],
  },
  {
    specialtyCode: 'psychology',
    code: 'child_adolescent',
    name: 'Child and adolescent concerns',
    matchWeight: 4,
    matchPhrases: [
      'child', 'my child', 'kid', 'son', 'daughter', 'teenager', 'teen', 'adolescent', 'school', 'studies',
      'not studying', 'school refusal', 'behaviour problem', 'anger at school', 'bullying', 'exam pressure',
      'screen addiction', 'mobile addiction',
      'बच्चा', 'बच्ची', 'मेरा बेटा', 'मेरी बेटी', 'किशोर', 'स्कूल', 'पढ़ाई', 'पढ़ाई में मन नहीं',
      'bacha', 'bachi', 'mera beta', 'meri beti', 'school nahi jata', 'padhai mein man nahi', 'kishor',
    ],
  },
  {
    specialtyCode: 'psychology',
    code: 'womens_mental_health',
    name: "Women's mental health",
    matchWeight: 4,
    matchPhrases: [
      'pregnancy', 'pregnant', 'after delivery', 'postpartum', 'new mother', 'periods', 'menstrual', 'pms',
      'menopause', 'infertility', 'womens health', 'mood before periods', 'baby blues',
      'गर्भावस्था', 'डिलीवरी के बाद', 'माहवारी', 'पीरियड्स', 'मेनोपॉज', 'नई माँ',
      'pregnancy ke baad', 'delivery ke baad', 'periods ke time', 'mahavari', 'menopause ho raha',
    ],
  },
  {
    specialtyCode: 'psychology',
    code: 'elderly_care',
    name: 'Elderly mental health',
    matchWeight: 4,
    matchPhrases: [
      'elderly', 'old age', 'senior citizen', 'my father', 'my mother', 'grandfather', 'grandmother',
      'memory loss', 'forgetting things', 'forgetful', 'dementia', 'loneliness in old age', 'after retirement',
      'बुजुर्ग', 'बुढ़ापा', 'याददाश्त', 'भूल जाते हैं', 'अकेलापन', 'पिताजी', 'माताजी',
      'budhape mein', 'yaddasht kamzor', 'bhool jate hain', 'akelapan', 'buzurg',
    ],
  },
];

interface SeedSummary {
  concernsInserted: string[];
  concernsAlreadyPresent: string[];
  missingSpecialties: string[];
  configKeysInserted: number;
}

async function seed(): Promise<SeedSummary> {
  loadEnvFiles();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = {
    concernsInserted: [],
    concernsAlreadyPresent: [],
    missingSpecialties: [],
    configKeysInserted: 0,
  };

  await db.transaction(async (tx) => {
    const specialtyRows = await tx.select({ id: specialtiesTable.id, code: specialtiesTable.code }).from(specialtiesTable);
    const specialtyIdByCode = new Map(specialtyRows.map((row) => [row.code, row.id]));

    for (const concern of STARTER_CONCERNS) {
      const specialtyId = specialtyIdByCode.get(concern.specialtyCode);
      if (!specialtyId) {
        // Reported, not thrown: the operator should run db:seed:catalogue
        // first, and a partial run must still be re-runnable.
        summary.missingSpecialties.push(`${concern.code} -> ${concern.specialtyCode}`);
        continue;
      }

      const [existing] = await tx
        .select({ id: concernsTable.id })
        .from(concernsTable)
        .where(and(eq(concernsTable.specialtyId, specialtyId), eq(concernsTable.code, concern.code)))
        .limit(1);

      if (existing) {
        summary.concernsAlreadyPresent.push(concern.code);
        continue;
      }

      const [row] = await tx
        .insert(concernsTable)
        .values({
          specialtyId,
          code: concern.code,
          name: concern.name,
          matchPhrases: concern.matchPhrases,
          matchWeight: concern.matchWeight,
          isActive: true,
        })
        .onConflictDoNothing()
        .returning({ id: concernsTable.id });

      if (row) {
        summary.concernsInserted.push(concern.code);
        await tx.insert(auditLogTable).values({
          actorType: 'system',
          actorId: null,
          action: 'create',
          entityType: 'concern',
          entityId: row.id,
          metadata: {
            after: { code: concern.code, name: concern.name, specialtyCode: concern.specialtyCode, matchWeight: concern.matchWeight },
            source: 'search.seed',
            clinicianSignOffRequired: true,
          },
        });
      } else {
        // Lost a race with a concurrent seed run — treat as already present.
        summary.concernsAlreadyPresent.push(concern.code);
      }
    }

    // `search.*` defaults — insert-only, never overwriting an admin-tuned value.
    for (const [key, value] of Object.entries(SEARCH_APP_CONFIG_DEFAULTS)) {
      const inserted = await tx
        .insert(appConfigTable)
        .values({ key, value })
        .onConflictDoNothing({ target: appConfigTable.key })
        .returning({ id: appConfigTable.id });
      if (inserted.length > 0) summary.configKeysInserted += 1;
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`search.seed: done — ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      'search.seed: NOTE — concern match phrases, crisis keywords and emergency guidance are a DEVELOPER STARTER SET and require clinician sign-off before launch (SRS section 8).\n',
    );
    if (summary.missingSpecialties.length > 0) {
      process.stdout.write('search.seed: some specialties were missing — run `npm run db:seed:catalogue` first, then re-run this.\n');
    }
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`search.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
