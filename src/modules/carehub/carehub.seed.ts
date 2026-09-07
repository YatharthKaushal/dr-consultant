/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:carehub`. Same shape as `catalogue.seed.ts`: idempotent,
 * re-runnable, insert-only, `ON CONFLICT (slug) DO NOTHING` — a re-run never
 * overwrites an item an admin has since edited through
 * `PUT /api/admin/content-items/:id`.
 *
 * ===========================================================================
 * *** WHY THIS SCRIPT EXISTS: `content_items` SHIPS EMPTY. ***
 *
 * `carehub.service.ts#listPublished` and the Care Plan's "recommended self-
 * help" read (`CarehubFacade`) both filter on `review_status = 'published'`.
 * With zero rows, patient browse (FR-15.1/15.2/15.3/15.6/15.7) renders empty
 * for every real user, and a doctor has nothing to recommend after a consult
 * (FR-15.4). This script writes one item per `CONTENT_ITEM_TYPES` value FR-15
 * actually asks for a patient-facing surface for — see the note on
 * `clinical_reference` below — already `published`, so the shelf is non-empty
 * from the moment this runs.
 *
 * ── Why `clinical_reference` is NOT seeded here ────────────────────────────
 *
 * `CONTENT_ITEM_TYPES` names seven types, but `PATIENT_FACING_ITEM_TYPES`
 * (`carehub.constants.ts`) deliberately excludes `clinical_reference`, and
 * that same file's header says why: "A doctor-facing 'browse clinical
 * references' reading surface is not something FR-15/M-18's feature list
 * asks for and is left for a future round if the client wants one." FR-15.1
 * through FR-15.7 name six patient-facing categories and this script seeds
 * one real item in each of them; a `clinical_reference` row would sit behind
 * no reading surface at all today, so it is left out rather than seeded
 * inert.
 *
 * ── Body shape ──────────────────────────────────────────────────────────
 *
 * `content_items.body` is `jsonb('body').$type<unknown>()` — no schema of its
 * own (`content-items.schema.ts`'s own comment: "Structured blocks. For
 * item_type = support_org this holds phone, address, timings."). This script
 * uses one block shape for every readable item (`StandardBody`, a small
 * ordered list of paragraph/heading/list/steps blocks — whatever the mobile
 * client's content renderer already expects it to walk) and a flat
 * phone/address/timings object for `support_org` — exactly what that comment
 * describes.
 *
 * ===========================================================================
 * *** DEVELOPER STARTER CONTENT — NOT CLINICALLY REVIEWED. ***
 *
 * SRS §8 / `docs/MODULES.md` §7: "All clinical content ... must be reviewed
 * and approved by a qualified clinician before launch." Every self-help tool,
 * education module, blog article and caregiver guide below is a DEVELOPER
 * STARTER SET so the browse/recommend/share mechanism is demonstrable end to
 * end — it is not the client's voice and has not been clinically reviewed.
 * `reviewedByAdminId`/`reviewedAt` are left NULL even though `reviewStatus`
 * is seeded `published`, specifically so there is no false record of a real
 * admin having signed off — the honest state is "published so the mechanism
 * works, reviewed by nobody." Every insert is audited with
 * `clinicallyReviewed: false`, the same flag `followup.seed.ts` uses for the
 * same reason.
 *
 * *** THE EMERGENCY GUIDANCE AND SUPPORT-ORG ENTRIES ARE THE ONE EXCEPTION TO
 * "DON'T TRUST THE NUMBERS": *** their helpline numbers are not invented —
 * each was checked against a public, named source on 2026-09-05 (see the
 * per-item comments below for what was checked and against what). They still
 * need the client's own confirmation before launch — helpline numbers and
 * hours change, and this script has no way to re-verify them at deploy time —
 * but they are not placeholders the way `pricing.seed.ts`'s GSTIN is.
 * ===========================================================================
 *
 * ── ALSO REACHABLE FROM `demo.seed.ts` ─────────────────────────────────────
 *
 * `seedContentItem` and `EMERGENCY_GUIDANCE` are exported, and
 * `demo.seed.ts` calls them for that one item specifically: FR-15.7's
 * persistent emergency guidance is patient-safety content, not a nice-to-
 * have, and a fresh database that has only ever run `demo.seed.ts` should
 * not be missing it just because nobody remembered to also run
 * `db:seed:carehub`. `demo.seed.ts` does not re-author the row — it calls
 * this file's own idempotent `seedContentItem`, so the two scripts can never
 * disagree about what `emergency-guidance` looks like.
 *
 * ── IDEMPOTENT AND RE-RUNNABLE ─────────────────────────────────────────────
 *
 * Every write is `ON CONFLICT (slug) DO NOTHING`, matching
 * `catalogue.seed.ts`'s discipline for `specialties.code`. A re-run changes
 * nothing for a slug already present, whatever its current review status —
 * an admin who has since archived or edited a seeded item is never
 * overwritten.
 */
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { contentItemsTable, type NewContentItemRow } from '../../schema/content-items.schema';
import type { ContentItemType } from '../../schema/enums.schema';
import { CARE_HUB_AUDIT_ENTITY_TYPES } from './carehub.constants';

/* -------------------------------------------------------------------------- */
/* Body block shapes — see the header.                                       */
/* -------------------------------------------------------------------------- */

type ContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'steps'; items: string[] };

interface StandardBody {
  blocks: ContentBlock[];
}

/** `content-items.schema.ts`'s own comment: "For item_type = support_org this holds phone, address, timings." */
interface SupportOrgBody {
  phone: string;
  alternatePhone?: string;
  email?: string;
  website?: string;
  address: string;
  timings: string;
  languages?: string[];
  servicesOffered?: string[];
}

export interface ContentItemDefinition {
  itemType: ContentItemType;
  slug: string;
  title: string;
  summary: string;
  body: StandardBody | SupportOrgBody;
  isVerifiedOrg?: boolean;
  sortOrder?: number;
}

/* -------------------------------------------------------------------------- */
/* self_help_tool x 3 — FR-15.1 (breathing exercise, grounding technique,     */
/* sleep hygiene are its own listed starting points).                        */
/* -------------------------------------------------------------------------- */

const BREATHING_EXERCISE: ContentItemDefinition = {
  itemType: 'self_help_tool',
  slug: 'breathing-exercise-4-7-8',
  title: '4-7-8 Breathing Exercise',
  summary: "A simple breathing pattern to calm your body when you're feeling anxious or overwhelmed.",
  sortOrder: 0,
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: "This exercise slows your breathing and helps your body settle when you're feeling anxious, panicky or overwhelmed. Sit or lie down somewhere you feel safe closing your eyes for a minute.",
      },
      {
        type: 'steps',
        items: [
          'Let your lips part slightly and breathe out fully through your mouth.',
          'Close your mouth and breathe in quietly through your nose for a count of 4.',
          'Hold your breath for a count of 7.',
          'Breathe out completely through your mouth, making a soft whoosh sound, for a count of 8.',
          'That is one round. Repeat 3 to 4 times.',
        ],
      },
      {
        type: 'paragraph',
        text: 'Practice once or twice a day, and any time you notice your heart racing or your thoughts speeding up. Feeling a little light-headed the first few times is normal and eases with practice.',
      },
    ],
  },
};

