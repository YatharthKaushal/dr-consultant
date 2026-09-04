/**
 * *** REAL-DATABASE TEST. *** Follows `clinical.completion-gate.integration
 * .spec.ts` / `document/patient-file.transaction.integration.spec.ts` —
 * one fixture helper, strict reverse-FK teardown, per-run UUID/code
 * namespacing.
 *
 * `carehub.service.spec.ts` mocks `CarehubRepository`/`BookingFacade`/
 * `CatalogueFacade` entirely, which proves the RULES (ownership check
 * shape, field validation, the state-machine's `from` sets) but nothing
 * about whether those rules survive real SQL. Three claims specifically
 * need Postgres and cannot be proven any other way:
 *
 *   1. *** THE GUARDED STATE-MACHINE UPDATE. *** `transitionReviewStatus`'s
 *      `WHERE review_status IN (...)` really does refuse an illegal move and
 *      really does persist `reviewed_by_admin_id`/`reviewed_at` on exactly
 *      the move into `published` — a claim about a WHERE clause, not a
 *      `jest.fn()`.
 *   2. *** THE UNIQUE INDEX. *** `content_recommendations`'s
 *      `(consultation_id, content_item_id)` unique index is what makes
 *      `addRecommendationIfAbsent`'s `ON CONFLICT DO NOTHING` idempotent
 *      under real concurrency, not just when called twice in sequence.
 *   3. *** THE OWNERSHIP CHECK, END TO END. *** `BookingFacade.getBooking`
 *      reading a REAL `consultations` row is what the doctor-recommendation
 *      write path's 404 actually depends on.
 *
 * ── What is real here and what is not ──────────────────────────────────
 *
 * Real: the database, `CarehubRepository`, `AuditService`, `SpecialtyService`
 * + `ConcernService` + `CatalogueFacade` (M-06, unmodified), `BookingRepository`
 * + `toBookingView` (M-11's own read path).
 *
 * Not constructed: the rest of `BookingService`'s ten collaborators (payment
 * gateway, availability, etc.) — `CarehubService` only ever calls
 * `BookingFacade.getBooking`, which is exactly `BookingRepository.findById`
 * + `toBookingView` (verified by reading `booking.facade.ts`), so a plain
 * object exposing just that one method, built from the real repository and
 * the real mapper, is the real read path with none of write-side M-11
 * constructed for no reason — the same restraint the clinical integration
 * spec applies to `InstantFacade`.
 *
 * Requires a reachable Postgres — reads `DATABASE_URL` from `.env.local`
 * exactly as the seed scripts do, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminsTable } from '../../schema/admins.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { concernsTable } from '../../schema/concerns.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { contentItemsTable } from '../../schema/content-items.schema';
import { contentRecommendationsTable } from '../../schema/content-recommendations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import { toBookingView } from '../booking/booking.mapper';
import { BookingRepository } from '../booking/booking.repository';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { ConcernRepository } from '../catalogue/concern.repository';
import { ConcernService } from '../catalogue/concern.service';
import { SpecialtyRepository } from '../catalogue/specialty.repository';
import { SpecialtyService } from '../catalogue/specialty.service';
import { CARE_HUB_ERROR_CODES } from './carehub.constants';
import { CareHubFacade } from './carehub.facade';
import { CarehubRepository } from './carehub.repository';
import { CarehubService } from './carehub.service';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  concernId: string;
  patientId: string;
  doctorId: string;
  otherDoctorId: string;
  consultationId: string;
  otherDoctorConsultationId: string;
  /** `content_items.reviewed_by_admin_id` FKs to `admins.id` — a real row is required for `publish()` to succeed against Postgres. */
  adminId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9197${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [admin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Care Hub Reviewer ${runId}` })
    .returning({ id: adminsTable.id });
  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `carehub_${runId}`, name: `Care Hub Test Specialty ${runId}`, canPrescribe: false })
    .returning({ id: specialtiesTable.id });
  const [concern] = await db
    .insert(concernsTable)
    .values({ specialtyId: specialty.id, code: `sleep_${runId}`, name: `Sleep ${runId}` })
    .returning({ id: concernsTable.id });
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
      })
      .returning({ id: doctorsTable.id });
    // `consultations` has a composite FK to `doctor_specialties(doctor_id,
    // specialty_id)` (`consultations_doctor_specialty_fk`) — a consultation
    // may only be booked under a specialty the doctor actually practises.
    await db.insert(doctorSpecialtiesTable).values({ doctorId: row.id, specialtyId: specialty.id, isPrimary: true });
    return row.id;
  }
  const doctorId = await makeDoctor('Care Hub Doctor');
  const otherDoctorId = await makeDoctor('Other Care Hub Doctor');

  async function makeConsultation(assignedDoctorId: string, refSuffix: string): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `CH-${runId}-${refSuffix}`,
        patientId: patient.id,
        doctorId: assignedDoctorId,
        specialtyId: specialty.id,
        mode: 'scheduled',
        status: 'completed',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }
  const consultationId = await makeConsultation(doctorId, '1');
  const otherDoctorConsultationId = await makeConsultation(otherDoctorId, '2');

  return {
    runId,
    specialtyId: specialty.id,
    concernId: concern.id,
    patientId: patient.id,
    doctorId,
    otherDoctorId,
    consultationId,
    otherDoctorConsultationId,
    adminId: admin.id,
  };
}

