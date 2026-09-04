/**
 * ***************************************************************************
 * *** THE REPOSITORY'S FIRST END-TO-END TEST. ONE PATIENT, ONE CONSULTATION,
 * *** SIGN-IN TO A FINALISED CLINICAL RECORD, THROUGH THE REAL APPLICATION.
 * ***************************************************************************
 *
 * 3,538 tests prove each module works on its own. Not one of them proves the
 * modules work TOGETHER, and every one of the worst bugs found so far was an
 * integration bug that no module's own suite could see: every admin money
 * screen 500ing, the instant flow having no route to checkout, a doctor
 * offered a new request in the middle of a call. This file is where the chain
 * breaks if it is going to break.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM THE EIGHT `*.integration.spec.ts` FILES ──
 *
 * Those construct the services they test with `new`, wire a few real
 * repositories to a real database, and stub the rest. They are excellent at
 * what they do — proving a claim about rows in Postgres — and they all stop at
 * the module boundary.
 *
 * This one boots THE APPLICATION. `createConfiguredApp()` is the same function
 * `main.ts` calls, so this test runs through the same `rawBody` flag, the same
 * multipart registration, the same `setGlobalPrefix('api')`, the same
 * `ValidationPipe({ whitelist: true, transform: true })`, the same guards,
 * interceptors and exception filters, and the same webhook-safe JSON parser.
 * Requests go in through `app.inject()` — `light-my-request`, real HTTP
 * semantics, no port bound.
 *
 * *** CONFIGURING THE APP BY HAND HERE WOULD TEST A LOOKALIKE. *** It would
 * keep passing while production drifted, silently, which is the exact failure
 * mode `app.bootstrap.ts`'s own header was written to prevent.
 *
 * ── THE CHAIN, LINK BY LINK ────────────────────────────────────────────────
 *
 *   1. sign in     POST /api/auth/otp/request -> /api/auth/otp/verify, as the
 *                  patient AND as the doctor. Real routes, real challenge rows,
 *                  real JWTs. Only Slide itself is mocked.
 *   2. consent     GET /api/legal-documents/teleconsultation_consent, then
 *                  POST /api/consents with the VERSION ID it returns.
 *   3. slots       GET /api/doctors/:id/slots — and every slot it returns is
 *                  checked against `scheduling.min_notice_minutes`.
 *   4. booking     POST /api/bookings -> `pending_payment` + a gateway order.
 *   5. payment     POST /api/payments/webhook, HMAC-signed over the raw bytes.
 *                  A wrong signature and a wrong amount are BOTH proved to be
 *                  refused before the correct delivery is accepted.
 *   6. the seam    `payment.captured` moves the consultation
 *                  `pending_payment -> scheduled` IN-PROCESS — and, as this
 *                  test discovered, NOT synchronously with the webhook's own
 *                  response. See the capture test for what that costs.
 *   7. video       POST /api/video/consultations/:id/token — refused outside
 *                  the join window, then issued for BOTH parties, then
 *                  `participant_joined`/`participant_left`/`room_finished`
 *                  driven through `VideoWebhookService#handle`.
 *   8. clinical    PUT /api/consultations/:id/clinical-record then
 *                  POST .../finalise, as the DOCTOR.
 *   9. the proof   fresh SQL, not a service's return value: the consultation is
 *                  `completed`, the completion gate is cleared, the record
 *                  carries `finalised_at`, and `audit_log` has the trail.
 *  10. the payoff  `PromotionSweepService#sweepQualifications()` — machinery
 *                  that has NEVER RUN END TO END ANYWHERE — flips a real
 *                  `referral_events` row from `qualifying` to `qualified`.
 *
 * ── WHAT IT FOUND ON ITS FIRST RUN, AND WHAT IS FIXED NOW ──────────────────
 *
 * The chain completes. Four things it turned up on the way, each pinned by a
 * test below rather than left to be rediscovered:
 *
 *   1. *** FIXED. NO HTTP ROUTE CARRIED A DISCOUNT CODE INTO A BOOKING. ***
 *      `CreateBookingDto` had no field for one and `BookingPaymentPort` had no
 *      parameter for one, so `ValidationPipe({ whitelist: true })` STRIPPED a
 *      `discountCode` SILENTLY and answered 201. `CreateBookingDto
 *      #discountCode`, `BookingQuoteQueryDto#code`, both ports' widened
 *      signatures, and `payment.service.ts#createOrderForConsultation`'s
 *      forwarding into `materialiseAndPin` close this — see LINK 4c below,
 *      which redeems a real coupon through the actual HTTP routes rather than
 *      through `PromotionFacade` directly (LINK 4b still has to, for the
 *      referral leg — see its own comment for why that one case remains).
 *   2. *** FIXED. THE QUOTE A BOOKING CREATED HAD NO PATIENT, DOCTOR OR
 *      SPECIALTY. *** All three columns were NULL on every real booking, which
 *      would also have handed the promotion module `patientId: ''` the day (1)
 *      was fixed — the per-user cap would have counted against no one in
 *      particular. LINK 4c's `price_quotes` assertions prove all three are now
 *      populated on every booking, discounted or not.
 *   3. *** THE CAPTURE SEAM IS IN-PROCESS BUT NOT SYNCHRONOUS. *** The webhook
 *      answers 2xx before the booking has moved, so a client that navigates on
 *      payment success can still see `pending_payment`.
 *   4. *** A SCHEDULED CONSULTATION NEVER SETS THE COMPLETION GATE. ***
 *      `video.service.ts#endSession` sets it only for `mode === 'instant'`.
 *
 * And one thing that is NOT a bug but reads like one: the bill is 618.00, not
 * FR-7.3's 708.00, because the pricing engine treats the doctor's fee as
 * GST-exempt. Stated at the assertion.
 *
 * ── WHAT IS STUBBED, AND THEREFORE WHAT THIS DOES NOT PROVE ────────────────
 *
 *   - SLIDE (`@synquic/slide`) is `jest.mock`ed exactly as
 *     `identity-otp.service.spec.ts` does it, with `jest.requireActual` for the
 *     error classes so the service's `instanceof` mapping still works. There is
 *     no dev/test OTP path in this codebase and no way to read a code back —
 *     `otp_challenges` stores only a provider request id, because Slide
 *     verifies the code and we never receive it. So the whole `/api/auth/otp/*`
 *     HTTP surface is real and only the vendor call is fake. NOT PROVED: that
 *     Slide's real API behaves as the mock does.
 *   - RAZORPAY: `createOrder` ONLY. `getWebhookSecret()` is deliberately left
 *     REAL, so the signature this test computes is verified against the same
 *     secret the service reads. NOT PROVED: that Razorpay's real order
 *     creation and real webhook payloads match these shapes.
 *   - LIVEKIT: nothing is stubbed. `mintJoinToken` really mints (an
 *     `AccessToken` is signed locally — no socket), and the webhook is driven
 *     by handing `VideoWebhookService#handle` a `LivekitWebhookDelivery`
 *     directly, exactly as `video.webhook-idempotency.integration.spec.ts`
 *     does. NOT PROVED: signature verification of a real LiveKit delivery, and
 *     NO ROOM WAS EVER JOINED.
 *   - FCM: left unconfigured. All six `FCM_*` variables are optional; with none
 *     set nothing initialises, no network call happens, and the notification
 *     row is still written. That degradation is documented, not accidental.
 *   - `ClinicalPdfService.generateForConsultation` returns `null` — it needs
 *     S3/Cloudinary. Finalisation is explicitly allowed to succeed without a
 *     PDF, and `clinical.completion-gate.integration.spec.ts` stubs it the same
 *     way. NOT PROVED: that a prescription PDF is produced and stored.
 *
 * ── FIXTURE DISCIPLINE (copied from `patient-file.transaction.integration
 *    .spec.ts`, whose header says the shape is meant to be copied) ───────────
 *
 *   1. `loadEnvFiles()` FIRST — never `getEnv()`, which would `process.exit(1)`
 *      inside a Jest worker. Then the app boots (its `DatabaseModule` connects).
 *   2. ONE `seedFixtures`, returning every id it created.
 *   3. Per-run namespacing on EVERY unique column — specialty code and
 *      legal-document version by `runId`, and phone numbers by a separate
 *      all-DIGITS run namespace, because these numbers go through
 *      `@IsPhoneNumber('IN')` and the other specs' hex ones would not.
 *   4. ONE `teardown`, in strict reverse-FK order, nulling
 *      `doctors.blocked_by_consultation_id` before deleting consultations.
 *   5. Every assertion re-reads from Postgres with a fresh raw query. The code
 *      under test is never trusted to report on itself.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts do,
 * and fails loudly rather than skipping. A silently-skipped end-to-end test is
 * a green tick that means nothing at all.
 */
import { createHmac, randomUUID } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* SLIDE. Mocked before anything imports the application.                      */
/* -------------------------------------------------------------------------- */