const GROUNDING_TECHNIQUE: ContentItemDefinition = {
  itemType: 'self_help_tool',
  slug: 'grounding-technique-5-4-3-2-1',
  title: '5-4-3-2-1 Grounding Technique',
  summary: 'A quick sensory exercise to bring your attention back to the present moment during distress.',
  sortOrder: 1,
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: 'When distressing thoughts or memories feel overwhelming, this exercise uses your five senses to bring your attention back to the room you are in, right now.',
      },
      {
        type: 'steps',
        items: [
          'Name 5 things you can see around you.',
          'Name 4 things you can physically feel — your feet on the floor, the fabric of your clothes, the chair under you.',
          'Name 3 things you can hear.',
          'Name 2 things you can smell, or two smells you like.',
          'Name 1 thing you can taste, or one thing you are grateful for right now.',
        ],
      },
      {
        type: 'paragraph',
        text: "Go slowly, and say each one out loud if you can. If distressing thoughts keep returning strongly, that's a sign to reach out — see Emergency Guidance, or book a follow-up from your Care Plan.",
      },
    ],
  },
};

const SLEEP_HYGIENE: ContentItemDefinition = {
  itemType: 'self_help_tool',
  slug: 'sleep-hygiene-basics',
  title: 'Sleep Hygiene: Building Better Sleep Habits',
  summary: 'Everyday habits that make it easier to fall asleep and stay asleep.',
  sortOrder: 2,
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: 'Sleep problems are common, and usually improve with a few consistent daily habits alongside anything your doctor has prescribed.',
      },
      {
        type: 'list',
        items: [
          'Go to bed and wake up at the same time every day, including weekends.',
          'Avoid caffeine, nicotine and heavy meals for at least 4-6 hours before bed.',
          'Keep your bedroom dark, quiet and cool, and use your bed only for sleep.',
          'Put screens away — phone, TV, laptop — at least 30 minutes before bed.',
          "If you can't fall asleep within about 20 minutes, get up and do something calming in dim light, then return to bed when sleepy.",
          'Get some natural daylight and physical activity earlier in the day.',
        ],
      },
      {
        type: 'paragraph',
        text: 'If poor sleep continues for more than two weeks, or is affecting your daytime functioning, mention it at your next check-in or follow-up booking.',
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* education_module x 1 — FR-15.2.                                            */
/* -------------------------------------------------------------------------- */

const EDUCATION_DEPRESSION_ANXIETY: ContentItemDefinition = {
  itemType: 'education_module',
  slug: 'education-depression-anxiety-basics',
  title: "Understanding Depression and Anxiety: A Patient's Guide",
  summary: 'What depression and anxiety are, common symptoms, and how treatment usually helps.',
  body: {
    blocks: [
      { type: 'heading', text: 'What are depression and anxiety?' },
      {
        type: 'paragraph',
        text: 'Depression and anxiety are common, treatable conditions — not a sign of weakness and not something you can simply "snap out of". Depression often shows up as low mood, loss of interest in things you used to enjoy, low energy or changes in sleep and appetite that last most days for two weeks or more. Anxiety often shows up as persistent worry, restlessness, a racing heart or difficulty concentrating, even when there is no immediate danger.',
      },
      { type: 'heading', text: 'How treatment usually helps' },
      {
        type: 'paragraph',
        text: 'Treatment is often a combination of medicine, therapy and everyday changes, and it takes time — most medicines need a few weeks of consistent use before their full effect is clear. Taking medicine exactly as prescribed, even once you start feeling better, and attending your follow-up check-ins, are the two biggest things that improve outcomes.',
      },
      { type: 'heading', text: 'When to seek urgent help' },
      {
        type: 'list',
        items: [
          'Thoughts of harming yourself, or that life is not worth living',
          'Feeling unable to cope with day-to-day life',
          'Symptoms getting rapidly worse over a few days',
          'New or worsening side effects from a medicine',
        ],
      },
      {
        type: 'paragraph',
        text: 'If any of these apply to you right now, see the Emergency Guidance section of this app.',
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* blog_article x 1 — FR-15.3.                                                */
/* -------------------------------------------------------------------------- */

const BLOG_STIGMA: ContentItemDefinition = {
  itemType: 'blog_article',
  slug: 'blog-talking-about-mental-health',
  title: "Why Talking About Mental Health Still Feels Hard — And Why It's Worth It",
  summary: 'A short read on stigma, and small ways to talk about mental health more openly.',
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: "Many people wait months or years before telling anyone — including a doctor — that they're struggling. That delay is rarely about the condition itself; it's usually about what we're afraid others will think.",
      },
      { type: 'heading', text: 'Where the silence comes from' },
      {
        type: 'paragraph',
        text: "Fear of being seen as 'weak' or 'dramatic', worry about how family or colleagues will react, and simply not having the words for what you're feeling all keep people quiet. None of that changes what's actually happening in your body and mind, or how treatable it usually is.",
      },
      { type: 'heading', text: 'What actually helps' },
      {
        type: 'list',
        items: [
          "Say what you're noticing, not a diagnosis: 'I've not been sleeping and I feel on edge all the time' is easier to say, and easier for someone to respond to, than a label.",
          'Tell one person you trust, even if it feels small — a friend, a family member, or your doctor at your next consult.',
          'Treat a first conversation as a start, not a one-time performance — it is normal to say more over several conversations.',
          "Remember that asking for help is the same instinct that makes you go to a doctor for a fever — it doesn't need to be dramatic to be valid.",
        ],
      },
      {
        type: 'paragraph',
        text: "If you're not ready to talk to someone you know, a consultation on this platform, or one of the helplines in Emergency Guidance and the NGO directory, is a private place to start.",
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* caregiver_guide x 1 — FR-15.5.                                             */
/* -------------------------------------------------------------------------- */

const CAREGIVER_GUIDE: ContentItemDefinition = {
  itemType: 'caregiver_guide',
  slug: 'caregiver-guide-supporting-recovery',
  title: "A Caregiver's Guide to Supporting Recovery",
  summary: 'Practical guidance for family members and caregivers: warning signs, medicines, relapse, communication and emergency support.',
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: 'Supporting someone with a mental health condition is easier when you know what to watch for and how to respond — this guide covers the basics. It is shareable with the patient\'s consent from their Care Plan.',
      },
      { type: 'heading', text: 'Warning signs to watch for' },
      {
        type: 'list',
        items: [
          'Withdrawing from family, friends or activities they used to enjoy',
          'Talking about feeling hopeless, or being a burden to others',
          'Sudden changes in sleep, appetite or energy',
          'Increased use of alcohol or other substances',
          'Neglecting self-care or daily responsibilities',
        ],
      },
      { type: 'heading', text: 'Supporting medicine adherence' },
      {
        type: 'list',
        items: [
          'A simple pillbox or a daily phone reminder helps more than it seems like it should.',
          "Don't stop or change a medicine because side effects appear — call the prescribing doctor first.",
          'Improvement is often gradual over weeks, not days — encourage sticking with a plan long enough for it to work.',
        ],
      },
      { type: 'heading', text: 'Signs of relapse' },
      {
        type: 'paragraph',
        text: 'A return of the symptoms that first brought them to treatment, missed medicine doses, missed check-ins or appointments, or withdrawing again after a period of doing better are all signs worth raising with their doctor promptly, ideally before things escalate.',
      },
      { type: 'heading', text: 'Communicating well' },
      {
        type: 'list',
        items: [
          'Listen without immediately trying to fix or minimise what they share.',
          "Ask directly and calmly if you're worried, including asking about thoughts of self-harm — asking does not put the idea in their head, and it opens the door for them to be honest.",
          'Avoid ultimatums; offer to help them get support rather than insisting they change on their own.',
        ],
      },
      { type: 'heading', text: 'When to seek emergency help' },
      {
        type: 'paragraph',
        text: 'If they talk about ending their life, harm themselves, or you feel they or someone else is in immediate danger, do not wait for a scheduled appointment — see Emergency Guidance in this app for who to call right now.',
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* emergency_guidance x 1 — FR-15.7 / FR-17.3. THE MOST IMPORTANT ITEM HERE.  */
/* -------------------------------------------------------------------------- */

const EMERGENCY_GUIDANCE: ContentItemDefinition = {
  itemType: 'emergency_guidance',
  slug: 'emergency-guidance',
  title: 'If This Is a Mental Health Emergency',
  summary: "What to do right now if you or someone you're with is in danger. This app is not for emergencies.",
  body: {
    blocks: [
      {
        type: 'paragraph',
        text: 'This app is for scheduled and instant consultations and follow-up care. It is not monitored every minute of the day and it is not equipped to respond to an emergency.',
      },
      { type: 'heading', text: 'Call for help immediately if' },
      {
        type: 'list',
        items: [
          'Someone has attempted to harm themselves, or has taken an overdose',
          'Someone is talking about ending their life and has a plan or the means to act on it',
          'Someone is at risk of harming another person',
          'Someone is severely confused, unresponsive, or having a seizure',
          'Someone is having severe withdrawal symptoms — fainting, seizures, uncontrollable vomiting',
        ],
      },
      { type: 'heading', text: 'Who to call right now (India)' },
      {
        type: 'list',
        items: [
          '112 — National Emergency Number (police, fire, ambulance). Works from any phone, anywhere in India, even without a SIM card.',
          '108 — Free government ambulance service.',
          '1800-599-0019 — KIRAN Mental Health Helpline. Toll-free, 24 hours every day, Government of India, available in 13 languages.',
          '1860-266-2345 or 1800-233-3330 — Vandrevala Foundation Helpline. Free and confidential, 24 hours every day.',
        ],
      },
      {
        type: 'paragraph',
        text: 'If you can do so safely, stay with the person, remove anything they could use to hurt themselves, and go to the nearest hospital emergency department. Do not wait for a scheduled appointment.',
      },
      {
        type: 'paragraph',
        text: 'These numbers were checked against public sources when this guidance was written and are believed accurate, but helpline numbers and hours can change — if a number does not connect, call 112.',
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* support_org x 3 — FR-15.6. Real, named, publicly-listed Indian mental      */
/* health helplines — see each item's own comment for what was checked.      */
/* -------------------------------------------------------------------------- */

const SUPPORT_ORG_KIRAN: ContentItemDefinition = {
  itemType: 'support_org',
  slug: 'support-org-kiran-helpline',
  title: 'KIRAN Mental Health Helpline',
  summary: "Government of India's 24x7 toll-free mental health rehabilitation helpline, in 13 languages.",
  isVerifiedOrg: true,
  sortOrder: 0,
  // Checked 2026-09-05 against the Press Information Bureau, Government of
  // India (pib.gov.in), which announced this helpline: number, 24x7
  // availability, 13-language support and Government of India / Department
  // of Empowerment of Persons with Disabilities operation all confirmed
  // there. Re-verify before launch — this is a live phone service, not a
  // static fact.
  body: {
    phone: '1800-599-0019',
    address: "National toll-free number — accessible from anywhere in India; routes callers to their state's helpline centre.",
    timings: '24 hours, every day',
    languages: ['Hindi', 'English', 'and 11 other Indian languages'],
    servicesOffered: [
      'Early screening for mental health concerns',
      'Psychological first aid and distress management',
      'Referral to mental health professionals and services',
    ],
  } satisfies SupportOrgBody,
};

const SUPPORT_ORG_VANDREVALA: ContentItemDefinition = {
  itemType: 'support_org',
  slug: 'support-org-vandrevala-foundation',
  title: 'Vandrevala Foundation Helpline',
  summary: 'Free, confidential 24x7 mental health and crisis support by phone, in English, Hindi and regional languages.',
  isVerifiedOrg: true,
  sortOrder: 1,
  // Checked 2026-09-05 against the Vandrevala Foundation's own site
  // (vandrevalafoundation.com) and a state government helpline listing (HP
  // NHM). Both numbers and 24x7 availability agree across both sources.
  // Re-verify before launch.
  body: {
    phone: '1860-266-2345',
    alternatePhone: '1800-233-3330',
    website: 'https://www.vandrevalafoundation.com',
    address: 'National telehealth helpline (India)',
    timings: '24 hours, every day',
    servicesOffered: ['Crisis intervention', 'Emotional support', 'Referral to counselling and psychiatric care'],
  } satisfies SupportOrgBody,
};

const SUPPORT_ORG_ICALL: ContentItemDefinition = {
  itemType: 'support_org',
  slug: 'support-org-icall-tiss',
  title: 'iCALL Psychosocial Helpline (TISS)',
  summary: 'Free telephone and email counselling from the Tata Institute of Social Sciences, Monday to Saturday.',
  isVerifiedOrg: true,
  sortOrder: 2,
  // Checked 2026-09-05 against iCALL's own site (icallhelpline.org) — phone
  // number, hours and email domain confirmed there. Not 24x7 (unlike the
  // other two entries here), which is why it is listed alongside them
  // rather than in Emergency Guidance's own always-available list.
  // Re-verify before launch.
  body: {
    phone: '9152987821',
    email: 'icall@tiss.ac.in',
    website: 'https://icallhelpline.org',
    address: 'Tata Institute of Social Sciences, Mumbai — telephone/email service, available nationally',
    timings: '10:00 AM to 8:00 PM, Monday to Saturday',
    servicesOffered: ['Telephone counselling', 'Email counselling'],
  } satisfies SupportOrgBody,
};

/**
 * Exported so `demo.seed.ts` can fold this one item into its own flow
 * without re-authoring it — see this file's header and `demo.seed.ts`'s own
 * header for why `emergency_guidance` specifically is folded in.
 */
export { EMERGENCY_GUIDANCE };

const CONTENT_ITEM_DEFINITIONS: readonly ContentItemDefinition[] = [
  BREATHING_EXERCISE,
  GROUNDING_TECHNIQUE,
  SLEEP_HYGIENE,
  EDUCATION_DEPRESSION_ANXIETY,
  BLOG_STIGMA,
  CAREGIVER_GUIDE,
  EMERGENCY_GUIDANCE,
  SUPPORT_ORG_KIRAN,
  SUPPORT_ORG_VANDREVALA,
  SUPPORT_ORG_ICALL,
];

/* -------------------------------------------------------------------------- */

export type ContentItemSeedOutcome = 'inserted' | 'already_present';

/**
 * One content item, idempotently: `ON CONFLICT (slug) DO NOTHING`, so a
 * re-run (or a concurrent insert of the same slug) is a no-op, never a
 * duplicate or an error.
 *
 * Exported (not just used by this file's own `seed()`) so `demo.seed.ts` can
 * call the SAME idempotent logic for `EMERGENCY_GUIDANCE` rather than
 * duplicating the row-construction code inline — this file's header's
 * judgment call.
 */
export async function seedContentItem(db: Database, definition: ContentItemDefinition): Promise<ContentItemSeedOutcome> {
  const values: NewContentItemRow = {
    itemType: definition.itemType,
    slug: definition.slug,
    title: definition.title,
    summary: definition.summary,
    body: definition.body,
    // Neither is applicable here: no concern/specialty table row is
    // guaranteed to exist in every environment this runs against, and
    // `specialtyId` is only valid for `clinical_reference`, which this
    // script deliberately does not seed — see the header.
    concernId: null,
    specialtyId: null,
    coverStorageKey: null,
    // Only `support_org` may carry this — `carehub.service.ts
    // #assertItemTypeFieldRules` refuses it on any other type.
    isVerifiedOrg: definition.itemType === 'support_org' ? (definition.isVerifiedOrg ?? true) : null,
    reviewStatus: 'published',
    // Left NULL deliberately — see the header's "DEVELOPER STARTER
    // CONTENT" section: nobody has actually clinically reviewed this yet,
    // and a fabricated reviewer would misrepresent that.
    reviewedByAdminId: null,
    reviewedAt: null,
    sortOrder: definition.sortOrder ?? 0,
  };

  const inserted = await db
    .insert(contentItemsTable)
    .values(values)
    .onConflictDoNothing({ target: contentItemsTable.slug })
    .returning({ id: contentItemsTable.id });

  if (inserted.length === 0) return 'already_present';

  // Content coming into existence is an audited event — the same discipline
  // `carehub.service.ts#create` applies to an admin-authored item, and
  // `pricing.seed.ts`/`followup.seed.ts` apply to their own first-release
  // rows.
  await db.insert(auditLogTable).values({
    actorType: 'system',
    actorId: null,
    action: 'create',
    entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_ITEM,
    entityId: inserted[0].id,
    metadata: {
      itemType: definition.itemType,
      slug: definition.slug,
      published: true,
      source: 'carehub.seed',
      clinicallyReviewed: false,
    },
  });

  return 'inserted';
}

interface SeedSummary {
  inserted: string[];
  alreadyPresent: string[];
}

async function seed(): Promise<SeedSummary> {
  // `loadEnvFiles()` FIRST, never `getEnv()` — the same ordering every seed
  // and every real-database spec in this repository uses.
  loadEnvFiles();
  const db: Database = await connectDatabase();

  const summary: SeedSummary = { inserted: [], alreadyPresent: [] };

  for (const definition of CONTENT_ITEM_DEFINITIONS) {
    const outcome = await seedContentItem(db, definition);
    (outcome === 'inserted' ? summary.inserted : summary.alreadyPresent).push(definition.slug);
  }

  return summary;
}

function report(summary: SeedSummary): string {
  const byType = new Map<string, string[]>();
  for (const definition of CONTENT_ITEM_DEFINITIONS) {
    const list = byType.get(definition.itemType) ?? [];
    list.push(definition.slug);
    byType.set(definition.itemType, list);
  }

  const lines = [
    'carehub.seed: done. THIS IS DEVELOPER STARTER CONTENT, NOT CLINICALLY REVIEWED — see this file\'s header.',
    '',
    `  inserted:        ${summary.inserted.length === 0 ? '(none — all already present)' : summary.inserted.join(', ')}`,
    `  already present: ${summary.alreadyPresent.length === 0 ? '(none)' : summary.alreadyPresent.join(', ')}`,
    '',
    '  Coverage by item_type:',
    ...Array.from(byType.entries()).map(([type, slugs]) => `    ${type.padEnd(16)} ${slugs.join(', ')}`),
    '',
    "  NOT seeded: clinical_reference — PATIENT_FACING_ITEM_TYPES excludes it and no reading",
    '  surface exists for it yet (carehub.constants.ts).',
    '',
    '  *** Emergency Guidance and the three support_org helpline numbers were checked against',
    '  named public sources on 2026-09-05 (see each definition\'s own comment) but still need the',
    "  client's own confirmation before launch — this script cannot re-verify a live phone service.",
  ];

  return lines.join('\n');
}

// Only run as a CLI when executed directly (`npm run db:seed:carehub`) — NOT
// when `demo.seed.ts` imports `seedContentItem`/`EMERGENCY_GUIDANCE` from
// this module, which must not trigger a second `connectDatabase`/
// `process.exit`.
if (require.main === module) {
  seed()
    .then(async (summary) => {
      process.stdout.write(`${report(summary)}\n`);
      await disconnectDatabase();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`carehub.seed: failed — ${message}\n`);
      await disconnectDatabase();
      process.exit(1);
    });
}
