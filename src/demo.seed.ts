/**
 * ***************************************************************************
 * *** THE DEMO SEED. NOT A PRODUCTION SEED. DO NOT WIRE IT INTO A DEPLOY. ***
 * ***************************************************************************
 *
 * Run it with:
 *
 *     npx ts-node -r tsconfig-paths/register src/demo.seed.ts
 *
 * or, once the coordinator adds the one line to `package.json`:
 *
 *     "db:seed:demo": "ts-node -r tsconfig-paths/register src/demo.seed.ts"
 *
 * (This track did NOT edit `package.json` — see `video.seed.ts`, which leaves
 * its own script line to the coordinator for exactly the same reason.)
 *
 * ── WHY THIS EXISTS, AND WHY IT IS SEPARATE ────────────────────────────────
 *
 * The ten existing seeds — `identity`, `catalogue`, `search`, `storage`,
 * `payment`, `notification`, `instant`, `pricing`, `promotion`, `video` — are
 * CONFIGURATION AND REFERENCE DATA: `app_config` rows, specialties, concerns,
 * storage providers, notification templates. Between them they create not one
 * row a consultation can actually be booked against. After running all ten,
 * `POST /api/bookings` has no bookable doctor to name, `GET /api/doctors/:id/
 * slots` returns `[]` for every doctor, and `POST /api/consents` 404s because
 * `legal_documents` is empty — which then makes `POST /api/video/
 * consultations/:id/token` refuse with `VIDEO_CONSENT_REQUIRED`.
 *
 * This script creates exactly those missing operational rows, and nothing
 * else. It is kept OUT of the module seeds on purpose: those are things a real
 * deployment wants, and a demo patient with a made-up phone number is not.
 *
 * ── THE FIVE THINGS NOTHING ELSE CREATES ───────────────────────────────────
 *
 *  1. A PATIENT, `status = 'active'` (the column defaults to `pending`, which
 *     is a half-finished sign-up, not a bookable account).
 *
 *  2. A DOCTOR THAT IS ACTUALLY BOOKABLE. Three columns, each of which
 *     silently breaks a different step if left at its default:
 *       - `verification_status = 'verified'` AND `is_listed = true`. BOTH are
 *         required by `DoctorFacade#isVerifiedAndListed`, which
 *         `booking.service.ts#validateBookingTargets` and
 *         `availability-slot.service.ts#listBookableSlots` both gate on — and
 *         *** `is_listed` DEFAULTS TO FALSE ***, so a hand-inserted "verified"
 *         doctor is invisible to search, returns an EMPTY slot list, and
 *         refuses the booking with `DOCTOR_NOT_BOOKABLE`.
 *       - `consultation_fee_inr > 0`. It *** DEFAULTS TO '0' ***, and a zero
 *         fee prices to a zero-value order, which
 *         `payment.service.ts#createOrderForConsultation` refuses outright
 *         with `PRICING_ZERO_VALUE_ORDER` because Razorpay will not create
 *         one.
 *
 *  3. THE `doctor_specialties` LINK. Without it the booking is refused with
 *     `DOCTOR_SPECIALTY_MISMATCH` (and the composite FK on `consultations`
 *     would refuse the insert anyway). The demo prefers a specialty with
 *     `can_prescribe = true`, because the clinical completion gate accepts
 *     EITHER a medicine line or all four `advice_*` fields — and a medicine
 *     line is only permitted under a prescribing specialty.
 *
 *  4. AT LEAST ONE WEEKLY `doctor_availability` RULE. With no rule the slot
 *     engine has nothing to expand and every day comes back empty.
 *
 *     *** THE TIMES ARE IST WALL CLOCK, NOT UTC. *** The engine reads them
 *     through `availability-time.util.ts#utcToIstWallClock`, so the
 *     `09:00`–`21:00` rule written below is 03:30–15:30 UTC. Writing UTC here
 *     would silently shift every slot by five and a half hours.
 *
 *     The hand-written CHECK constraints in
 *     `drizzle/0002_availability_and_scheduling.sql` require, for `weekly`:
 *     `day_of_week` NOT NULL, `specific_date` NULL, both times NOT NULL, and
 *     `end_time > start_time`. All four hold below.
 *
 *  5. A CURRENT `teleconsultation_consent` LEGAL DOCUMENT. `POST /api/consents`
 *     takes a legal document VERSION ID, never a document type, so a client
 *     must read `GET /api/legal-documents/teleconsultation_consent` first —
 *     and that 404s until a row here carries `is_current = true`.
 *
 * ── IDEMPOTENT AND RE-RUNNABLE ─────────────────────────────────────────────
 *
 * Every write is keyed on a natural key (the demo phone numbers, the demo
 * legal-document version, `(doctor, specialty)`, `(doctor, weekday)`) and is
 * either an `ON CONFLICT DO NOTHING` or a guarded insert. A re-run changes
 * nothing and reports what it found rather than what it wrote.
 *
 * It never touches a row it did not create, with ONE stated exception: it will
 * re-correct the DEMO doctor's three bookability columns if somebody has since
 * unlisted them. An existing current `teleconsultation_consent` published
 * through the admin panel is left exactly as it is and reused.
 */