/**
 * The vendor's OTP client, and only that. Every real `Slide*Error` class is
 * kept via `jest.requireActual` so `identity-otp.service.ts`'s `instanceof`
 * mapping still resolves — the same construction, and the same reason, as
 * `identity-otp.service.spec.ts`.
 *
 * `identifiersByRequestId` is what makes the mock honest rather than
 * permissive: `identity.service.ts#verifyOtp` re-checks that the number Slide
 * says it verified is the number the challenge was opened for, and a mock that
 * returned a fixed identifier would sail past a check that exists to catch a
 * swapped token.
 */
const identifiersByRequestId = new Map<string, string>();
const slideOtpMock = {
  // *** EVERY SLIDE CALL TAKES ONE OBJECT, NOT POSITIONAL ARGUMENTS. ***
  // `identity-otp.service.ts` calls `otp.send({ widgetId, identifier })`,
  // `otp.verify({ requestId, otp })` and `otp.verifyToken({ accessToken })`. A
  // positional mock silently receives `undefined` and the sign-in fails as a
  // 400 three calls later, which is a miserable thing to debug.
  send: jest.fn(async ({ identifier }: { widgetId: string; identifier: string }) => {
    const requestId = `otpreq_${randomUUID()}`;
    identifiersByRequestId.set(requestId, identifier);
    return { requestId };
  }),
  retry: jest.fn(async ({ requestId }: { requestId: string }) => ({ requestId })),
  verify: jest.fn(async ({ requestId }: { requestId: string; otp: string }) => ({
    accessToken: `slide_at_${requestId}`,
  })),
  verifyToken: jest.fn(async ({ accessToken }: { accessToken: string }) => {
    const requestId = accessToken.replace(/^slide_at_/, '');
    const identifier = identifiersByRequestId.get(requestId);
    if (identifier === undefined) throw new Error(`Test mock: no Slide request for token ${accessToken}.`);
    return { verified: true, identifier, verifiedAt: new Date().toISOString() };
  }),
};

jest.mock('@synquic/slide', () => {
  const actual = jest.requireActual('@synquic/slide');
  return { ...actual, SlideClient: jest.fn().mockImplementation(() => ({ otp: slideOtpMock })) };
});

/* Imported AFTER the mock, so the application's Slide client is the fake one. */
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from './app.bootstrap';
import { getDb, type Database } from './config/db/database.config';
import { loadEnvFiles } from './config/env/env.validation';
import { consultationsTable } from './schema/consultations.schema';
import { discountInstrumentsTable } from './schema/discount-instruments.schema';
import { doctorAvailabilityTable } from './schema/doctor-availability.schema';
import { doctorSpecialtiesTable } from './schema/doctor-specialties.schema';
import { doctorsTable } from './schema/doctors.schema';
import { legalDocumentsTable } from './schema/legal-documents.schema';
import { patientsTable } from './schema/patients.schema';
import { specialtiesTable } from './schema/specialties.schema';
import { ClinicalPdfService } from './modules/clinical/clinical-pdf.service';
import { DoctorFacade } from './modules/doctor/doctor.facade';
import { RazorpayClient } from './modules/payment/razorpay.client';
import { PromotionFacade } from './modules/promotion/promotion.facade';
import { PromotionSweepService } from './modules/promotion/promotion-sweep.service';
import type { LivekitWebhookDelivery } from './modules/video/livekit.client';
import { VideoWebhookService } from './modules/video/video-webhook.service';

jest.setTimeout(120_000);

/** `scheduling.min_notice_minutes`'s compiled-in default. A slot closer than this is refused. */
const MIN_NOTICE_MINUTES = 120;
/** `video.join_window_minutes`'s seeded value. A token is not minted earlier than this before the slot. */
const JOIN_WINDOW_MINUTES = 15;

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  patientMobile: string;
  /** A SECOND patient: the referrer whose code the first patient redeems. */
  referrerPatientId: string;
  doctorId: string;
  doctorMobile: string;
  /** Set only when this run had to publish one because nothing was current. */
  createdLegalDocumentId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum real row graph a consultation can be booked, paid, joined and
 * closed against.
 *
 * Every unique column is namespaced by `runId`, so a crashed run never collides
 * with the next one and nothing here can touch real data.
 *
 * *** THE THREE COLUMNS THE DOCTOR NEEDS, AND WHY EACH IS SET EXPLICITLY. ***
 *   - `verificationStatus: 'verified'` AND `isListed: true` — BOTH are required
 *     by `DoctorFacade#isVerifiedAndListed`, and `is_listed` DEFAULTS TO FALSE.
 *     Left at its default the slot list comes back empty and the booking is
 *     refused with `DOCTOR_NOT_BOOKABLE`.
 *   - `consultationFeeInr: '500.00'` — the column DEFAULTS TO '0', and a zero
 *     fee is refused with `PRICING_ZERO_VALUE_ORDER` because Razorpay will not
 *     create a zero-value order. 500.00 is also FR-7.3's worked example, so the
 *     bill this test pays is the one the SRS quotes: 708.00.
 *
 * *** AVAILABILITY IS IST WALL CLOCK. *** The slot engine reads these through
 * `availability-time.util.ts#utcToIstWallClock`. The window below is
 * deliberately the whole day on every weekday — not because a doctor works
 * around the clock, but because a narrower one would make this test pass or
 * fail depending on the time of day it is run, and a flaky end-to-end test is
 * worse than none. The hand-written CHECK for `weekly` requires `day_of_week`
 * NOT NULL, `specific_date` NULL, both times NOT NULL and `end_time >
 * start_time`; all four hold.
 */
async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);

  /**
   * *** THE PHONE NUMBERS MUST BE REAL INDIAN NUMBERS, NOT NAMESPACED HEX. ***
   *
   * The other real-database specs build `+9198${runId.slice(0,6)}${seq}` and get
   * away with it because they INSERT the row directly — `mobile_number` is a
   * `varchar(16)`, and hex letters go in fine. This test signs in over
   * `POST /api/auth/otp/request`, whose DTO carries `@IsPhoneNumber('IN')`, so a
   * number containing letters is a 400 before anything else happens.
   *
   * So the run's namespace is six random DIGITS: `+9179` + six + a two-digit
   * sequence is a valid ten-digit Indian mobile number, and two runs colliding
   * would need the same six digits in the same second.
   */
  const phoneRun = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  let phoneSeq = 10;
  const nextPhone = (): string => `+9179${phoneRun}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({
      code: `e2e_${runId}`,
      name: `E2E Specialty ${runId}`,
      // *** REQUIRED FOR THE COMPLETION GATE'S MEDICINE BRANCH. *** The gate
      // accepts a medicine line OR all four advice fields; a medicine line is
      // only permitted under a prescribing specialty.
      canPrescribe: true,
      isActive: true,
    })
    .returning({ id: specialtiesTable.id });

  const patientMobile = nextPhone();
  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: patientMobile, fullName: `E2E Patient ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [referrer] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), fullName: `E2E Referrer ${runId}`, status: 'active' })
    .returning({ id: patientsTable.id });

  const doctorMobile = nextPhone();
  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: doctorMobile,
      fullName: `E2E Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      bufferMinutes: 5,
      verifiedAt: new Date(),
    })
    .returning({ id: doctorsTable.id });

  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await db.insert(doctorAvailabilityTable).values({
      doctorId: doctor.id,
      ruleType: 'weekly',
      dayOfWeek,
      specificDate: null,
      startTime: '00:00:00',
      endTime: '23:59:00',
    });
  }

  /**
   * *** NOTHING IN THIS REPOSITORY SEEDS `legal_documents`. *** Without a
   * current `teleconsultation_consent` the consent step 404s and the video join
   * later refuses with `VIDEO_CONSENT_REQUIRED`.
   *
   * An existing current version — the demo seed's, or a real one published
   * through the admin panel — is REUSED and left alone. `legal_documents`
   * carries only a plain index on `(document_type, is_current)`, so publishing
   * a second current row would make which text a patient consents to depend on
   * the query planner.
   */
  const [existingCurrent] = await db
    .select({ id: legalDocumentsTable.id })
    .from(legalDocumentsTable)
    .where(
      sql`${legalDocumentsTable.documentType} = 'teleconsultation_consent' and ${legalDocumentsTable.isCurrent} = true`,
    )
    .limit(1);

  let createdLegalDocumentId: string | null = null;
  if (!existingCurrent) {
    const [created] = await db
      .insert(legalDocumentsTable)
      .values({
        documentType: 'teleconsultation_consent',
        version: `e2e-${runId}`,
        title: `E2E Teleconsultation Consent ${runId}`,
        body: 'Test consent text. Created by app.e2e.integration.spec.ts and deleted by its teardown.',
        isCurrent: true,
      })
      .returning({ id: legalDocumentsTable.id });
    createdLegalDocumentId = created.id;
  }

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    patientMobile,
    referrerPatientId: referrer.id,
    doctorId: doctor.id,
    doctorMobile,
    createdLegalDocumentId,
  };
}

/**
 * Strict reverse FK order. Children before parents, every time.
 *
 * Two orderings here are load-bearing and were found by watching Postgres
 * refuse them:
 *   - `doctors.blocked_by_consultation_id` is nulled BEFORE consultations are
 *     deleted — the FK runs from the doctor back to the consultation.
 *   - `discount_instruments.referral_event_id` is nulled before
 *     `referral_events` is deleted, for the same reason in the other direction:
 *     a minted referral REWARD points back at the event that earned it.
 *
 * *** ONE THING IS DELIBERATELY NOT CLEANED UP. *** Capturing a payment
 * allocates a statutory invoice serial from `pricing_document_sequences`. That
 * counter is a shared, monotonic sequence and a gap in it is its own compliance
 * question, so this test advances it by one and leaves it advanced rather than
 * rewinding a number that has been issued. Every payment capture on this
 * database does the same.
 */
/**
 * *** EVERY RESPONSE IN THIS APPLICATION IS ENVELOPED. ***
 *
 * `shared/errors/response.interceptor.ts` wraps every success as
 * `{ success: true, data }` and `shared/errors/http-exception.filter.ts` wraps
 * every failure as `{ success: false, error }`. Both are registered globally by
 * `ErrorsModule` via `APP_INTERCEPTOR`/`APP_FILTER`, so they are part of what
 * `createConfiguredApp()` builds and there is no way to opt out of them.
 *
 * A test that read `response.json().challengeId` would therefore get
 * `undefined` and fail three steps later with an unrelated 400 — which is
 * exactly what happened while writing this file. This unwraps both shapes.
 */
function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

/** A literal `array[...]::<type>[]`, correct when the list is empty. */
function pgArray(values: readonly string[], type: 'uuid' | 'varchar') {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`);
  return sql.raw(`array['${values.join("','")}']::${type}[]`);
}

