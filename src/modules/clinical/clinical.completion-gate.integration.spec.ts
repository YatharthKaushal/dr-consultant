/**
 * *** REAL-DATABASE TEST. THE ONE THAT PROVES THE POINT OF THIS MODULE. ***
 *
 * Follows `document/patient-file.transaction.integration.spec.ts`, which
 * `booking/booking.slot-race.integration.spec.ts` and
 * `instant/instant.routing-race.integration.spec.ts` also follow — one fixture
 * helper, strict reverse-FK teardown, per-run UUID namespacing, and a positive
 * control on every claim.
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * `clinical.service.spec.ts` asserts that `finalise` CALLS
 * `InstantFacade.clearCompletionGate`. That is a claim about a `jest.fn()`. It
 * would pass identically against a `clearCompletionGate` that does nothing at
 * all — and until this module existed, that method had never had a single
 * caller in production or in a test, so "it is called" and "it works when
 * called" had never once been true at the same time.
 *
 * The claims below are claims about ROWS IN POSTGRES:
 *
 *   1. Finalising really does set `doctors.blocked_by_consultation_id` to NULL
 *      — the FR-10.5 gate a doctor is actually held by.
 *   2. Finalising really does move `consultations.status` to `completed`.
 *   3. *** THAT STATUS IS ONE THE PROMOTION SWEEP COUNTS AS QUALIFYING. ***
 *      `promotion.constants.ts` says of its own default: "BOTH ARE SET BY
 *      M-15. Until M-15 exists, NOTHING in this codebase moves a consultation
 *      into either — so with the default set, no referral reward and no
 *      affiliate accrual will EVER fire." This test reads the status back
 *      through `PromotionConsultationLookupProvider` — the REAL port that
 *      sweep reads through — and evaluates the REAL qualifying predicate
 *      against it.
 *   4. A refused gate really does leave the record, the gate and the
 *      consultation all untouched.
 *   5. The reconciling sweep really does repair a gate left behind by a crash.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 *
 * Real: the database, `ClinicalRepository`, `ClinicalTemplateService`,
 * `AuditService`, `ConsultationCompletionProvider` (the actual guarded UPDATE),
 * `BookingRepository` + `toBookingView` for the consultation read,
 * `SpecialtyService` for the prescribing gate, `DoctorPresenceService` for the
 * completion gate, `PromotionConsultationLookupProvider` for the status read.
 *
 * Stubbed, and each for a stated reason:
 *   - `InstantFacade` is represented by a two-method object delegating to the
 *     REAL `DoctorPresenceService`. `InstantService.clearCompletionGate` is
 *     exactly `DoctorFacade.clearCompletionGate` plus a best-effort presence
 *     transition that cannot affect the gate; constructing the whole of M-13
 *     (nine constructor dependencies including a payment gateway) to reach one
 *     idempotent UPDATE would test M-13, which M-13 already tests.
 *   - `ClinicalPdfService` returns `null`. Storing a PDF needs S3/Cloudinary
 *     credentials this suite has no business requiring, and the PDF is proved
 *     end to end in `clinical-pdf.renderer.spec.ts` and
 *     `clinical-pdf.service.spec.ts`.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts do,
 * and fails loudly rather than skipping: a silently-skipped proof is worse than
 * no proof.
 */
import { randomUUID } from 'node:crypto';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  connectDatabase,
  disconnectDatabase,
  type Database,
} from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { auditLogTable } from '../../schema/audit-log.schema';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorClinicalTemplatesTable } from '../../schema/doctor-clinical-templates.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { BookingRepository } from '../booking/booking.repository';
import { toBookingView } from '../booking/booking.mapper';
import { SpecialtyRepository } from '../catalogue/specialty.repository';
import { SpecialtyService } from '../catalogue/specialty.service';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import { DoctorPresenceService } from '../doctor/doctor-presence.service';
import { DoctorRepository } from '../doctor/doctor.repository';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { InstantFacade } from '../instant/instant.facade';
import { PromotionConsultationLookupProvider } from '../promotion/consultation-lookup.provider';
import { PROMOTION_DEFAULT_QUALIFYING_STATUSES } from '../promotion/promotion.constants';
import type { ClinicalBookingPort } from './clinical-booking.contract';
import { ClinicalGateSweepService } from './clinical-gate-sweep.service';
import { CLINICAL_ERROR_CODES, CLINICAL_GATE_SWEEP_MAX_BATCHES } from './clinical.constants';
import type { ClinicalPdfService } from './clinical-pdf.service';
import { ClinicalRepository } from './clinical.repository';
import { ClinicalService } from './clinical.service';
import { ClinicalTemplateRepository } from './clinical-template.repository';
import { ClinicalTemplateService } from './clinical-template.service';
import { BookingService } from '../booking/booking.service';

jest.setTimeout(30_000);

const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null };