import { and, eq } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from './config/db/database.config';
import { loadEnvFiles } from './config/env/env.validation';
import { doctorAvailabilityTable } from './schema/doctor-availability.schema';
import { doctorSpecialtiesTable } from './schema/doctor-specialties.schema';
import { doctorsTable } from './schema/doctors.schema';
import { legalDocumentsTable } from './schema/legal-documents.schema';
import { patientsTable } from './schema/patients.schema';
import { specialtiesTable } from './schema/specialties.schema';

/* -------------------------------------------------------------------------- */
/* The demo identities. Fixed, so a re-run finds them rather than duplicating   */
/* them, and so a human can sign in with a number they can remember.            */
/* -------------------------------------------------------------------------- */

const DEMO_PATIENT_MOBILE = '+919000000001';
const DEMO_DOCTOR_MOBILE = '+919000000002';
const DEMO_SPECIALTY_CODE = 'demo_psychiatry';
const DEMO_CONSENT_VERSION = 'demo-1.0';

/** IST WALL CLOCK. 09:00-21:00 IST is 03:30-15:30 UTC — see the header. */
const DEMO_AVAILABILITY_START_IST = '09:00:00';
const DEMO_AVAILABILITY_END_IST = '21:00:00';
/** 0 Sunday .. 6 Saturday. Every day, so a demo run on any afternoon finds a slot. */
const DEMO_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const DEMO_CONSENT_BODY = [
  'DEMO TELECONSULTATION CONSENT — NOT LEGAL TEXT.',
  '',
  'This document exists so the consent step of the booking flow can be',
  'exercised by hand. Replace it with the client-supplied copy before any',
  'real patient sees it: publish a new version through',
  'POST /api/admin/legal-documents, which demotes this one.',
].join('\n');

interface SeedSummary {
  patient: { id: string; mobileNumber: string; created: boolean };
  specialty: { id: string; code: string; canPrescribe: boolean; created: boolean };
  doctor: { id: string; mobileNumber: string; feeInr: string; created: boolean; corrected: string[] };
  doctorSpecialty: { created: boolean };
  availability: { weeklyRulesCreated: number; weeklyRulesAlreadyPresent: number };
  legalDocument: { id: string; version: string; created: boolean; reusedExistingCurrent: boolean };
}

/* -------------------------------------------------------------------------- */

async function seedPatient(db: Database): Promise<SeedSummary['patient']> {
  const [existing] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.mobileNumber, DEMO_PATIENT_MOBILE));
  if (existing) return { id: existing.id, mobileNumber: DEMO_PATIENT_MOBILE, created: false };

  const [row] = await db
    .insert(patientsTable)
    .values({ mobileNumber: DEMO_PATIENT_MOBILE, fullName: 'Demo Patient', status: 'active' })
    .returning({ id: patientsTable.id });
  return { id: row.id, mobileNumber: DEMO_PATIENT_MOBILE, created: true };
}