/** Strict reverse-FK order. `content_recommendations` and `content_items` go first — both are referenced by nothing else here but reference `consultations`/`concerns` respectively. */
async function teardown(db: Database, fixtures: Fixtures, contentItemIds: readonly string[]): Promise<void> {
  const consultationIds = [fixtures.consultationId, fixtures.otherDoctorConsultationId];
  const doctorIds = [fixtures.doctorId, fixtures.otherDoctorId];

  await db.delete(contentRecommendationsTable).where(inArray(contentRecommendationsTable.consultationId, consultationIds));
  await db.delete(contentItemsTable).where(inArray(contentItemsTable.id, contentItemIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(concernsTable).where(eq(concernsTable.id, fixtures.concernId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
  await db.delete(adminsTable).where(eq(adminsTable.id, fixtures.adminId));
}

describe('M-18 Care Hub, against a real database', () => {
  let db: Database;
  let fixtures: Fixtures;
  let carehub: CarehubService;
  let facade: CareHubFacade;
  let repo: CarehubRepository;
  const createdContentItemIds: string[] = [];

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    const audit = new AuditService(db);
    repo = new CarehubRepository(db);
    const catalogue = new CatalogueFacade(
      new SpecialtyService(new SpecialtyRepository(db), audit),
      new ConcernService(new ConcernRepository(db), new SpecialtyService(new SpecialtyRepository(db), audit), audit),
    );

    // *** THE REAL M-11 READ PATH, NOTHING ELSE OF BOOKING CONSTRUCTED. ***
    // See the file's own header for why this is faithful rather than a stub.
    const bookingRepo = new BookingRepository(db);
    const bookings: Pick<BookingFacade, 'getBooking'> = {
      getBooking: async (consultationId: string) => {
        const row = await bookingRepo.findById(consultationId);
        return row ? toBookingView(row) : null;
      },
    };

    carehub = new CarehubService(repo, catalogue, bookings as BookingFacade, audit);
    facade = new CareHubFacade(carehub);
  });

  afterAll(async () => {
    await teardown(db, fixtures, createdContentItemIds);
    await disconnectDatabase();
  });

  async function createDraftItem(overrides: Partial<Parameters<CarehubService['create']>[0]> = {}) {
    const slug = `carehub-it-${fixtures.runId}-${randomUUID().slice(0, 8)}`;
    const view = await carehub.create(
      { itemType: 'caregiver_guide', slug, title: 'Warning signs', body: { blocks: [] }, ...overrides },
      fixtures.adminId,
    );
    createdContentItemIds.push(view.id);
    return view;
  }

  describe('the review state machine, against the real guarded UPDATE', () => {
    it('walks draft -> in_clinical_review -> published, and the sign-off really persists', async () => {
      const draft = await createDraftItem();
      expect(draft.reviewStatus).toBe('draft');

      await carehub.submitForReview(draft.id, fixtures.adminId);

      const reviewerId = fixtures.adminId;
      const published = await carehub.publish(draft.id, reviewerId);

      expect(published.reviewStatus).toBe('published');
      expect(published.reviewedByAdminId).toBe(reviewerId);
      expect(published.reviewedAt).not.toBeNull();

      // Read back independently of the service, straight off the row —
      // this is the claim a mocked repository cannot make.
      const [row] = await db.select().from(contentItemsTable).where(eq(contentItemsTable.id, draft.id));
      expect(row!.reviewStatus).toBe('published');
      expect(row!.reviewedByAdminId).toBe(reviewerId);
    });

    it('refuses to publish straight from draft — the WHERE clause really guards it', async () => {
      const draft = await createDraftItem();
      await expect(carehub.publish(draft.id, fixtures.adminId)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: CARE_HUB_ERROR_CODES.ILLEGAL_REVIEW_TRANSITION }),
      });

      const [row] = await db.select().from(contentItemsTable).where(eq(contentItemsTable.id, draft.id));
      expect(row!.reviewStatus).toBe('draft');
    });

    it('retire (published -> archived) then restore (archived -> draft) round-trip against the real row', async () => {
      const draft = await createDraftItem();
      await carehub.submitForReview(draft.id, fixtures.adminId);
      await carehub.publish(draft.id, fixtures.adminId);

      const archived = await carehub.retire(draft.id, fixtures.adminId);
      expect(archived.reviewStatus).toBe('archived');

      const restored = await carehub.restore(draft.id, fixtures.adminId);
      expect(restored.reviewStatus).toBe('draft');
    });
  });

  describe('the taxonomy reference check, against real catalogue rows', () => {
    it('accepts a real concernId', async () => {
      const item = await createDraftItem({ itemType: 'education_module', concernId: fixtures.concernId });
      expect(item.concernId).toBe(fixtures.concernId);
    });

    it('rejects a concernId nothing references', async () => {
      await expect(createDraftItem({ itemType: 'education_module', concernId: randomUUID() })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: CARE_HUB_ERROR_CODES.UNKNOWN_TAXONOMY_REFERENCE }),
      });
    });
  });

  describe('FR-15.4: the doctor recommendation write path, against real bookings', () => {
    it('the treating doctor can recommend a published item', async () => {
      const item = await createDraftItem();
      await carehub.submitForReview(item.id, fixtures.adminId);
      await carehub.publish(item.id, fixtures.adminId);

      const result = await carehub.addRecommendations(fixtures.consultationId, fixtures.doctorId, {
        contentItemIds: [item.id],
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.contentItem.id).toBe(item.id);
    });

    it('a doctor who is not the treating doctor gets a 404 — real BookingFacade.getBooking, real ownership mismatch', async () => {
      const item = await createDraftItem();
      await carehub.submitForReview(item.id, fixtures.adminId);
      await carehub.publish(item.id, fixtures.adminId);

      await expect(
        carehub.addRecommendations(fixtures.consultationId, fixtures.otherDoctorId, { contentItemIds: [item.id] }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('the patient reads their own recommendation, tagged with the content — real ownership match', async () => {
      const item = await createDraftItem();
      await carehub.submitForReview(item.id, fixtures.adminId);
      await carehub.publish(item.id, fixtures.adminId);
      await carehub.addRecommendations(fixtures.consultationId, fixtures.doctorId, { contentItemIds: [item.id] });

      const result = await carehub.listRecommendationsForPatient(fixtures.consultationId, fixtures.patientId);
      expect(result.map((r) => r.contentItem.id)).toContain(item.id);
    });

    it('the CareHubFacade/CareHubPort projection reflects the real row', async () => {
      const item = await createDraftItem();
      await carehub.submitForReview(item.id, fixtures.adminId);
      await carehub.publish(item.id, fixtures.adminId);
      await carehub.addRecommendations(fixtures.consultationId, fixtures.doctorId, { contentItemIds: [item.id] });

      const result = await facade.getRecommendedForConsultation(fixtures.consultationId);
      expect(result).toEqual(expect.arrayContaining([{ contentId: item.id, title: item.title, kind: item.itemType }]));
    });

    it('*** THE UNIQUE INDEX, UNDER REAL CONCURRENCY. *** two simultaneous recommends of the same pair leave exactly one row', async () => {
      const item = await createDraftItem();
      await carehub.submitForReview(item.id, fixtures.adminId);
      await carehub.publish(item.id, fixtures.adminId);

      await Promise.all([
        repo.addRecommendationIfAbsent({ consultationId: fixtures.consultationId, contentItemId: item.id }),
        repo.addRecommendationIfAbsent({ consultationId: fixtures.consultationId, contentItemId: item.id }),
      ]);

      const rows = await repo.listRecommendationsForConsultation(fixtures.consultationId);
      expect(rows.filter((row) => row.contentItemId === item.id)).toHaveLength(1);
    });
  });
});