/**
 * Every `x-razorpay-event-id` this run posts.
 *
 * *** A WEBHOOK EVENT IS NOT REACHABLE FROM THE FIXTURE GRAPH. *** A delivery
 * that fails the amount check, or one whose payment never resolved, lands in
 * `payment_events` with `payment_id` NULL — so a teardown that deletes events
 * "belonging to this run's payments" leaves them behind forever. They are
 * tracked here instead, and deleted by id.
 */
const postedWebhookEventIds: string[] = [];

/**
 * A coupon inserted directly for LINK 4c, exactly as every other fixture in
 * this file is created — the ADMIN side of minting a code is not what that
 * test exercises, only the PATIENT-facing redemption over HTTP is. It has
 * neither `referrer_patient_id` nor `referral_event_id`, so the generic
 * referral-shaped teardown clauses below do not catch it; tracked here and
 * deleted by id instead.
 */
const createdDiscountInstrumentIds: string[] = [];

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const patientIds = [fixtures.patientId, fixtures.referrerPatientId];

  // Consultations created by this run — always via the fixture patient, so a
  // failed run midway still cleans up whatever it managed to create.
  const patientList = pgArray(patientIds, 'uuid');
  const consultationRows = await db.execute(
    sql`select id from consultations where patient_id = any(${patientList})`,
  );
  const consultationIds = (consultationRows.rows as Array<{ id: string }>).map((row) => row.id);
  const consultationList = pgArray(consultationIds, 'uuid');

  // The completion gate points from the doctor BACK to the consultation.
  await db.execute(sql`update doctors set blocked_by_consultation_id = null where id = ${fixtures.doctorId}`);

  /**
   * *** A MINTED REFERRAL REWARD CANNOT BE ORPHANED, IT HAS TO BE DELETED. ***
   *
   * The obvious move — null `discount_instruments.referral_event_id` and then
   * delete the events — is REFUSED by
   * `discount_instruments_kind_ownership_check`: for `kind =
   * 'referral_reward'` the constraint requires `referral_event_id IS NOT NULL`.
   * So the reward rows go first, then the events, then the referral CODE rows.
   */
  await db.execute(sql`delete from affiliate_commissions where consultation_id = any(${consultationList})`);
  // The reward instruments, then the events that earned them — a
  // `referral_events` row is also the PARENT of a `discount_redemptions` row
  // (`referral_events.redemption_id`), so the redemptions cannot go first.
  await db.execute(
    sql`delete from discount_instruments where referral_event_id in (select id from referral_events where referrer_patient_id = any(${patientList}) or referee_patient_id = any(${patientList}))`,
  );
  await db.execute(
    sql`delete from referral_events where referrer_patient_id = any(${patientList}) or referee_patient_id = any(${patientList})`,
  );
  await db.execute(sql`delete from discount_redemptions where patient_id = any(${patientList})`);
  await db.execute(sql`delete from discount_instruments where referrer_patient_id = any(${patientList})`);
  // LINK 4c's coupon — no referrer, no referral event, so neither clause above catches it.
  await db.execute(
    sql`delete from discount_instruments where id = any(${pgArray(createdDiscountInstrumentIds, 'uuid')})`,
  );
  await db.execute(sql`delete from promotion_code_attempts where patient_id = any(${patientList})`);
  await db.execute(sql`delete from affiliate_attributions where patient_id = any(${patientList})`);

  await db.execute(sql`delete from consents where patient_id = any(${patientList})`);
  await db.execute(sql`delete from clinical_records where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from consultation_participants where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from report_requests where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from patient_files where patient_id = any(${patientList})`);

  const webhookEventList = pgArray(postedWebhookEventIds, 'varchar');
  await db.execute(
    sql`delete from payment_events where payment_id in (select id from payments where consultation_id = any(${consultationList})) or gateway_event_id = any(${webhookEventList})`,
  );
  await db.execute(
    sql`delete from refund_components where refund_id in (select id from refunds where payment_id in (select id from payments where consultation_id = any(${consultationList})))`,
  );
  await db.execute(
    sql`delete from refunds where payment_id in (select id from payments where consultation_id = any(${consultationList}))`,
  );
  await db.execute(sql`delete from payments where consultation_id = any(${consultationList})`);
  // NOTE the column: `price_quote_components.price_quote_id`, not `quote_id`.
  await db.execute(
    sql`delete from price_quote_components where price_quote_id in (select id from price_quotes where patient_id = any(${patientList}) or consultation_id = any(${consultationList}))`,
  );
  await db.execute(
    sql`delete from price_quotes where patient_id = any(${patientList}) or consultation_id = any(${consultationList})`,
  );

  await db.execute(sql`delete from notifications where consultation_id = any(${consultationList})`);
  // `outbox_events.aggregate_id` and `audit_log.entity_id` are VARCHAR, not
  // uuid — comparing them against a `uuid[]` errors, and casting the COLUMN to
  // uuid would blow up on any other module's non-uuid aggregate id. Compare as
  // text in both directions.
  await db.execute(sql`delete from outbox_events where aggregate_id = any(${pgArray(consultationIds, 'varchar')})`);
  await db.execute(sql`delete from audit_log where consultation_id = any(${consultationList})`);
  await db.execute(sql`delete from audit_log where actor_id = any(${patientList}) or actor_id = ${fixtures.doctorId}`);
  await db.execute(
    sql`delete from audit_log where entity_id = any(${pgArray([...patientIds, fixtures.doctorId, ...consultationIds, ...postedWebhookEventIds, ...createdDiscountInstrumentIds], 'varchar')})`,
  );

  await db.execute(sql`delete from consultations where id = any(${consultationList})`);

  await db.execute(sql`delete from otp_challenges where mobile_number in (${fixtures.patientMobile}, ${fixtures.doctorMobile})`);
  await db.execute(
    sql`delete from otp_request_attempts where mobile_number in (${fixtures.patientMobile}, ${fixtures.doctorMobile})`,
  );

  await db.delete(doctorAvailabilityTable).where(eq(doctorAvailabilityTable.doctorId, fixtures.doctorId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.execute(sql`delete from patients where id = any(${patientList})`);
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));

  if (fixtures.createdLegalDocumentId !== null) {
    await db.delete(legalDocumentsTable).where(eq(legalDocumentsTable.id, fixtures.createdLegalDocumentId));
  }
}

/* -------------------------------------------------------------------------- */