/**
 * Prefers a PRESCRIBING specialty that already exists (the catalogue seed's
 * `psychiatry`), because the clinical completion gate accepts a medicine line
 * only under one. Falls back to creating `demo_psychiatry`, so this script also
 * works on a database where the catalogue seed has never run.
 */
async function seedSpecialty(db: Database): Promise<SeedSummary['specialty']> {
  const [existingPrescribing] = await db
    .select({ id: specialtiesTable.id, code: specialtiesTable.code })
    .from(specialtiesTable)
    .where(and(eq(specialtiesTable.canPrescribe, true), eq(specialtiesTable.isActive, true)))
    .orderBy(specialtiesTable.code)
    .limit(1);
  if (existingPrescribing) {
    return { id: existingPrescribing.id, code: existingPrescribing.code, canPrescribe: true, created: false };
  }

  const [existingDemo] = await db
    .select({ id: specialtiesTable.id })
    .from(specialtiesTable)
    .where(eq(specialtiesTable.code, DEMO_SPECIALTY_CODE));
  if (existingDemo) return { id: existingDemo.id, code: DEMO_SPECIALTY_CODE, canPrescribe: true, created: false };

  const [row] = await db
    .insert(specialtiesTable)
    .values({ code: DEMO_SPECIALTY_CODE, name: 'Demo Psychiatry', canPrescribe: true, isActive: true })
    .returning({ id: specialtiesTable.id });
  return { id: row.id, code: DEMO_SPECIALTY_CODE, canPrescribe: true, created: true };
}

/**
 * *** THE THREE COLUMNS THAT DECIDE WHETHER A DOCTOR CAN BE BOOKED AT ALL. ***
 *
 * On a re-run this CORRECTS them if somebody has since unlisted the demo doctor
 * or zeroed the fee. That is the one place this script writes over an existing
 * row, and it only ever writes over the demo doctor it created itself.
 */
async function seedDoctor(db: Database): Promise<SeedSummary['doctor']> {
  const [existing] = await db
    .select({
      id: doctorsTable.id,
      verificationStatus: doctorsTable.verificationStatus,
      isListed: doctorsTable.isListed,
      consultationFeeInr: doctorsTable.consultationFeeInr,
    })
    .from(doctorsTable)
    .where(eq(doctorsTable.mobileNumber, DEMO_DOCTOR_MOBILE));

  if (existing) {
    const feeIsUsable = Number(existing.consultationFeeInr) > 0;
    const corrected: string[] = [];
    if (existing.verificationStatus !== 'verified') corrected.push('verification_status -> verified');
    if (!existing.isListed) corrected.push('is_listed -> true');
    if (!feeIsUsable) corrected.push('consultation_fee_inr -> 500.00');

    const feeInr = feeIsUsable ? existing.consultationFeeInr : '500.00';

    if (corrected.length > 0) {
      await db
        .update(doctorsTable)
        .set({ verificationStatus: 'verified', isListed: true, consultationFeeInr: feeInr, updatedAt: new Date() })
        .where(eq(doctorsTable.id, existing.id));
    }

    return { id: existing.id, mobileNumber: DEMO_DOCTOR_MOBILE, feeInr, created: false, corrected };
  }

  const [row] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: DEMO_DOCTOR_MOBILE,
      fullName: 'Dr Demo Sharma',
      qualification: 'MBBS, MD (Psychiatry)',
      yearsOfExperience: 12,
      languages: ['en', 'hi'],
      // *** ALL THREE, EXPLICITLY. *** See the header for what each default breaks.
      verificationStatus: 'verified',
      isListed: true,
      // FR-7.3's worked example is a 500.00 fee -> 708.00 payable, so the demo
      // reproduces the number the SRS itself quotes.
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      allowInstantConsult: true,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });

  return { id: row.id, mobileNumber: DEMO_DOCTOR_MOBILE, feeInr: '500.00', created: true, corrected: [] };
}