interface Fixtures {
  runId: string;
  prescribingSpecialtyId: string;
  nonPrescribingSpecialtyId: string;
  patientId: string;
  /** Gated by `consultationId` — the FR-10.5 state a doctor sits in while their notes are outstanding. */
  doctorId: string;
  /** Gated by `otherConsultationId`, and must stay that way. */
  otherDoctorId: string;
  consultationId: string;
  otherConsultationId: string;
  /** A consultation under the NON-prescribing specialty, for the medicine gate. */
  nonPrescribingConsultationId: string;
  /** Untouched by every other test — the concurrency section needs a consultation with NO record on it. */
  raceConsultationId: string;
  /** A second one, so the forced interleaving also starts from no record at all. */
  forcedRaceConsultationId: string;
  /** Its OWN prescribing specialty, so flipping `can_prescribe` cannot disturb any other test. */
  flipSpecialtyId: string;
  flipConsultationId: string;
  /** For the concurrent draft-save-vs-finalise race. */
  draftRaceConsultationId: string;
  /** For two simultaneous finalises. */
  finaliseRaceConsultationId: string;
  /** A third doctor, gated by `pagingStrandedConsultationId`, for the sweep-paging test only. */
  pagingDoctorId: string;
  pagingDecoyConsultationId: string;
  pagingStrandedConsultationId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9198${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [prescribing] = await db
    .insert(specialtiesTable)
    .values({ code: `clin_rx_${runId}`, name: `Clinical Psychiatry ${runId}`, canPrescribe: true })
    .returning({ id: specialtiesTable.id });
  const [flip] = await db
    .insert(specialtiesTable)
    .values({ code: `clin_flip_${runId}`, name: `Clinical Flip ${runId}`, canPrescribe: true })
    .returning({ id: specialtiesTable.id });
  const [nonPrescribing] = await db
    .insert(specialtiesTable)
    .values({
      code: `clin_norx_${runId}`,
      name: `Clinical Counselling ${runId}`,
      canPrescribe: false,
    })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });

  async function makeDoctor(label: string): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `${label} ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
        presence: 'completing_notes',
        allowInstantConsult: true,
      })
      .returning({ id: doctorsTable.id });
    await db
      .insert(doctorSpecialtiesTable)
      .values({ doctorId: row.id, specialtyId: prescribing.id, isPrimary: true });
    await db
      .insert(doctorSpecialtiesTable)
      .values({ doctorId: row.id, specialtyId: nonPrescribing.id });
    await db.insert(doctorSpecialtiesTable).values({ doctorId: row.id, specialtyId: flip.id });
    return row.id;
  }

  const doctorId = await makeDoctor('Gated Doctor');
  const otherDoctorId = await makeDoctor('Other Gated Doctor');
  const pagingDoctorId = await makeDoctor('Paging Doctor');

  let referenceSeq = 100;
  async function makeConsultation(specialtyId: string, assignedDoctorId: string): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `CLIN-${runId}-${referenceSeq++}`,
        patientId: patient.id,
        doctorId: assignedDoctorId,
        specialtyId,
        mode: 'instant',
        status: 'in_progress',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }

  const consultationId = await makeConsultation(prescribing.id, doctorId);
  const otherConsultationId = await makeConsultation(prescribing.id, otherDoctorId);
  const nonPrescribingConsultationId = await makeConsultation(nonPrescribing.id, doctorId);
  const raceConsultationId = await makeConsultation(prescribing.id, doctorId);
  const forcedRaceConsultationId = await makeConsultation(prescribing.id, doctorId);
  const flipConsultationId = await makeConsultation(flip.id, doctorId);
  const draftRaceConsultationId = await makeConsultation(prescribing.id, doctorId);
  const finaliseRaceConsultationId = await makeConsultation(prescribing.id, doctorId);
  const pagingDecoyConsultationId = await makeConsultation(prescribing.id, pagingDoctorId);
  const pagingStrandedConsultationId = await makeConsultation(prescribing.id, pagingDoctorId);

  // *** THE COMPLETION GATE, SET. *** This is the state FR-10.5 leaves a doctor
  // in when a consult ends and the notes are still owed.
  await db
    .update(doctorsTable)
    .set({ blockedByConsultationId: consultationId })
    .where(eq(doctorsTable.id, doctorId));
  await db
    .update(doctorsTable)
    .set({ blockedByConsultationId: otherConsultationId })
    .where(eq(doctorsTable.id, otherDoctorId));
  await db
    .update(doctorsTable)
    .set({ blockedByConsultationId: pagingStrandedConsultationId })
    .where(eq(doctorsTable.id, pagingDoctorId));

  return {
    runId,
    prescribingSpecialtyId: prescribing.id,
    nonPrescribingSpecialtyId: nonPrescribing.id,
    patientId: patient.id,
    doctorId,
    otherDoctorId,
    consultationId,
    otherConsultationId,
    nonPrescribingConsultationId,
    raceConsultationId,
    forcedRaceConsultationId,
    flipSpecialtyId: flip.id,
    flipConsultationId,
    draftRaceConsultationId,
    finaliseRaceConsultationId,
    pagingDoctorId,
    pagingDecoyConsultationId,
    pagingStrandedConsultationId,
  };
}

/** Strict reverse-FK order. `doctors.blocked_by_consultation_id` references `consultations`, so it is cleared BEFORE the consultations go. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const consultationIds = [
    fixtures.consultationId,
    fixtures.otherConsultationId,
    fixtures.nonPrescribingConsultationId,
    fixtures.raceConsultationId,
    fixtures.forcedRaceConsultationId,
    fixtures.flipConsultationId,
    fixtures.draftRaceConsultationId,
    fixtures.finaliseRaceConsultationId,
    fixtures.pagingDecoyConsultationId,
    fixtures.pagingStrandedConsultationId,
  ];
  const doctorIds = [fixtures.doctorId, fixtures.otherDoctorId, fixtures.pagingDoctorId];

  await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
  await db
    .delete(clinicalRecordsTable)
    .where(inArray(clinicalRecordsTable.consultationId, consultationIds));
  await db
    .delete(doctorClinicalTemplatesTable)
    .where(inArray(doctorClinicalTemplatesTable.doctorId, doctorIds));
  await db
    .update(doctorsTable)
    .set({ blockedByConsultationId: null })
    .where(inArray(doctorsTable.id, doctorIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db
    .delete(doctorSpecialtiesTable)
    .where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db
    .delete(specialtiesTable)
    .where(
      inArray(specialtiesTable.id, [
        fixtures.prescribingSpecialtyId,
        fixtures.nonPrescribingSpecialtyId,
        fixtures.flipSpecialtyId,
      ]),
    );
}

describe('M-15 finalisation, against a real database', () => {
  let db: Database;
  let fixtures: Fixtures;

  let clinical: ClinicalService;
  let clinicalRepo: ClinicalRepository;
  let sweep: ClinicalGateSweepService;
  let presence: DoctorPresenceService;
  let instant: InstantFacade;
  let promotionLookup: PromotionConsultationLookupProvider;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    const audit = new AuditService(db);
    clinicalRepo = new ClinicalRepository(db);
    const bookingRepo = new BookingRepository(db);
    const doctorRepo = new DoctorRepository(db);
    presence = new DoctorPresenceService(db, doctorRepo, audit);

    // *** BOTH HALVES ARE NOW M-11'S REAL CODE. *** The READ is its real
    // repository plus its real mapper — the same two calls
    // `BookingFacade.getBooking` makes. The WRITE is `BookingService
    // #completeConsultation` ITSELF, the production method, not a placeholder:
    // the coordinator rebound `CLINICAL_BOOKING_PORT` to `BookingFacade` at
    // merge and deleted the provider that used to write `consultations` from
    // inside this module.
    //
    // `BookingService` takes ten collaborators and `completeConsultation`
    // touches exactly three — `db`, `repo` and `audit`. The other seven are
    // `null as never` DELIBERATELY: if that method ever grows a fourth
    // dependency, this test throws instead of quietly passing against a stub.
    const bookingService = new BookingService(
      db,
      bookingRepo,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      audit,
    );
    const bookings: ClinicalBookingPort = {
      getBooking: async (consultationId: string) => {
        const row = await bookingRepo.findById(consultationId);
        return row ? toBookingView(row) : null;
      },
      completeConsultation: (input) => bookingService.completeConsultation(input),
    };

    // The two `InstantFacade` methods this module uses, delegating to the REAL
    // `DoctorPresenceService`. See this file's header for why M-13 is not
    // constructed whole.
    instant = {
      clearCompletionGate: (consultationId: string) =>
        presence.clearCompletionGate({ consultationId, actor: SYSTEM_ACTOR }),
      getPresence: async (doctorId: string) => {
        const state = await presence.getPresenceState(doctorId);
        return state
          ? {
              doctorId: state.doctorId,
              presence: state.presence,
              allowInstantConsult: state.allowInstantConsult,
              blockedByConsultationId: state.blockedByConsultationId,
              routable: false,
            }
          : null;
      },
    } as unknown as InstantFacade;

    // `CatalogueFacade.getSpecialtyById` is one line — `specialtyService
    // .getPublicById(id)` — so the real service is constructed and that one
    // line is reproduced, rather than dragging in `ConcernService` and its
    // repository to build a facade whose other four methods this module never
    // calls.
    const specialtyService = new SpecialtyService(new SpecialtyRepository(db), audit);
    const catalogue = {
      getSpecialtyById: (id: string) => specialtyService.getPublicById(id),
    } as unknown as CatalogueFacade;
    const templates = new ClinicalTemplateService(
      new ClinicalTemplateRepository(db),
      {
        getPrescribingEligibility: async () => true,
        getPublicProfile: async () => null,
      } as unknown as DoctorFacade,
      audit,
    );
    const pdf = { generateForConsultation: async () => null } as unknown as ClinicalPdfService;

    clinical = new ClinicalService(
      db,
      clinicalRepo,
      bookings,
      catalogue,
      instant,
      templates,
      pdf,
      audit,
      { emit: () => {} } as unknown as EventEmitter2,
    );
    sweep = new ClinicalGateSweepService(clinicalRepo, bookings, instant);
    // The sweep's timer is never started here: `sweepFinalisedRecords` is
    // called directly, exactly as `booking-slot-hold.service.ts`'s own
    // `sweepExpiredHolds` is.
  });

  afterAll(async () => {
    if (fixtures) await teardown(db, fixtures);
    await disconnectDatabase();
  });

  async function readDoctorGate(doctorId: string): Promise<string | null> {
    const [row] = await db
      .select({ blockedByConsultationId: doctorsTable.blockedByConsultationId })
      .from(doctorsTable)
      .where(eq(doctorsTable.id, doctorId))
      .limit(1);
    return row?.blockedByConsultationId ?? null;
  }

  async function readConsultationStatus(consultationId: string): Promise<string | null> {
    const [row] = await db
      .select({ status: consultationsTable.status })
      .from(consultationsTable)
      .where(eq(consultationsTable.id, consultationId))
      .limit(1);
    return row?.status ?? null;
  }

  async function readRecord(consultationId: string) {
    const [row] = await db
      .select()
      .from(clinicalRecordsTable)
      .where(eq(clinicalRecordsTable.consultationId, consultationId))
      .limit(1);
    return row ?? null;
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 1. THE COMPLETION GATE REFUSES, AND CHANGES NOTHING.                    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('an incomplete record cannot close the case (FR-11.5)', () => {
    it('*** REFUSES A REAL FINALISE WITH NO CASE SUMMARY, AND LEAVES EVERY ROW WHERE IT WAS ***', async () => {
      await clinical.saveDraft(fixtures.consultationId, fixtures.doctorId, {
        chiefComplaint: 'Low mood for three months.',
        riskCategory: 'moderate',
        adviceCovered: 'Reviewed sleep and mood.',
        adviceHomePractice: 'Paced breathing at night.',
        adviceNextFocus: 'Behavioural activation.',
        adviceWarningSigns: 'Thoughts of self-harm.',
        // No case summary.
      });

      await expect(
        clinical.finalise(fixtures.consultationId, fixtures.doctorId),
      ).rejects.toMatchObject({
        response: { code: CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED },
      });

      expect((await readRecord(fixtures.consultationId))?.finalisedAt).toBeNull();
      expect(await readDoctorGate(fixtures.doctorId)).toBe(fixtures.consultationId);
      expect(await readConsultationStatus(fixtures.consultationId)).toBe('in_progress');
    });

    it('*** A NON-PRESCRIBING SPECIALTY CANNOT SAVE A MEDICINE, AND THE jsonb COLUMN PROVES IT ***', async () => {
      await clinical.saveDraft(fixtures.nonPrescribingConsultationId, fixtures.doctorId, {
        chiefComplaint: 'Anxiety before exams.',
        riskCategory: 'low',
      });

      await expect(
        clinical.saveDraft(fixtures.nonPrescribingConsultationId, fixtures.doctorId, {
          chiefComplaint: 'Anxiety before exams.',
          riskCategory: 'low',
          medicines: [
            { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED } });

      // The gate read `consultations.specialty_id -> specialties.can_prescribe`
      // from the real rows, and nothing was written.
      expect((await readRecord(fixtures.nonPrescribingConsultationId))?.medicines).toEqual([]);
    });

    it('POSITIVE CONTROL: the same medicine line saves against the PRESCRIBING consultation', async () => {
      await clinical.saveDraft(fixtures.consultationId, fixtures.doctorId, {
        chiefComplaint: 'Low mood for three months.',
        riskCategory: 'moderate',
        medicines: [
          { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' },
        ],
        adviceCovered: 'Reviewed sleep and mood.',
        adviceHomePractice: 'Paced breathing at night.',
        adviceNextFocus: 'Behavioural activation.',
        adviceWarningSigns: 'Thoughts of self-harm, or not sleeping for two nights.',
        caseSummary: 'Moderate depressive episode. Started sertraline. Review in two weeks.',
      });

      const stored = await readRecord(fixtures.consultationId);
      expect(stored?.medicines).toEqual([
        { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' },
      ]);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 2. FINALISING FIRES. NOT "COMPILES AGAINST" — FIRES.                    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('finalising switches the machinery on', () => {
    it('*** CLEARS `doctors.blocked_by_consultation_id` IN POSTGRES (FR-10.5) ***', async () => {
      // Precondition, asserted rather than assumed: the doctor really is gated.
      expect(await readDoctorGate(fixtures.doctorId)).toBe(fixtures.consultationId);

      const result = await clinical.finalise(fixtures.consultationId, fixtures.doctorId);

      expect(result.completionGateCleared).toBe(true);
      // Read back with a FRESH query, not from the service's return value.
      expect(await readDoctorGate(fixtures.doctorId)).toBeNull();
    });

    it('sets `finalised_at` on the record itself', async () => {
      expect((await readRecord(fixtures.consultationId))?.finalisedAt).toBeInstanceOf(Date);
    });

    it('*** MOVES `consultations.status` TO `completed` ***', async () => {
      expect(await readConsultationStatus(fixtures.consultationId)).toBe('completed');
    });

    it('*** AND THAT STATUS IS ONE THE PROMOTION SWEEP QUALIFIES ON — the referral/affiliate consequence fires ***', async () => {
      promotionLookup = new PromotionConsultationLookupProvider(db);

      // The REAL port `promotion-sweep.service.ts` reads statuses through...
      const statuses = await promotionLookup.getConsultationStatuses([fixtures.consultationId]);
      const status = statuses.get(fixtures.consultationId);

      // ...and the REAL predicate it applies: `qualifying.has(status)`, where
      // `qualifying` is built from `promotion.referral_qualifying_statuses`.
      const qualifying = new Set<string>(PROMOTION_DEFAULT_QUALIFYING_STATUSES);

      expect(status).toBe('completed');
      expect(qualifying.has(status ?? 'unknown')).toBe(true);
      // Before this module existed, nothing in the codebase could put a
      // consultation into either qualifying status, so this assertion was
      // unreachable — see `promotion.constants.ts`'s own note on the default.
    });

    it('*** DOES NOT TOUCH A DOCTOR GATED BY A DIFFERENT CONSULTATION *** — that is documentation still owed', async () => {
      expect(await readDoctorGate(fixtures.otherDoctorId)).toBe(fixtures.otherConsultationId);
    });

    it('refuses a second finalise, and the record stays exactly as it was', async () => {
      const before = await readRecord(fixtures.consultationId);

      await expect(
        clinical.finalise(fixtures.consultationId, fixtures.doctorId),
      ).rejects.toMatchObject({
        response: { code: CLINICAL_ERROR_CODES.CONSULTATION_NOT_WRITABLE },
      });

      expect((await readRecord(fixtures.consultationId))?.finalisedAt).toEqual(before?.finalisedAt);
    });

    it('leaves the FR-11.6 trail queryable by consultation id alone', async () => {
      const entries = await db
        .select({ entityType: auditLogTable.entityType, action: auditLogTable.action })
        .from(auditLogTable)
        .where(eq(auditLogTable.consultationId, fixtures.consultationId));

      // This module's own draft/finalise rows AND the consultation transition
      // row the completion write left — one id, several modules' worth of
      // history, which is exactly what FR-11.6 asks the id to be for.
      expect(entries.some((entry) => entry.entityType === 'clinical_record')).toBe(true);
      expect(entries.some((entry) => entry.entityType === 'consultation')).toBe(true);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 3. THE FULL RECORD REBUILDS FROM THE CONSULTATION ID.                   */
  /* ═══════════════════════════════════════════════════════════════════════ */

  /*
   * These live in a `describe` rather than as bare `it`s for a reason that bit
   * this file once: Jest runs a block's OWN tests before any of its nested
   * `describe`s, whatever the source order. Bare `it`s here would have executed
   * before the finalisation above ever ran, and this suite is deliberately
   * sequential — each block builds on the row state the previous one left.
   */
  describe('the record, rebuilt', () => {
    it('*** REBUILDS THE WHOLE RECORD FROM THE CONSULTATION ID *** — jsonb medicines and all', async () => {
      const view = await clinical.getRecordByConsultationId(fixtures.consultationId);

      expect(view).toMatchObject({
        consultationId: fixtures.consultationId,
        chiefComplaint: 'Low mood for three months.',
        riskCategory: 'moderate',
        medicines: [
          { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' },
        ],
        advice: {
          covered: 'Reviewed sleep and mood.',
          homePractice: 'Paced breathing at night.',
          nextFocus: 'Behavioural activation.',
          warningSigns: 'Thoughts of self-harm, or not sleeping for two nights.',
        },
        caseSummary: 'Moderate depressive episode. Started sertraline. Review in two weeks.',
      });
      expect(view?.finalisedAt).toBeInstanceOf(Date);
    });

    it('gives M-16 the Care Plan projection off the same id', async () => {
      const plan = await clinical.getCarePlanInputs(fixtures.consultationId);

      expect(plan?.advice.warningSigns).toBe(
        'Thoughts of self-harm, or not sleeping for two nights.',
      );
      expect(plan).not.toHaveProperty('caseSummary');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4. THE SWEEP REPAIRS THE CRASH THAT CANNOT BE A TRANSACTION.            */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the reconciling sweep', () => {
    it('*** RE-CLEARS A GATE THAT CAME BACK — the exact state a crash between the two writes leaves behind ***', async () => {
      // Simulate the crash: the record is already final, and the doctor is
      // gated by it again (the un-gating never happened).
      await db
        .update(doctorsTable)
        .set({ blockedByConsultationId: fixtures.consultationId })
        .where(eq(doctorsTable.id, fixtures.doctorId));
      expect(await readDoctorGate(fixtures.doctorId)).toBe(fixtures.consultationId);

      const result = await sweep.sweepFinalisedRecords();

      expect(result.gatesCleared).toBeGreaterThanOrEqual(1);
      expect(await readDoctorGate(fixtures.doctorId)).toBeNull();
    });

    it('*** LEAVES THE OTHER DOCTOR GATED *** — the sweep repairs one consultation, not every gate it can see', async () => {
      expect(await readDoctorGate(fixtures.otherDoctorId)).toBe(fixtures.otherConsultationId);
    });

    it('is idempotent: a second pass finds nothing left to repair for this consultation', async () => {
      const result = await sweep.sweepFinalisedRecords();

      expect(result.failed).toBe(0);
      expect(await readDoctorGate(fixtures.doctorId)).toBeNull();
      expect(await readConsultationStatus(fixtures.consultationId)).toBe('completed');
    });

    it('completes a consultation stranded before `completed` under a final record', async () => {
      // The other half of the same crash: the record is final and the status
      // move was lost.
      await db
        .update(consultationsTable)
        .set({ status: 'awaiting_documentation' })
        .where(eq(consultationsTable.id, fixtures.consultationId));

      const result = await sweep.sweepFinalisedRecords();

      expect(result.consultationsCompleted).toBeGreaterThanOrEqual(1);
      expect(await readConsultationStatus(fixtures.consultationId)).toBe('completed');
    });

    it('does not reach back past its own look-back window', async () => {
      // A one-millisecond horizon can see nothing, which is what makes the
      // window a real bound rather than a decorative parameter.
      const result = await sweep.sweepFinalisedRecords(new Date(), 1);

      expect(result.examined).toBe(0);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4b. TWO SAVES OF THE *FIRST* DRAFT, AT THE SAME INSTANT.                */
  /*                                                                         */
  /* `writeDraft` opens a transaction, reads FOR UPDATE, and INSERTS when it */
  /* finds nothing. *** `SELECT ... FOR UPDATE` THAT MATCHES ZERO ROWS LOCKS */
  /* NOTHING *** — there is no row yet to lock — so two requests that arrive */
  /* before either has committed both read null and both insert against      */
  /* `clinical_records.consultation_id`, which is UNIQUE.                    */
  /*                                                                         */
  /* That is a doctor double-tapping "save" on a notes form they have not    */
  /* saved before: the single most ordinary thing a user does. Every other   */
  /* check-then-insert in this codebase carries a `23505` safety net for     */
  /* exactly this (`consent.service.ts`, `legal-document.service.ts`,        */
  /* `clinical-template.service.ts`, `booking.service.ts`); this one did     */
  /* not, and the loser got a raw driver error — a 500, not a saved record.  */
  /*                                                                         */
  /* Only a real database can show it. The `db.transaction` fake in          */
  /* `clinical.service.spec.ts` has no unique index and no rollback.         */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('two concurrent saves of the very first draft', () => {
    const draft = (summary: string) => ({
      chiefComplaint: 'Panic attacks on the commute.',
      riskCategory: 'low' as const,
      caseSummary: summary,
    });

    it('*** THREE CONCURRENT FIRST SAVES, UNFORCED — none of them is a 500 ***', async () => {
      const results = await Promise.allSettled([
        clinical.saveDraft(fixtures.raceConsultationId, fixtures.doctorId, draft('First writer.')),
        clinical.saveDraft(fixtures.raceConsultationId, fixtures.doctorId, draft('Second writer.')),
        clinical.saveDraft(fixtures.raceConsultationId, fixtures.doctorId, draft('Third writer.')),
      ]);

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected.map((result) => String((result as PromiseRejectedResult).reason))).toEqual([]);

      const rows = await db
        .select({ id: clinicalRecordsTable.id })
        .from(clinicalRecordsTable)
        .where(eq(clinicalRecordsTable.consultationId, fixtures.raceConsultationId));

      expect(rows).toHaveLength(1);
    });

    /**
     * *** THE INTERLEAVING, FORCED — NOT LEFT TO A COIN FLIP. ***
     *
     * A plain `Promise.all` of concurrent saves reproduces this most of the
     * time (measured against this database before the fix: 48 failures in 75
     * three-way races) but not every time, and a regression test that is red
     * two runs in three is not a regression test. So the competing request is
     * committed AT the one instant that matters — after this transaction's
     * `SELECT ... FOR UPDATE` has found nothing and locked nothing, and
     * before its INSERT — from a different pooled connection, which is
     * exactly the state the loser of the real race observes.
     *
     * `mockImplementationOnce`: only the FIRST attempt is sabotaged, so the
     * retry runs entirely against the real repository.
     */
    it('*** THE LOSER OF THE INSERT RACE STILL SAVES ITS RECORD *** — a double-tapped save is not a 500', async () => {
      const findForUpdate = clinicalRepo.findByConsultationIdForUpdate.bind(clinicalRepo);
      const spy = jest
        .spyOn(clinicalRepo, 'findByConsultationIdForUpdate')
        .mockImplementationOnce(async (consultationId, tx) => {
          const found = await findForUpdate(consultationId, tx);
          await db.insert(clinicalRecordsTable).values({
            consultationId,
            chiefComplaint: 'Competing writer got there first.',
            riskCategory: 'low',
          });
          return found;
        });

      try {
        await expect(
          clinical.saveDraft(fixtures.forcedRaceConsultationId, fixtures.doctorId, draft('Loser writes anyway.')),
        ).resolves.toMatchObject({ caseSummary: 'Loser writes anyway.' });
      } finally {
        spy.mockRestore();
      }

      const rows = await db
        .select({ id: clinicalRecordsTable.id, caseSummary: clinicalRecordsTable.caseSummary })
        .from(clinicalRecordsTable)
        .where(eq(clinicalRecordsTable.consultationId, fixtures.forcedRaceConsultationId));

      // One row, carrying the loser's content: the retry took the UPDATE
      // branch against the winner's row rather than inserting a second.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.caseSummary).toBe('Loser writes anyway.');
    });

    it('POSITIVE CONTROL: the second, sequential save still updates rather than inserting', async () => {
      await clinical.saveDraft(fixtures.raceConsultationId, fixtures.doctorId, draft('Fourth writer.'));

      const rows = await db
        .select({ caseSummary: clinicalRecordsTable.caseSummary })
        .from(clinicalRecordsTable)
        .where(eq(clinicalRecordsTable.consultationId, fixtures.raceConsultationId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.caseSummary).toBe('Fourth writer.');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4c. *** THE SPECIALTY FLIPPED BETWEEN THE DRAFT AND THE FINALISE. ***   */
  /*                                                                         */
  /* `specialties.can_prescribe` is an admin-editable column, and both gates */
  /* read it LIVE. So a medicine line CAN sit in a draft belonging to a      */
  /* consultation that may no longer carry one — which is why                */
  /* `assertCompletionGate` re-asserts the prescribing gate rather than      */
  /* trusting "the save-time check already refused it".                      */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('a specialty that stops allowing prescribing mid-consultation', () => {
    it('*** REFUSES TO SEAL MEDICINES THE CONSULTATION MAY NO LONGER CARRY, AND NOTHING MOVES ***', async () => {
      // 1. The specialty allows prescribing, so this save is legal.
      await clinical.saveDraft(fixtures.flipConsultationId, fixtures.doctorId, {
        chiefComplaint: 'Sleep onset insomnia.',
        riskCategory: 'low',
        medicines: [{ name: 'Melatonin', dose: '3mg', frequency: 'At night', duration: '14 days' }],
        caseSummary: 'Sleep hygiene reviewed; short trial started.',
      });
      expect((await readRecord(fixtures.flipConsultationId))?.medicines).toHaveLength(1);

      // 2. An admin flips it. `specialty.service.ts#adminUpdate` does exactly
      //    this, and nothing in the platform revisits records already drafted.
      await db
        .update(specialtiesTable)
        .set({ canPrescribe: false })
        .where(eq(specialtiesTable.id, fixtures.flipSpecialtyId));

      // 3. The doctor finalises.
      await expect(clinical.finalise(fixtures.flipConsultationId, fixtures.doctorId)).rejects.toMatchObject({
        response: { code: CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED },
      });

      // Nothing was sealed, and no prescription was produced.
      expect((await readRecord(fixtures.flipConsultationId))?.finalisedAt).toBeNull();
      expect(await readConsultationStatus(fixtures.flipConsultationId)).toBe('in_progress');
    });

    it('and the remedy is the doctor’s own: drop the medicines, write the advice plan, finalise', async () => {
      await clinical.saveDraft(fixtures.flipConsultationId, fixtures.doctorId, {
        chiefComplaint: 'Sleep onset insomnia.',
        riskCategory: 'low',
        adviceCovered: 'Sleep hygiene and stimulus control.',
        adviceHomePractice: 'Fixed wake time; no screens after 10pm.',
        adviceNextFocus: 'Review sleep diary.',
        adviceWarningSigns: 'Daytime collapse, or thoughts of self-harm.',
        caseSummary: 'Sleep hygiene reviewed; behavioural plan agreed.',
      });

      const result = await clinical.finalise(fixtures.flipConsultationId, fixtures.doctorId);

      expect(result.record.finalisedAt).toBeInstanceOf(Date);
      expect(result.record.medicines).toHaveLength(0);
      expect(await readConsultationStatus(fixtures.flipConsultationId)).toBe('completed');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 4d. *** THE ROW LOCK, AGAINST REAL CONCURRENT REQUESTS. ***             */
  /*                                                                         */
  /* `clinical.service.ts`'s header says the gate is checked twice — cheaply */
  /* before the transaction and authoritatively against the row read         */
  /* `FOR UPDATE` — because otherwise "save a draft that blanks the case     */
  /* summary" and "finalise" could interleave so the gate is evaluated       */
  /* against a row that no longer exists by the time `finalised_at` is       */
  /* written. `clinical.service.spec.ts` proves that against a `db`          */
  /* transaction fake WITH NO ROLLBACK AND NO ROW LOCK. This proves it       */
  /* against Postgres.                                                       */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('a draft save racing a finalise', () => {
    const advice = {
      adviceCovered: 'Grounding technique.',
      adviceHomePractice: 'Daily practice.',
      adviceNextFocus: 'Exposure hierarchy.',
      adviceWarningSigns: 'Chest pain that does not settle.',
    };

    it('*** NEVER PRODUCES A FINALISED RECORD WITH A BLANK CASE SUMMARY ***', async () => {
      await clinical.saveDraft(fixtures.draftRaceConsultationId, fixtures.doctorId, {
        chiefComplaint: 'Panic attacks.',
        riskCategory: 'low',
        ...advice,
        caseSummary: 'Panic psychoeducation; grounding taught.',
      });

      // The blanking save omits `caseSummary` entirely — `PUT` semantics, so
      // it is CLEARED, which is precisely the interleaving the second check
      // exists for.
      const [finalised, blanked] = await Promise.allSettled([
        clinical.finalise(fixtures.draftRaceConsultationId, fixtures.doctorId),
        clinical.saveDraft(fixtures.draftRaceConsultationId, fixtures.doctorId, {
          chiefComplaint: 'Panic attacks.',
          riskCategory: 'low',
          ...advice,
        }),
      ]);

      const row = await readRecord(fixtures.draftRaceConsultationId);

      // Exactly one of two outcomes, and both are legal. What is NOT legal is
      // a row with `finalised_at` set and `case_summary` null.
      expect(Boolean(row?.finalisedAt) && row?.caseSummary === null).toBe(false);
      if (row?.finalisedAt) {
        expect(row.caseSummary).toBe('Panic psychoeducation; grounding taught.');
        expect(finalised.status).toBe('fulfilled');
      } else {
        expect(blanked.status).toBe('fulfilled');
        expect(finalised.status).toBe('rejected');
      }
    });

    it('*** TWO SIMULTANEOUS FINALISES SEAL THE RECORD EXACTLY ONCE ***', async () => {
      await clinical.saveDraft(fixtures.finaliseRaceConsultationId, fixtures.doctorId, {
        chiefComplaint: 'Low mood.',
        riskCategory: 'low',
        adviceCovered: 'Behavioural activation.',
        adviceHomePractice: 'One pleasant activity daily.',
        adviceNextFocus: 'Activity scheduling.',
        adviceWarningSigns: 'Thoughts of self-harm.',
        caseSummary: 'Mood reviewed; activation plan agreed.',
      });

      const results = await Promise.allSettled([
        clinical.finalise(fixtures.finaliseRaceConsultationId, fixtures.doctorId),
        clinical.finalise(fixtures.finaliseRaceConsultationId, fixtures.doctorId),
        clinical.finalise(fixtures.finaliseRaceConsultationId, fixtures.doctorId),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      for (const rejection of results.filter((result) => result.status === 'rejected')) {
        expect((rejection as PromiseRejectedResult).reason).toMatchObject({
          response: { code: CLINICAL_ERROR_CODES.RECORD_ALREADY_FINALISED },
        });
      }

      // And `finalised_at` is the ONE winner's timestamp — not overwritten by
      // a loser that got as far as the guarded UPDATE.
      const row = await readRecord(fixtures.finaliseRaceConsultationId);
      const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<ClinicalService['finalise']>>>).value;
      expect(row?.finalisedAt?.toISOString()).toBe(winner.record.finalisedAt?.toISOString());
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 5. THE UNIQUE CONSTRAINT BEHIND "ONE RECORD PER CONSULTATION".          */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('one record per consultation', () => {
    it('keeps exactly one clinical record per consultation', async () => {
      const rows = await db
        .select({ id: clinicalRecordsTable.id })
        .from(clinicalRecordsTable)
        .where(
          and(
            eq(clinicalRecordsTable.consultationId, fixtures.consultationId),
            eq(clinicalRecordsTable.riskCategory, 'moderate'),
          ),
        );

      expect(rows).toHaveLength(1);
    });
  });
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* 6. *** THE SWEEP'S BATCH WAS A BLIND SPOT, NOT A BACKLOG DRAIN. ***     */
  /*                                                                         */
  /* `listFinalisedSince` selects records finalised inside the window,       */
  /* NEWEST FIRST, and nothing the sweep does removes a record from that     */
  /* set. So a fixed `limit` did not "drain a backlog steadily" the way      */
  /* `booking-slot-hold.service.ts`'s does — it re-read the same newest      */
  /* rows every tick, forever, and a gate stranded on the next one was       */
  /* reachable by NOTHING.                                                   */
  /*                                                                         */
  /* Driven with `batchSize: 1` and a three-second window rather than 100    */
  /* and a day, because the shape of the failure is the same at any scale    */
  /* and seeding 101 finalised consultations to prove it would be a slower   */
  /* test that proved less.                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the sweep pages across its whole window', () => {
    it('*** REPAIRS A GATE THAT IS NOT IN THE FIRST BATCH ***', async () => {
      const anchor = new Date();

      // Every other record this run finalised is pushed out of the way, so the
      // narrow window below contains exactly the two rows under test and this
      // spec does not depend on how long the tests above happened to take.
      await db
        .update(clinicalRecordsTable)
        .set({ finalisedAt: new Date(anchor.getTime() - 10 * 60 * 1000) })
        .where(
          and(
            isNotNull(clinicalRecordsTable.finalisedAt),
            inArray(clinicalRecordsTable.consultationId, [
              fixtures.consultationId,
              fixtures.otherConsultationId,
              fixtures.nonPrescribingConsultationId,
              fixtures.raceConsultationId,
              fixtures.forcedRaceConsultationId,
              fixtures.flipConsultationId,
              fixtures.draftRaceConsultationId,
              fixtures.finaliseRaceConsultationId,
            ]),
          ),
        );

      // The rows are written directly: the sweep reads `clinical_records` and
      // nothing else, and going through `finalise` would clear the very gate
      // this test needs left behind.
      for (const [consultationId, finalisedAt] of [
        [fixtures.pagingDecoyConsultationId, anchor],
        [fixtures.pagingStrandedConsultationId, new Date(anchor.getTime() - 1000)],
      ] as const) {
        await db.insert(clinicalRecordsTable).values({
          consultationId,
          chiefComplaint: 'Documented already.',
          riskCategory: 'low',
          caseSummary: 'Closed.',
          finalisedAt,
        });
        await db
          .update(consultationsTable)
          .set({ status: 'completed' })
          .where(eq(consultationsTable.id, consultationId));
      }

      // The crash state: the record is final, but the doctor is still gated by
      // it — and it is the SECOND row in a newest-first ordering.
      expect(await readDoctorGate(fixtures.pagingDoctorId)).toBe(fixtures.pagingStrandedConsultationId);

      const result = await sweep.sweepFinalisedRecords(anchor, 3_000, 1);

      // Before the fix the sweep stopped after one batch of one, examined only
      // the decoy, and left the gate exactly where it was.
      expect(result.examined).toBe(2);
      expect(result.gatesCleared).toBe(1);
      expect(await readDoctorGate(fixtures.pagingDoctorId)).toBeNull();
    });

    it('reports `truncated` instead of silently absorbing a backlog it could not finish', async () => {
      // One batch of one, and `CLINICAL_GATE_SWEEP_MAX_BATCHES` pages, against
      // a window that still holds both rows: the pass ends cleanly either way,
      // and `truncated` is the honest signal for the case where it does not.
      const result = await sweep.sweepFinalisedRecords(new Date(), 24 * 60 * 60 * 1000, 1);

      expect(result.truncated).toBe(result.examined >= CLINICAL_GATE_SWEEP_MAX_BATCHES);
      expect(result.failed).toBe(0);
    });
  });

});
