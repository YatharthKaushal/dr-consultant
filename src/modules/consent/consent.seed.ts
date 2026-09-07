/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed:legal` (see package.json). Same shape as
 * `catalogue.seed.ts`: idempotent, re-runnable, insert-only.
 *
 * Publishes a PLACEHOLDER `privacy_policy` and `terms_of_use` version for
 * each app audience (`patient`, `doctor`) — four rows total — so
 * `GET /api/legal/:documentType?audience=` and the in-app legal section
 * have something real to read from the moment a deployment first boots,
 * rather than every environment starting with a 404. *** THIS IS NOT REAL
 * LEGAL COPY. *** It exists to unblock development, QA and a first store
 * submission's "does the link work" check — the client's actual privacy
 * policy and terms of use, reviewed by counsel, replace it through the
 * admin panel (`POST /admin/legal-documents`) before real users see it.
 *
 * Never touches the `'all'` audience cell for either document type: an
 * admin publishing one shared document for both apps is a decision this
 * seed does not make on their behalf. Never re-publishes over an existing
 * current version — the whole point of a placeholder is to be superseded,
 * not to fight a real admin edit on every re-run.
 */
import { and, eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import type { LegalAudience, LegalDocumentType } from '../../schema/enums.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';

interface PlaceholderDocument {
  documentType: LegalDocumentType;
  audience: LegalAudience;
  title: string;
  body: string;
}

const PLACEHOLDER_VERSION = 'placeholder-v1';

const PATIENT_PRIVACY_BODY = `# Privacy Policy (Patient App)

*** This is placeholder text seeded for development and QA. It is not the client's reviewed privacy policy. Replace it from the admin panel before real users see it. ***

## 1. What we collect

We collect the information you provide when you create an account, book a consultation, and use the app — your name, contact details, and information you share with your doctor during a consultation.

## 2. How we use it

Your information is used to provide the consultation service, process payment, and, where you consent, to send you notifications about your care.

## 3. Your rights

You can request a copy of your data or ask us to delete your account at any time. See the *Delete Account* page in the app.

## 4. Contact

Questions about this policy can be sent to [privacy@example.com](mailto:privacy@example.com).
`;

const DOCTOR_PRIVACY_BODY = `# Privacy Policy (Doctor App)

*** This is placeholder text seeded for development and QA. It is not the client's reviewed privacy policy. Replace it from the admin panel before real doctors see it. ***

## 1. What we collect

We collect the professional and account information you provide when your account is created by an administrator, and records of the consultations you conduct on the platform.

## 2. How we use it

Your information is used to verify your credentials, route consultations to you, and process your consultation fee.

## 3. Contact

Questions about this policy can be sent to [privacy@example.com](mailto:privacy@example.com).
`;

const PATIENT_TERMS_BODY = `# Terms of Use (Patient App)

*** This is placeholder text seeded for development and QA. It is not the client's reviewed terms of use. Replace it from the admin panel before real users see it. ***

## 1. The service

This app connects you with licensed doctors for teleconsultation. It is **not** for medical emergencies — if you are experiencing a medical emergency, contact your local emergency services immediately.

## 2. Your account

You are responsible for keeping your account details accurate and for the confidentiality of your sessions.

## 3. Payments

Consultation fees are shown before you confirm a booking. Refunds are handled under our separate refund policy.
`;

const DOCTOR_TERMS_BODY = `# Terms of Use (Doctor App)

*** This is placeholder text seeded for development and QA. It is not the client's reviewed terms of use. Replace it from the admin panel before real doctors see it. ***

## 1. Conduct

You agree to provide consultations in line with your professional and regulatory obligations.

## 2. Fees

Your consultation fee share is set on your profile and shown to you before you accept an instant consult.
`;

const PLACEHOLDER_DOCUMENTS: readonly PlaceholderDocument[] = [
  { documentType: 'privacy_policy', audience: 'patient', title: 'Privacy Policy', body: PATIENT_PRIVACY_BODY },
  { documentType: 'privacy_policy', audience: 'doctor', title: 'Privacy Policy', body: DOCTOR_PRIVACY_BODY },
  { documentType: 'terms_of_use', audience: 'patient', title: 'Terms of Use', body: PATIENT_TERMS_BODY },
  { documentType: 'terms_of_use', audience: 'doctor', title: 'Terms of Use', body: DOCTOR_TERMS_BODY },
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
    for (const doc of PLACEHOLDER_DOCUMENTS) {
      const label = `${doc.documentType}/${doc.audience}`;

      const [existingCurrent] = await tx
        .select({ id: legalDocumentsTable.id })
        .from(legalDocumentsTable)
        .where(
          and(
            eq(legalDocumentsTable.documentType, doc.documentType),
            eq(legalDocumentsTable.audience, doc.audience),
            eq(legalDocumentsTable.isCurrent, true),
          ),
        )
        .limit(1);

      if (existingCurrent) {
        summary.alreadyPresent.push(label);
        continue;
      }

      const [row] = await tx
        .insert(legalDocumentsTable)
        .values({
          documentType: doc.documentType,
          audience: doc.audience,
          version: PLACEHOLDER_VERSION,
          title: doc.title,
          body: doc.body,
          contentFormat: 'markdown',
          isCurrent: true,
        })
        .onConflictDoNothing({ target: [legalDocumentsTable.documentType, legalDocumentsTable.audience, legalDocumentsTable.version] })
        .returning({ id: legalDocumentsTable.id });

      if (row) {
        summary.inserted.push(label);
        await tx.insert(auditLogTable).values({
          actorType: 'system',
          actorId: null,
          action: 'create',
          entityType: 'legal_document',
          entityId: row.id,
          metadata: { documentType: doc.documentType, audience: doc.audience, version: PLACEHOLDER_VERSION, source: 'consent.seed' },
        });
      } else {
        // Lost a race with a concurrent seed run, or the exact placeholder
        // version already exists but was demoted — either way, not ours to
        // re-publish over.
        summary.alreadyPresent.push(label);
      }
    }
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`consent.seed: done — ${JSON.stringify(summary)}\n`);
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`consent.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