async function seedDoctorSpecialty(db: Database, doctorId: string, specialtyId: string): Promise<{ created: boolean }> {
  const inserted = await db
    .insert(doctorSpecialtiesTable)
    .values({ doctorId, specialtyId })
    .onConflictDoNothing()
    .returning({ doctorId: doctorSpecialtiesTable.doctorId });
  return { created: inserted.length > 0 };
}

/**
 * One `weekly` rule per weekday.
 *
 * `doctor_availability` carries no unique constraint to conflict on, so the
 * guard is an explicit read: inserting blind would stack a second identical
 * rule on every re-run, and `availability-rule.service.ts` treats overlapping
 * rules for the same doctor and day as an error.
 */
async function seedAvailability(db: Database, doctorId: string): Promise<SeedSummary['availability']> {
  let created = 0;
  let present = 0;

  for (const dayOfWeek of DEMO_WEEKDAYS) {
    const [existing] = await db
      .select({ id: doctorAvailabilityTable.id })
      .from(doctorAvailabilityTable)
      .where(
        and(
          eq(doctorAvailabilityTable.doctorId, doctorId),
          eq(doctorAvailabilityTable.ruleType, 'weekly'),
          eq(doctorAvailabilityTable.dayOfWeek, dayOfWeek),
        ),
      );
    if (existing) {
      present += 1;
      continue;
    }

    await db.insert(doctorAvailabilityTable).values({
      doctorId,
      ruleType: 'weekly',
      dayOfWeek,
      // The CHECK for `weekly` requires `specific_date` NULL and both times set.
      specificDate: null,
      startTime: DEMO_AVAILABILITY_START_IST,
      endTime: DEMO_AVAILABILITY_END_IST,
    });
    created += 1;
  }

  return { weeklyRulesCreated: created, weeklyRulesAlreadyPresent: present };
}

/**
 * A CURRENT `teleconsultation_consent`.
 *
 * If one is already current — a real one published through the admin panel —
 * it is left alone and reused. `legal_documents` carries only a PLAIN index on
 * `(document_type, is_current)`, so two current rows are physically possible
 * and the reader takes one of them; writing a second would make which text a
 * patient consents to depend on the query planner.
 */
async function seedLegalDocument(db: Database): Promise<SeedSummary['legalDocument']> {
  const [current] = await db
    .select({ id: legalDocumentsTable.id, version: legalDocumentsTable.version })
    .from(legalDocumentsTable)
    .where(and(eq(legalDocumentsTable.documentType, 'teleconsultation_consent'), eq(legalDocumentsTable.isCurrent, true)))
    .limit(1);

  if (current) return { id: current.id, version: current.version, created: false, reusedExistingCurrent: true };

  // A previous run's demo row may exist but have been demoted by a later
  // publish. Promote it back rather than minting a second version —
  // `(document_type, version)` is UNIQUE.
  const [demoted] = await db
    .select({ id: legalDocumentsTable.id })
    .from(legalDocumentsTable)
    .where(
      and(
        eq(legalDocumentsTable.documentType, 'teleconsultation_consent'),
        eq(legalDocumentsTable.version, DEMO_CONSENT_VERSION),
      ),
    );

  if (demoted) {
    await db.update(legalDocumentsTable).set({ isCurrent: true }).where(eq(legalDocumentsTable.id, demoted.id));
    return { id: demoted.id, version: DEMO_CONSENT_VERSION, created: false, reusedExistingCurrent: false };
  }

  const [row] = await db
    .insert(legalDocumentsTable)
    .values({
      documentType: 'teleconsultation_consent',
      version: DEMO_CONSENT_VERSION,
      title: 'Teleconsultation Consent (demo)',
      body: DEMO_CONSENT_BODY,
      isCurrent: true,
    })
    .returning({ id: legalDocumentsTable.id });

  return { id: row.id, version: DEMO_CONSENT_VERSION, created: true, reusedExistingCurrent: false };
}