describe('*** END TO END: sign-in -> consent -> booking -> payment -> video -> clinical -> promotion sweep ***', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let fixtures: Fixtures;

  /** Everything the chain hands from one link to the next. Populated in order by the tests below. */
  const chain: {
    patientToken?: string;
    doctorToken?: string;
    legalDocumentId?: string;
    slotStartsAt?: string;
    consultationId?: string;
    gatewayOrderId?: string;
    totalPayable?: string;
    totalPayablePaise?: number;
    referralCode?: string;
    referralEventId?: string;
  } = {};

  beforeAll(async () => {
    // *** ORDER MATTERS. *** `loadEnvFiles()` before anything reads `getEnv()`,
    // which would `process.exit(1)` inside this Jest worker on a missing var.
    loadEnvFiles();

    // *** THE APPLICATION, BUILT EXACTLY AS `main.ts` BUILDS IT. ***
    app = await createConfiguredApp();
    db = getDb();

    /**
     * RAZORPAY: `createOrder` ONLY.
     *
     * `getWebhookSecret()` is left REAL on purpose. It reads the env
     * placeholder, and the signature this test computes must match the one the
     * service verifies against — stubbing it would make the most security
     * critical line in the codebase (a `@Public()` route where the HMAC is the
     * entire authentication) untested here.
     */
    jest
      .spyOn(app.get(RazorpayClient), 'createOrder')
      .mockImplementation(async (request) => ({
        id: `order_e2e_${randomUUID().slice(0, 12)}`,
        entity: 'order',
        amount: request.amount,
        amount_paid: 0,
        amount_due: request.amount,
        currency: request.currency,
        receipt: request.receipt ?? null,
        status: 'created',
        attempts: 0,
        created_at: Math.floor(Date.now() / 1000),
        notes: request.notes ?? {},
      }));

    /**
     * THE PRESCRIPTION PDF needs S3/Cloudinary. Finalisation is explicitly
     * allowed to succeed without one, and
     * `clinical.completion-gate.integration.spec.ts` stubs it identically.
     */
    jest.spyOn(app.get(ClinicalPdfService), 'generateForConsultation').mockResolvedValue(null);

    fixtures = await seedFixtures(db);
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      // Closing the app runs `DatabaseModule.onApplicationShutdown`, which
      // drains the pool — the same path production takes on SIGTERM.
      if (app) await app.close();
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  async function signIn(mobileNumber: string, audience: 'patient' | 'doctor'): Promise<string> {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { mobileNumber, audience },
    });
    expect(requested.statusCode).toBe(201);
    const { challengeId } = payload<{ challengeId: string }>(requested);

    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: { challengeId, code: '123456' },
    });
    expect(verified.statusCode).toBe(201);
    const body = payload<{ accessToken: string; account: { accountType: string } }>(verified);
    expect(body.account.accountType).toBe(audience);
    return body.accessToken;
  }

  /** A fresh raw read. Never the return value of the code under test. */
  async function readConsultation(): Promise<{ status: string; scheduled_start_at: string | null }> {
    const result = await db.execute(
      sql`select status, scheduled_start_at from consultations where id = ${chain.consultationId!}`,
    );
    return (result.rows as Array<{ status: string; scheduled_start_at: string | null }>)[0];
  }

  /**
   * Polls a raw read until it reports `expected`, or gives up.
   *
   * *** WHY A POLL AND NOT A STRAIGHT READ — READ THIS BEFORE "FIXING" IT. ***
   * See the capture test below: the `payment.captured` listener runs IN-PROCESS
   * but NOT synchronously with the webhook's HTTP response. A straight read
   * immediately after the 2xx is a genuine race, and one this test found.
   */
  async function waitForConsultationStatus(expected: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let status = (await readConsultation()).status;
    while (status !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await readConsultation()).status;
    }
    return status;
  }

  /* ====================================================================== */
  /* 0. The application really booted                                        */
  /* ====================================================================== */

  it('boots the real application: GET /api/health answers, and an unknown route 404s', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    // Proves `setGlobalPrefix('api')` and the router are the real ones — a
    // hand-built app that forgot the prefix would answer this instead.
    const unknown = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(unknown.statusCode).toBe(404);
  });

  /* ====================================================================== */
  /* 1. Sign-in                                                              */
  /* ====================================================================== */

  it('LINK 1 — signs the patient AND the doctor in over the real /api/auth/otp routes', async () => {
    chain.patientToken = await signIn(fixtures.patientMobile, 'patient');
    chain.doctorToken = await signIn(fixtures.doctorMobile, 'doctor');

    expect(typeof chain.patientToken).toBe('string');
    expect(typeof chain.doctorToken).toBe('string');

    // The challenge really was recorded and really was marked verified — the
    // token alone would not prove a row moved.
    const challenges = await db.execute(
      sql`select verified_at from otp_challenges where mobile_number = ${fixtures.patientMobile}`,
    );
    expect(challenges.rows.length).toBe(1);
    expect((challenges.rows as Array<{ verified_at: string | null }>)[0].verified_at).not.toBeNull();

    // And the token actually authenticates through the real guard stack.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(payload<{ id: string }>(me).id).toBe(fixtures.patientId);
  });

  it('refuses an unauthenticated call to the same route — the guard stack is real', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
  });

  /* ====================================================================== */
  /* 2. Consent                                                              */
  /* ====================================================================== */

  it('LINK 2 — reads the current teleconsultation consent and accepts it BY VERSION ID', async () => {
    const document = await app.inject({
      method: 'GET',
      url: '/api/legal-documents/teleconsultation_consent',
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    expect(document.statusCode).toBe(200);
    const { id, documentType } = payload<{ id: string; documentType: string }>(document);
    expect(documentType).toBe('teleconsultation_consent');
    chain.legalDocumentId = id;

    const recorded = await app.inject({
      method: 'POST',
      url: '/api/consents',
      headers: { authorization: `Bearer ${chain.patientToken}` },
      // *** A VERSION ID, NEVER A DOCUMENT TYPE. *** Resolving "the current
      // consent" server-side would record acceptance of a version published
      // while the screen was open, which nobody read.
      payload: { legalDocumentId: id },
    });
    expect(recorded.statusCode).toBe(201);

    const rows = await db.execute(
      sql`select document_type, legal_document_id from consents where patient_id = ${fixtures.patientId}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows as Array<{ legal_document_id: string }>)[0].legal_document_id).toBe(id);
  });

  /* ====================================================================== */
  /* 3. Slots                                                                */
  /* ====================================================================== */

  it('LINK 3 — lists bookable slots, and EVERY one respects scheduling.min_notice_minutes', async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);

    const response = await app.inject({
      method: 'GET',
      url: `/api/doctors/${fixtures.doctorId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    expect(response.statusCode).toBe(200);

    const slots = payload<Array<{ startsAt: string }>>(response);
    expect(slots.length).toBeGreaterThan(0);

    // *** THE SINGLE MOST COMMON CAUSE OF A FAILING FIRST BOOKING TEST. ***
    // `scheduling.min_notice_minutes` defaults to 120, so a slot less than two
    // hours out is refused. This asserts the engine has already excluded them,
    // which is why the booking below takes a slot from this list rather than
    // guessing one.
    const earliestAllowed = from.getTime() + MIN_NOTICE_MINUTES * 60_000;
    for (const slot of slots) {
      expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(earliestAllowed);
    }

    // Take one comfortably clear of the boundary, so the minutes this test
    // spends running cannot walk the slot back inside the notice window.
    const chosen = slots.find(
      (slot) => new Date(slot.startsAt).getTime() > from.getTime() + (MIN_NOTICE_MINUTES + 30) * 60_000,
    );
    expect(chosen).toBeDefined();
    chain.slotStartsAt = chosen!.startsAt;
  });

  /* ====================================================================== */
  /* 4. Booking                                                              */
  /* ====================================================================== */

  it('LINK 4 — books the slot: a pending_payment consultation with a gateway order attached', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: { authorization: `Bearer ${chain.patientToken}` },
      payload: {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: chain.slotStartsAt,
        // *** NO LONGER STRIPPED. *** `ANYTHING` is a well-formed code (passes
        // `CreateBookingDto#discountCode`'s shape check) that names no real
        // instrument, so the discount port refuses it as `CODE_NOT_USABLE` —
        // proved not to have applied below (`discount_code` stays null,
        // `total_payable` stays undiscounted). The refusal REASON specifically
        // does not survive onto THIS response — see the comment on
        // `discount` below for why that is a pre-existing, separate fact
        // about `pin()`, not something this round of fixes changed — but the
        // patient sees it where it actually matters: the PREVIEW, before ever
        // committing to a slot. See "an unknown code is refused loudly at
        // preview" below.
        discountCode: 'ANYTHING',
      },
    });
    expect(response.statusCode).toBe(201);

    const body = payload<{
      booking: { id: string; status: string; referenceCode: string };
      payment: {
        paymentId: string;
        gatewayOrderId: string;
        breakdown: {
          totalPayable: string;
          consultationFee: string;
          discount?: { applied: boolean; code: string; amount: string; cappedAmount: string; reason: string | null; message: string | null } | null;
        };
      };
      isFirstConsultation: boolean;
    }>(response);

    /**
     * *** `discount` IS `null` HERE, AND THAT IS A SEPARATE, PRE-EXISTING FACT
     * ABOUT `pin()` — NOT THIS ROUND'S BUG COMING BACK. ***
     *
     * `createOrderForConsultation` -> `materialiseAndPin` -> `pin()` re-reads
     * the FROZEN row and rebuilds the view with `toQuoteViewFromRows(pinned,
     * components)` — no `discount` argument — which falls back to
     * reconstructing it from `price_quotes.discount_code` alone
     * (`pricing.mapper.ts#toQuoteViewFromRows`). A REFUSED code writes no
     * columns (`writeQuote` only sets `discountCode` when
     * `resolved.discount?.applied`), so a booking-creation response cannot
     * tell "refused" apart from "no code offered" — both reconstruct as
     * `discount: null`. `preview()`/`createQuote()` themselves return the
     * live-computed view WITH the reason, which is exactly what
     * `quoteForDoctor` hands back untouched — see the preview test below.
     */
    expect(body.payment.breakdown.discount ?? null).toBeNull();

    expect(body.booking.status).toBe('pending_payment');
    expect(body.payment.gatewayOrderId).toMatch(/^order_/);
    expect(body.isFirstConsultation).toBe(true);
    expect(body.payment.breakdown.consultationFee).toBe('500.00');

    /**
     * *** 618.00, NOT FR-7.3's 708.00 — AND THAT IS CORRECT. ***
     *
     * FR-7.3's worked example charges GST on the whole subtotal (500 + 100,
     * then 18% = 108, total 708), which is what the legacy
     * `payment-money.util.ts#calculateBill` still computes for pre-engine rows.
     *
     * The PRICING ENGINE prices this differently and deliberately:
     * `pricing-gst.constants.ts` treats the DOCTOR'S FEE as `exempt` — "the
     * orthodox reading of Notification 12/2017 entry 74" — and taxes only the
     * platform's convenience fee. 500 exempt + 100 taxable + 18 GST = 618.00.
     *
     * This is recorded here so the number is not mistaken for a rounding bug,
     * and so that anyone reconciling the SRS against the implementation finds
     * the divergence stated rather than having to rediscover it.
     */
    expect(body.payment.breakdown.totalPayable).toBe('618.00');

    chain.consultationId = body.booking.id;
    chain.gatewayOrderId = body.payment.gatewayOrderId;
    chain.totalPayable = body.payment.breakdown.totalPayable;
    // *** THE AMOUNT THE WEBHOOK MUST CARRY. *** Taken from the pinned quote's
    // own total and converted, NEVER recomputed — a hand-rolled recomputation
    // is exactly how a capture ends up silently refused for an amount mismatch.
    chain.totalPayablePaise = Math.round(Number(body.payment.breakdown.totalPayable) * 100);

    const row = await readConsultation();
    expect(row.status).toBe('pending_payment');

    const payment = await db.execute(
      sql`select status, gateway_order_id, price_quote_id, paid_at from payments where consultation_id = ${chain.consultationId}`,
    );
    expect(payment.rows).toHaveLength(1);
    const paymentRow = (payment.rows as Array<{ status: string; gateway_order_id: string; price_quote_id: string | null; paid_at: string | null }>)[0];
    // `payments.status` starts at `pending`, not `created` — `created` is the
    // GATEWAY ORDER's status, and the two vocabularies are not the same one.
    expect(paymentRow.status).toBe('pending');
    expect(paymentRow.gateway_order_id).toBe(chain.gatewayOrderId);
    expect(paymentRow.paid_at).toBeNull();
    // No call site may produce an UNPRICED payment.
    expect(paymentRow.price_quote_id).not.toBeNull();
  });

  /**
   * *** THE FIX, PINNED. *** This used to be titled "FINDING" and asserted
   * the opposite of every line below: `discount_code` null (because the field
   * was stripped before it ever reached pricing), and `patient_id`/
   * `doctor_id`/`specialty_id` all null on EVERY booking, discounted or not.
   *
   * `ANYTHING` is a well-formed but unusable code, so `discount_code` staying
   * null here is the CORRECT outcome of a refusal, not a symptom of the field
   * never arriving — the previous `it` above already proved the refusal is
   * visible in the response. What changed is the second, sharper claim: the
   * quote's attribution columns are populated on THIS booking even though its
   * code did not apply, because `booking.service.ts#createBooking` now
   * forwards `patientId`/`doctorId`/`specialtyId` to `createOrderForConsultation`
   * unconditionally — not only when a discount happens to be offered. Without
   * that, `pricing.service.ts#tryReserveForPinned` would key its per-user cap
   * on `patientId: quote.patientId ?? ''`, an empty string shared by every
   * patient, the moment a code COULD reach a booking.
   */
  it('the quote a booking creates carries its patient, doctor and specialty — refused or not', async () => {
    const quote = await db.execute(
      sql`select discount_code, discount_total, total_payable, patient_id, doctor_id, specialty_id from price_quotes where consultation_id = ${chain.consultationId!}`,
    );
    expect(quote.rows).toHaveLength(1);
    const quoteRow = (
      quote.rows as Array<{
        discount_code: string | null;
        discount_total: string;
        total_payable: string;
        patient_id: string | null;
        doctor_id: string | null;
        specialty_id: string | null;
      }>
    )[0];

    // `ANYTHING` was refused (`CODE_NOT_USABLE`), so nothing was actually
    // applied — a refused code is never written to `discount_code`.
    expect(quoteRow.discount_code).toBeNull();
    expect(quoteRow.discount_total).toBe('0.00');
    expect(quoteRow.total_payable).toBe(chain.totalPayable);

    // *** THE FIX. *** Every real booking now carries its own attribution,
    // whether or not a discount code was offered or applied.
    expect(quoteRow.patient_id).toBe(fixtures.patientId);
    expect(quoteRow.doctor_id).toBe(fixtures.doctorId);
    expect(quoteRow.specialty_id).toBe(fixtures.specialtyId);
  });

  /* ====================================================================== */
  /* 4b. The referral, reserved through the real promotion machinery         */
  /* ====================================================================== */

  /**
   * *** THE ONE STEP THIS TEST CANNOT DRIVE OVER HTTP. ***
   *
   * A referral event is born when a pinned quote carrying a referral code is
   * reserved — `pricing.service.ts#tryReserveForPinned` calls
   * `DiscountPort#reserve`, which inserts the `discount_redemptions` row and,
   * for a `kind = 'referral'` instrument, the `referral_events` row in
   * `qualifying`.
   *
   * Because no HTTP route carries a code into a booking (see the finding
   * above), that call is made here directly, through the REAL `PromotionFacade`
   * resolved from the REAL application container, with the context built from
   * the REAL pinned quote's own rows — the same shape, from the same data,
   * that `tryReserveForPinned` would have passed. Every guard inside
   * `PromotionService#reserve` runs: the throttle, the resolution, the
   * first-consultation rule, the per-instrument row lock and all three caps.
   *
   * The referral CODE itself is minted through the real, patient-facing
   * `getOrCreateReferralCode`.
   */
  it('LINK 4b — the referrer mints a code, the referee redeems it, and a referral_events row is born `qualifying`', async () => {
    const promotions = app.get(PromotionFacade);

    const referral = await promotions.getOrCreateReferralCode(fixtures.referrerPatientId);
    expect(referral.code).toBeTruthy();
    chain.referralCode = referral.code;

    const quoteResult = await db.execute(
      sql`select id, gross_total, currency, doctor_id, specialty_id from price_quotes where consultation_id = ${chain.consultationId!}`,
    );
    const quote = (quoteResult.rows as Array<{ id: string; gross_total: string; currency: string; doctor_id: string | null; specialty_id: string | null }>)[0];

    const componentsResult = await db.execute(
      sql`select code, label, gross_amount from price_quote_components where price_quote_id = ${quote.id} order by position`,
    );
    const components = (componentsResult.rows as Array<{ code: string; label: string; gross_amount: string }>).map((row) => ({
      code: row.code,
      label: row.label,
      grossAmount: row.gross_amount,
    }));

    // `patientId` is the ONE field taken from the fixture rather than the
    // quote, and deliberately: the quote's own `patient_id` is NULL (see the
    // finding above), and `tryReserveForPinned` would have passed `''` here.
    // Passing the real patient is what lets this test exercise the referral
    // rules — the first-consultation check, the per-user cap and the
    // already-referred guard all key on it — rather than the bug.
    const reservation = await promotions.reserve({
      code: referral.code,
      consultationId: chain.consultationId!,
      holdExpiresAt: new Date(Date.now() + 20 * 60_000),
      context: {
        patientId: fixtures.patientId,
        doctorId: quote.doctor_id,
        specialtyId: quote.specialty_id,
        components,
        discountableAmount: quote.gross_total,
        currency: quote.currency,
        mode: 'scheduled',
      },
    });

    expect(reservation.reserved).toBe(true);

    // *** THE CLAIM, STRAIGHT FROM POSTGRES. ***
    const events = await db.execute(
      sql`select id, status, qualified_at from referral_events where consultation_id = ${chain.consultationId!}`,
    );
    expect(events.rows).toHaveLength(1);
    const event = (events.rows as Array<{ id: string; status: string; qualified_at: string | null }>)[0];
    expect(event.status).toBe('qualifying');
    expect(event.qualified_at).toBeNull();
    chain.referralEventId = event.id;
  });

  /* ====================================================================== */
  /* 4c. A coupon, reserved through the ACTUAL HTTP ROUTES                   */
  /* ====================================================================== */

  /**
   * *** THE FIX, PROVEN OVER HTTP — NOT THROUGH THE DI CONTAINER. ***
   *
   * LINK 4b's referral had to call `PromotionFacade` directly, because no
   * route could carry a code into a booking — that was the gap this whole
   * round closed. This coupon goes in through `POST /api/bookings` exactly as
   * a patient's app sends it, proving `CreateBookingDto#discountCode`,
   * `BookingQuoteQueryDto#code`, both ports' widened signatures and
   * `payment.service.ts#createOrderForConsultation`'s forwarding into
   * `materialiseAndPin` all actually work TOGETHER, not just in isolation
   * against a mock.
   *
   * The coupon INSTRUMENT itself is inserted directly, exactly as every other
   * fixture in this file is (the doctor, the specialty, the availability
   * rules) — creating one is an admin action this leg is not exercising, only
   * the patient-facing redemption needs to be real HTTP. `createdByAdminId`
   * stays null ("system-minted"), same as a referral reward.
   *
   * A FLAT 50.00 coupon against the FR-7.3 catalogue: the doctor's fee never
   * bears a discount (`pricing.constants.ts`'s `discountBearer: null` on
   * `doctor_fee` — FR-7.4's payout protection), so the whole 50.00 lands on
   * the 100.00 convenience fee, well under it, so nothing is capped. Taxable
   * value on that line drops from 100.00 to 50.00, so its GST drops from
   * 18.00 to 9.00 (both at 18%). 500.00 (untouched) + 50.00 (net convenience)
   * + 9.00 (its tax) = 559.00, against LINK 4's undiscounted 618.00.
   */
  const COUPON_CODE = `E2ECPN${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  let couponConsultationId: string;

  /**
   * *** POINT 7's PROOF: A BAD CODE IS REFUSED LOUDLY, NOT SILENTLY DROPPED
   * TO A FULL-PRICE QUOTE. *** Over the real `GET quote/:doctorId?code=`
   * route — no `PromotionFacade` shortcut. Unlike `POST /bookings` (see LINK
   * 4's comment on why `pin()`'s reconstruction loses a refusal reason),
   * `quoteForDoctor` -> `payments.quote()` -> `pricing.preview()` returns the
   * LIVE-COMPUTED view directly, reason and message intact — this is the
   * moment a patient actually sees "that code didn't work", before ever
   * committing to a slot.
   */
  it('an unknown code is refused loudly at preview, never silently collapsed to a full-price quote', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/quote/${fixtures.doctorId}?code=NOSUCHCODE99`,
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    expect(response.statusCode).toBe(200);

    const breakdown = payload<{
      totalPayable: string;
      discount?: { applied: boolean; code: string; amount: string; cappedAmount: string; reason: string | null; message: string | null } | null;
    }>(response);

    expect(breakdown.discount).toEqual({
      applied: false,
      code: 'NOSUCHCODE99',
      amount: '0.00',
      cappedAmount: '0.00',
      reason: 'CODE_NOT_USABLE',
      message: expect.any(String) as unknown as string,
    });
    // Undiscounted — the refusal did not silently take a cut anyway.
    expect(breakdown.totalPayable).toBe('618.00');
  });

  it('LINK 4c — GET quote/:doctorId?code= previews the coupon before booking, unreserved', async () => {
    const [instrument] = await db
      .insert(discountInstrumentsTable)
      .values({
        code: COUPON_CODE,
        kind: 'coupon',
        status: 'active',
        label: `E2E flat coupon ${fixtures.runId}`,
        isPubliclyListed: true,
        valueKind: 'flat',
        flatAmount: '50.00',
        minOrderAmount: '0',
        maxRedemptionsPerUser: 5,
      })
      .returning({ id: discountInstrumentsTable.id });
    createdDiscountInstrumentIds.push(instrument.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/quote/${fixtures.doctorId}?code=${COUPON_CODE}`,
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    expect(response.statusCode).toBe(200);

    const breakdown = payload<{
      totalPayable: string;
      discount?: { applied: boolean; code: string; amount: string } | null;
    }>(response);
    expect(breakdown.discount).toMatchObject({ applied: true, code: COUPON_CODE, amount: '50.00' });
    expect(breakdown.totalPayable).toBe('559.00');

    // *** A PREVIEW MUST NEVER RESERVE. *** Nothing is redeemed by looking.
    const redemptions = await db.execute(
      sql`select count(*)::int as n from discount_redemptions where instrument_id = ${instrument.id}`,
    );
    expect((redemptions.rows as Array<{ n: number }>)[0].n).toBe(0);
  });

  it('LINK 4c — POST /api/bookings with the coupon code actually reserves it, and the price_quotes row is discounted and attributed', async () => {
    // A fresh slot — LINK 4's own slot is already taken.
    const from = new Date();
    const to = new Date(from.getTime() + 4 * 24 * 60 * 60 * 1000);
    const slotsResponse = await app.inject({
      method: 'GET',
      url: `/api/doctors/${fixtures.doctorId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });
    const slots = payload<Array<{ startsAt: string }>>(slotsResponse);
    const chosen = slots.find(
      (slot) =>
        slot.startsAt !== chain.slotStartsAt &&
        new Date(slot.startsAt).getTime() > from.getTime() + (MIN_NOTICE_MINUTES + 30) * 60_000,
    );
    expect(chosen).toBeDefined();

    const response = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: { authorization: `Bearer ${chain.patientToken}` },
      payload: {
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        scheduledStartAt: chosen!.startsAt,
        discountCode: COUPON_CODE,
      },
    });
    expect(response.statusCode).toBe(201);

    const body = payload<{
      booking: { id: string };
      payment: { breakdown: { totalPayable: string; discount?: { applied: boolean; code: string; amount: string } | null } };
    }>(response);
    couponConsultationId = body.booking.id;

    expect(body.payment.breakdown.discount).toMatchObject({ applied: true, code: COUPON_CODE, amount: '50.00' });
    expect(body.payment.breakdown.totalPayable).toBe('559.00');

    // *** FRESH SQL, NOT THE SERVICE'S OWN RETURN VALUE. ***
    const quote = await db.execute(
      sql`select discount_code, discount_total, total_payable, patient_id, doctor_id, specialty_id from price_quotes where consultation_id = ${couponConsultationId}`,
    );
    expect(quote.rows).toHaveLength(1);
    const quoteRow = (
      quote.rows as Array<{
        discount_code: string | null;
        discount_total: string;
        total_payable: string;
        patient_id: string | null;
        doctor_id: string | null;
        specialty_id: string | null;
      }>
    )[0];
    expect(quoteRow.discount_code).toBe(COUPON_CODE);
    expect(quoteRow.discount_total).toBe('50.00');
    expect(quoteRow.total_payable).toBe('559.00');
    expect(quoteRow.patient_id).toBe(fixtures.patientId);
    expect(quoteRow.doctor_id).toBe(fixtures.doctorId);
    expect(quoteRow.specialty_id).toBe(fixtures.specialtyId);

    // *** RESERVED, NOT JUST PRICED. *** `DiscountPort#getForConsultation`,
    // through the REAL `PromotionFacade` — the same instrument the HTTP call
    // above reached, now genuinely holding a reservation against it.
    const promotions = app.get(PromotionFacade);
    const reservation = await promotions.getForConsultation(couponConsultationId);
    expect(reservation).not.toBeNull();
    expect(reservation?.code).toBe(COUPON_CODE);
    expect(reservation?.discountAmount).toBe('50.00');
  });

  /* ====================================================================== */
  /* 5. Payment                                                              */
  /* ====================================================================== */

  /** The exact bytes Razorpay would sign, and the HMAC over them. */
  function signedWebhook(body: unknown): { raw: string; signature: string } {
    const raw = JSON.stringify(body);
    // *** THE REAL SECRET, READ FROM THE REAL CLIENT. *** Not a literal — the
    // point is that this matches what `payment-webhook.service.ts` verifies
    // against.
    const secret = app.get(RazorpayClient).getWebhookSecret();
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  function captureBody(amountPaise: number): Record<string, unknown> {
    return {
      entity: 'event',
      account_id: 'acc_e2e',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_e2e_${randomUUID().slice(0, 12)}`,
            entity: 'payment',
            amount: amountPaise,
            currency: 'INR',
            status: 'captured',
            // *** THE LINK BACK TO OUR ROW. ***
            order_id: chain.gatewayOrderId,
            method: 'upi',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  async function postWebhook(raw: string, signature: string | undefined, eventId: string) {
    // Recorded so teardown can delete the `payment_events` row even when the
    // delivery never resolved to a payment — see `postedWebhookEventIds`.
    postedWebhookEventIds.push(eventId);
    return app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-razorpay-signature': signature }),
        'x-razorpay-event-id': eventId,
      },
      payload: raw,
    });
  }

  it('NEGATIVE CONTROL — a webhook with a bad signature is refused 401 and writes nothing', async () => {
    const { raw } = signedWebhook(captureBody(chain.totalPayablePaise!));
    const response = await postWebhook(raw, 'deadbeef'.repeat(8), `evt_bad_sig_${randomUUID()}`);

    expect(response.statusCode).toBe(401);
    expect(payload<{ code: string }>(response).code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');

    // The auth boundary really is before any write.
    const events = await db.execute(
      sql`select count(*)::int as n from payment_events where gateway_order_id = ${chain.gatewayOrderId!}`,
    );
    expect((events.rows as Array<{ n: number }>)[0].n).toBe(0);

    const row = await readConsultation();
    expect(row.status).toBe('pending_payment');
  });

  it('NEGATIVE CONTROL — a correctly signed capture for the WRONG AMOUNT does not mark the payment paid', async () => {
    // One rupee short. The amount check is where a hand-built delivery
    // silently fails, so it is proved to bite before the correct one is sent.
    const { raw, signature } = signedWebhook(captureBody(chain.totalPayablePaise! - 100));
    const response = await postWebhook(raw, signature, `evt_wrong_amount_${randomUUID()}`);

    // 2xx: the delivery is durable and Razorpay must not be told to retry.
    expect(response.statusCode).toBe(201);
    expect(payload<{ outcome: string }>(response).outcome).toBe('failed');

    const payment = await db.execute(
      sql`select status, paid_at from payments where consultation_id = ${chain.consultationId!}`,
    );
    expect((payment.rows as Array<{ status: string; paid_at: string | null }>)[0].paid_at).toBeNull();

    // The refusal is audited rather than silent.
    const audits = await db.execute(
      sql`select count(*)::int as n from audit_log where consultation_id = ${chain.consultationId!} and metadata->>'outcome' = 'amount_mismatch'`,
    );
    expect((audits.rows as Array<{ n: number }>)[0].n).toBeGreaterThanOrEqual(1);

    const row = await readConsultation();
    expect(row.status).toBe('pending_payment');
  });

  it('LINK 5+6 — a correctly signed capture marks the payment paid AND moves the consultation to `scheduled`', async () => {
    const eventId = `evt_capture_${randomUUID()}`;
    const { raw, signature } = signedWebhook(captureBody(chain.totalPayablePaise!));

    const response = await postWebhook(raw, signature, eventId);
    expect(response.statusCode).toBe(201);
    expect(payload<{ outcome: string; handled: boolean }>(response)).toMatchObject({ outcome: 'processed', handled: true });

    const payment = await db.execute(
      sql`select status, paid_at, gateway_payment_id, payment_method, invoice_number from payments where consultation_id = ${chain.consultationId!}`,
    );
    const paymentRow = (payment.rows as Array<{ status: string; paid_at: string | null; gateway_payment_id: string | null; payment_method: string | null; invoice_number: string | null }>)[0];
    expect(paymentRow.status).toBe('paid');
    expect(paymentRow.paid_at).not.toBeNull();
    expect(paymentRow.gateway_payment_id).toMatch(/^pay_e2e_/);
    expect(paymentRow.payment_method).toBe('upi');
    // The statutory invoice serial is taken AT CAPTURE, not at intent.
    expect(paymentRow.invoice_number).not.toBeNull();

    /**
     * *** THE SEAM — AND A FINDING ABOUT IT. ***
     *
     * `payment-webhook.service.ts` emits `PAYMENT_CAPTURED_EVENT` and
     * `booking-payment.listener.ts` moves the consultation `pending_payment ->
     * scheduled`. That listener really is IN-PROCESS — no queue, no worker —
     * and it only works at all because a real application is running, which is
     * why no mocked test can make this claim.
     *
     * *** IT IS NOT SYNCHRONOUS WITH THE HTTP RESPONSE, THOUGH. ***
     * `EventEmitter2#emit` invokes an async listener and does not await the
     * promise it returns, so the webhook has already answered 2xx while the
     * booking transition is still in flight. Read straight after the response,
     * the consultation is still `pending_payment` — this test hit that race on
     * its first run and it is reproducible.
     *
     * What that means in production: for a short window after Razorpay is told
     * "captured", `GET /api/bookings/:id` still says `pending_payment`. Not a
     * correctness bug (the money is durable and the sweep is the backstop), but
     * a real client-visible one — an app that navigates to the booking on
     * payment success can show a paid consultation as unpaid.
     */
    const status = await waitForConsultationStatus('scheduled');
    expect(status).toBe('scheduled');
  });

  it('a redelivery of the same event id is a no-op decided by the database', async () => {
    const eventId = `evt_replay_${randomUUID()}`;
    const { raw, signature } = signedWebhook(captureBody(chain.totalPayablePaise!));

    const first = await postWebhook(raw, signature, eventId);
    const second = await postWebhook(raw, signature, eventId);

    // The first is a fresh delivery for an ALREADY-captured payment, so it is
    // handled as a no-op; the second is refused by the unique constraint.
    expect(payload<{ outcome: string }>(first).outcome).toBe('processed');
    expect(payload<{ outcome: string }>(second).outcome).toBe('duplicate');

    const events = await db.execute(
      sql`select count(*)::int as n from payment_events where gateway_event_id = ${eventId}`,
    );
    expect((events.rows as Array<{ n: number }>)[0].n).toBe(1);
  });

  /* ====================================================================== */
  /* 7. Video                                                               */
  /* ====================================================================== */

  it('NEGATIVE CONTROL — a join token is refused before the join window opens', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/video/consultations/${chain.consultationId}/token`,
      headers: { authorization: `Bearer ${chain.patientToken}` },
    });

    expect(response.statusCode).toBe(409);
    expect(payload<{ code: string }>(response).code).toBe('VIDEO_JOIN_WINDOW_NOT_OPEN');
  });

  /**
   * *** THE CLOCK MOVED, NOT THE CODE. ***
   *
   * The two windows are deliberately incompatible for a test: a slot must be at
   * least `scheduling.min_notice_minutes` (120) away to be BOOKED, and a token
   * is only minted within `video.join_window_minutes` (15) of the slot. Rather
   * than fake timers around a real database, the APPOINTMENT is moved forward —
   * one UPDATE to a fixture column this test owns. Nothing about the gate, the
   * service or the route is changed.
   */
  it('LINK 7 — issues a join token to BOTH parties once the appointment is inside the window', async () => {
    const insideWindow = new Date(Date.now() + 5 * 60_000);
    await db.execute(
      sql`update consultations set scheduled_start_at = ${insideWindow.toISOString()} where id = ${chain.consultationId!}`,
    );

    for (const [party, token] of [
      ['patient', chain.patientToken!],
      ['doctor', chain.doctorToken!],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/video/consultations/${chain.consultationId}/token`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const ticket = payload<{ token: string; roomName: string; party: string; identity: string }>(response);
      expect(ticket.party).toBe(party);
      expect(ticket.roomName).toBe(`consult-${chain.consultationId}`);
      // Really a JWT, minted locally by the LiveKit SDK. No socket was opened.
      expect(ticket.token.split('.')).toHaveLength(3);
    }

    // The join really is audited — "who was let into which consultation, when".
    const audits = await db.execute(
      sql`select count(*)::int as n from audit_log where consultation_id = ${chain.consultationId!} and entity_type = 'video_join_token'`,
    );
    expect((audits.rows as Array<{ n: number }>)[0].n).toBe(2);

    expect(JOIN_WINDOW_MINUTES).toBe(15);
  });

  it('LINK 7 — both participants join, the consultation goes `in_progress`, and both leave', async () => {
    const webhooks = app.get(VideoWebhookService);

    const delivery = (
      event: 'participant_joined' | 'participant_left',
      party: 'patient' | 'doctor',
      sid: string,
      joinedAt: Date,
      disconnectReason: string | null = null,
    ): LivekitWebhookDelivery => ({
      event,
      id: randomUUID(),
      roomName: `consult-${chain.consultationId}`,
      participant: {
        sid,
        identity: `${party}:${party === 'patient' ? fixtures.patientId : fixtures.doctorId}`,
        joinedAt,
        disconnectReason,
      },
    });

    const joinedAt = new Date();
    const patientJoin = await webhooks.handle(delivery('participant_joined', 'patient', `PA_e2e_p_${fixtures.runId}`, joinedAt));
    const doctorJoin = await webhooks.handle(delivery('participant_joined', 'doctor', `PA_e2e_d_${fixtures.runId}`, joinedAt));

    expect(patientJoin.outcome).toBe('processed');
    expect(doctorJoin.outcome).toBe('processed');

    // *** THE CALL STARTED. *** Read back from Postgres.
    expect((await readConsultation()).status).toBe('in_progress');

    const participants = await db.execute(
      sql`select party, left_at from consultation_participants where consultation_id = ${chain.consultationId!} order by party`,
    );
    expect(participants.rows).toHaveLength(2);

    const leftAt = new Date();
    await webhooks.handle(delivery('participant_left', 'patient', `PA_e2e_p_${fixtures.runId}`, joinedAt, 'CLIENT_INITIATED'), leftAt);
    await webhooks.handle(delivery('participant_left', 'doctor', `PA_e2e_d_${fixtures.runId}`, joinedAt, 'CLIENT_INITIATED'), leftAt);

    const closed = await db.execute(
      sql`select count(*)::int as n from consultation_participants where consultation_id = ${chain.consultationId!} and left_at is not null`,
    );
    expect((closed.rows as Array<{ n: number }>)[0].n).toBe(2);

    // *** ONE PARTICIPANT LEAVING IS NOT THE END OF A CONSULTATION. ***
    // `room_finished` is. The status must still be `in_progress`.
    expect((await readConsultation()).status).toBe('in_progress');
  });

  it('LINK 7 — room_finished moves the consultation to `awaiting_documentation`', async () => {
    const webhooks = app.get(VideoWebhookService);

    const result = await webhooks.handle({
      event: 'room_finished',
      id: randomUUID(),
      roomName: `consult-${chain.consultationId}`,
      participant: null,
    } as LivekitWebhookDelivery);

    expect(result.outcome).toBe('processed');
    expect((await readConsultation()).status).toBe('awaiting_documentation');
  });

  /**
   * *** A FINDING, RECORDED AS A TEST. ***
   *
   * `video.service.ts#endSession` sets the doctor's FR-10.5 completion gate
   * ONLY when `booking.mode === 'instant'`. A SCHEDULED consultation that ends
   * therefore leaves `doctors.blocked_by_consultation_id` NULL — the doctor is
   * never held while their notes are outstanding, and nothing blocks them from
   * taking the next instant request with an unwritten record behind them.
   *
   * Whether that is intended is a product question, not one this test can
   * answer. What it can do is pin the behaviour, and then set the gate through
   * the REAL writer (`DoctorFacade#setCompletionGate` — the same method
   * `instant.markInstantConsultEnded` calls) so that the next test proves
   * finalisation genuinely clears it rather than passing vacuously.
   */
  it('FINDING — a SCHEDULED consultation never sets the completion gate; setting it via the real writer for the proof below', async () => {
    const before = await db.execute(
      sql`select blocked_by_consultation_id from doctors where id = ${fixtures.doctorId}`,
    );
    expect((before.rows as Array<{ blocked_by_consultation_id: string | null }>)[0].blocked_by_consultation_id).toBeNull();

    const gate = await app.get(DoctorFacade).setCompletionGate({
      doctorId: fixtures.doctorId,
      consultationId: chain.consultationId!,
      actor: { actorType: 'system', actorId: null },
    });
    expect(gate.changed).toBe(true);

    const after = await db.execute(
      sql`select blocked_by_consultation_id from doctors where id = ${fixtures.doctorId}`,
    );
    expect((after.rows as Array<{ blocked_by_consultation_id: string | null }>)[0].blocked_by_consultation_id).toBe(
      chain.consultationId,
    );
  });

  /* ====================================================================== */
  /* 8. Clinical                                                             */
  /* ====================================================================== */

  it('NEGATIVE CONTROL — the completion gate refuses a record with no case summary', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/consultations/${chain.consultationId}/clinical-record`,
      headers: { authorization: `Bearer ${chain.doctorToken}` },
      payload: { chiefComplaint: 'Low mood for three weeks.', riskCategory: 'low' },
    });
    expect(saved.statusCode).toBe(200);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/consultations/${chain.consultationId}/clinical-record/finalise`,
      headers: { authorization: `Bearer ${chain.doctorToken}` },
    });
    expect(refused.statusCode).toBe(409);
    expect(payload<{ code: string }>(refused).code).toBe('CLINICAL_CASE_SUMMARY_REQUIRED');

    const record = await db.execute(
      sql`select finalised_at from clinical_records where consultation_id = ${chain.consultationId!}`,
    );
    expect((record.rows as Array<{ finalised_at: string | null }>)[0].finalised_at).toBeNull();
    expect((await readConsultation()).status).toBe('awaiting_documentation');
  });

  it('LINK 8 — the doctor writes the record and finalises it', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/consultations/${chain.consultationId}/clinical-record`,
      headers: { authorization: `Bearer ${chain.doctorToken}` },
      payload: {
        chiefComplaint: 'Low mood for three weeks.',
        clinicalHistory: 'No prior psychiatric history. Sleep disturbed for a fortnight.',
        diagnosis: 'Mild depressive episode',
        isDiagnosisProvisional: true,
        riskCategory: 'low',
        // A medicine line satisfies the gate's second limb — permitted because
        // the booked specialty carries `can_prescribe = true`.
        medicines: [
          { name: 'Sertraline', dose: '25 mg', frequency: 'once daily', duration: '14 days', instructions: 'After food.' },
        ],
        caseSummary: 'Three weeks of low mood with disturbed sleep. Started on a low-dose SSRI. Review in two weeks.',
      },
    });
    expect(saved.statusCode).toBe(200);

    const finalised = await app.inject({
      method: 'POST',
      url: `/api/consultations/${chain.consultationId}/clinical-record/finalise`,
      headers: { authorization: `Bearer ${chain.doctorToken}` },
    });
    expect(finalised.statusCode).toBe(200);

    const body = payload<{ consultationStatus: string; completionGateCleared: boolean; prescriptionFileId: string | null }>(finalised);
    expect(body.consultationStatus).toBe('completed');
    expect(body.completionGateCleared).toBe(true);
    // Stubbed — see the header. Finalisation is explicitly allowed to succeed
    // without a PDF, and this proves it does.
    expect(body.prescriptionFileId).toBeNull();
  });

  /* ====================================================================== */
  /* 9. The proof, from Postgres and nowhere else                            */
  /* ====================================================================== */

  it('LINK 9 — fresh SQL confirms all four consequences actually landed', async () => {
    const consultation = await db.execute(
      sql`select status from consultations where id = ${chain.consultationId!}`,
    );
    expect((consultation.rows as Array<{ status: string }>)[0].status).toBe('completed');

    const doctor = await db.execute(
      sql`select blocked_by_consultation_id from doctors where id = ${fixtures.doctorId}`,
    );
    expect((doctor.rows as Array<{ blocked_by_consultation_id: string | null }>)[0].blocked_by_consultation_id).toBeNull();

    const record = await db.execute(
      sql`select finalised_at, case_summary, medicines from clinical_records where consultation_id = ${chain.consultationId!}`,
    );
    const recordRow = (record.rows as Array<{ finalised_at: string | null; case_summary: string | null; medicines: unknown }>)[0];
    expect(recordRow.finalised_at).not.toBeNull();
    expect(recordRow.case_summary).toContain('Three weeks of low mood');

    // The audit trail exists for this consultation and spans more than one
    // module — booking, payment, video and clinical all wrote to it.
    const audits = await db.execute(
      sql`select distinct entity_type from audit_log where consultation_id = ${chain.consultationId!}`,
    );
    const entityTypes = (audits.rows as Array<{ entity_type: string }>).map((row) => row.entity_type);
    expect(entityTypes.length).toBeGreaterThan(1);
    expect(entityTypes).toContain('clinical_record');
  });

  /* ====================================================================== */
  /* 10. The payoff: a sweep that has never run end to end anywhere           */
  /* ====================================================================== */

  /**
   * *** THE MACHINERY THAT SHIPPED INERT. ***
   *
   * `promotion.constants.ts` says of its own default qualifying set: "BOTH ARE
   * SET BY M-15. Until M-15 exists, NOTHING in this codebase moves a
   * consultation into either — so with the default set, no referral reward and
   * no affiliate accrual will EVER fire."
   *
   * M-15 now exists, and the consultation above reached `completed` through the
   * real chain. This is the first time anywhere that a real referral event, on
   * a real completed consultation, is put in front of the real sweep.
   */
  it('LINK 10 — sweepQualifications() flips the referral from `qualifying` to `qualified` and mints the reward', async () => {
    const sweep = app.get(PromotionSweepService);

    const before = await db.execute(
      sql`select status from referral_events where id = ${chain.referralEventId!}`,
    );
    expect((before.rows as Array<{ status: string }>)[0].status).toBe('qualifying');

    const result = await sweep.sweepQualifications();

    expect(result.referralsExamined).toBeGreaterThanOrEqual(1);
    expect(result.referralsQualified).toBeGreaterThanOrEqual(1);

    // *** THE CLAIM, STRAIGHT FROM POSTGRES. ***
    const after = await db.execute(
      sql`select status, qualified_at from referral_events where id = ${chain.referralEventId!}`,
    );
    const eventRow = (after.rows as Array<{ status: string; qualified_at: string | null }>)[0];
    expect(eventRow.status).toBe('qualified');
    expect(eventRow.qualified_at).not.toBeNull();

    // And the referrer's reward really was minted — the whole point of
    // qualifying, and a row that has never existed on this database before.
    const rewards = await db.execute(
      sql`select code, kind, status from discount_instruments where referral_event_id = ${chain.referralEventId!}`,
    );
    expect(rewards.rows.length).toBeGreaterThanOrEqual(1);
    expect((rewards.rows as Array<{ kind: string }>)[0].kind).toBe('referral_reward');
  });

  it('the sweep is idempotent — a second pass qualifies nothing again', async () => {
    const sweep = app.get(PromotionSweepService);
    const result = await sweep.sweepQualifications();

    const rows = await db.execute(
      sql`select count(*)::int as n from discount_instruments where referral_event_id = ${chain.referralEventId!}`,
    );
    expect((rows.rows as Array<{ n: number }>)[0].n).toBe(1);
    expect(result.failed).toBe(0);
  });
});