/* -------------------------------------------------------------------------- */

async function seed(): Promise<SeedSummary> {
  // `loadEnvFiles()` FIRST, never `getEnv()` — the same ordering every seed and
  // every real-database spec in this repository uses.
  loadEnvFiles();
  const db = await connectDatabase();

  const patient = await seedPatient(db);
  const specialty = await seedSpecialty(db);
  const doctor = await seedDoctor(db);
  const doctorSpecialty = await seedDoctorSpecialty(db, doctor.id, specialty.id);
  const availability = await seedAvailability(db, doctor.id);
  const legalDocument = await seedLegalDocument(db);

  return { patient, specialty, doctor, doctorSpecialty, availability, legalDocument };
}

/** Says plainly what it created, what was already there, and what to do next. */
function report(summary: SeedSummary): string {
  return [
    'demo.seed: done. THIS IS DEMO DATA — do not run it against production.',
    '',
    `  patient          ${summary.patient.mobileNumber}  id=${summary.patient.id}  ${summary.patient.created ? 'CREATED' : 'already present'}`,
    `  doctor           ${summary.doctor.mobileNumber}  id=${summary.doctor.id}  fee=${summary.doctor.feeInr} INR  ${summary.doctor.created ? 'CREATED' : 'already present'}`,
    ...(summary.doctor.corrected.length > 0 ? [`                   corrected: ${summary.doctor.corrected.join(', ')}`] : []),
    '                   verification_status=verified AND is_listed=true — both are required to be bookable',
    `  specialty        ${summary.specialty.code}  id=${summary.specialty.id}  can_prescribe=${summary.specialty.canPrescribe}  ${summary.specialty.created ? 'CREATED' : 'already present'}`,
    `  doctor_specialty ${summary.doctorSpecialty.created ? 'CREATED' : 'already present'}`,
    `  availability     ${summary.availability.weeklyRulesCreated} weekly rule(s) created, ${summary.availability.weeklyRulesAlreadyPresent} already present`,
    `                   ${DEMO_AVAILABILITY_START_IST}-${DEMO_AVAILABILITY_END_IST} IST WALL CLOCK (= 03:30-15:30 UTC), every weekday`,
    `  legal document   teleconsultation_consent v${summary.legalDocument.version}  id=${summary.legalDocument.id}  ${
      summary.legalDocument.created
        ? 'CREATED'
        : summary.legalDocument.reusedExistingCurrent
          ? 'reused the existing CURRENT version'
          : 'existing demo version re-promoted to current'
    }`,
    '',
    '  Exercise it by hand:',
    `    1. POST /api/auth/otp/request  { "mobileNumber": "${summary.patient.mobileNumber}", "audience": "patient" }`,
    '       then POST /api/auth/otp/verify with the code Slide sent. There is NO test',
    '       OTP path and no way to read the code back — Slide verifies it, we never see it.',
    `    2. GET  /api/doctors/${summary.doctor.id}/slots?from=<now>&to=<now+3d>`,
    '       A slot inside scheduling.min_notice_minutes (default 120) is NOT returned.',
    `    3. POST /api/bookings  { "doctorId": "${summary.doctor.id}", "specialtyId": "${summary.specialty.id}", "scheduledStartAt": "<a slot>" }`,
    '    4. GET  /api/legal-documents/teleconsultation_consent  ->  POST /api/consents { "legalDocumentId": <that id> }',
    '    5. Pay: ONLY POST /api/payments/webhook can mark it paid — x-razorpay-signature is',
    '       HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET), and entity.amount must equal the',
    '       booking response\'s payment.breakdown.totalPayable in integer paise.',
    '    6. POST /api/video/consultations/<id>/token — opens video.join_window_minutes',
    '       (default 15) before the slot, and only once paid and consented.',
  ].join('\n');
}

seed()
  .then(async (summary) => {
    process.stdout.write(`${report(summary)}\n`);
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`demo.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
