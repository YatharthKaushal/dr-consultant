/**
 * *** REAL-DATABASE TEST. *** Follows `carehub.integration.spec.ts` /
 * `clinical.completion-gate.integration.spec.ts` — one fixture helper,
 * strict reverse-FK teardown, per-run UUID/code namespacing.
 *
 * `feedback.service.spec.ts`/`complaint.service.spec.ts` mock
 * `FeedbackRepository`/`ComplaintRepository`/`BookingFacade` entirely,
 * which proves the RULES (ownership check shape, the state machine's `from`
 * status, message filtering) but nothing about whether those rules survive
 * real SQL. Four claims specifically need Postgres and cannot be proven any
 * other way:
 *
 *   1. *** THE UNIQUE INDEX. *** `feedback_consultation_id_index` is what
 *      actually turns a second submission for the same consultation into a
 *      409, not just a mocked `create` rejecting on cue.
 *   2. *** THE RATING CHECK CONSTRAINT. *** `feedback_rating_range_check`
 *      really refuses a rating outside 1-5 at the database, a second line
 *      of defence behind the DTO's own `@Min`/`@Max`.
 *   3. *** THE GUARDED STATE-MACHINE UPDATE. *** `assignComplaint`/
 *      `resolveComplaint`/`rejectComplaint`'s `WHERE status = <from>` really
 *      does refuse an illegal move and really does persist `resolvedAt`
 *      (and only on `resolved`) on exactly the row it targets.
 *   4. *** THE OWNERSHIP CHECK, END TO END. *** `BookingFacade.getBooking`
 *      reading a REAL `consultations` row is what both write paths' 404s
 *      actually depend on.
 *
 * ── What is real here and what is not ──────────────────────────────────
 *
 * Real: the database, `FeedbackRepository`, `ComplaintRepository`,
 * `AuditService`, `BookingRepository` + `toBookingView` (M-11's own read
 * path).
 *
 * Not constructed: the rest of `BookingService`'s collaborators (payment
 * gateway, availability, etc.) — this module only ever calls
 * `BookingFacade.getBooking`, which is exactly `BookingRepository.findById`
 * + `toBookingView` (verified by reading `booking.facade.ts`), so a plain
 * object exposing just that one method, built from the real repository and
 * the real mapper, is the real read path with none of write-side M-11
 * constructed for no reason — `carehub.integration.spec.ts`'s own
 * restraint, applied here.
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
import { complaintsTable } from '../../schema/complaints.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { feedbackTable } from '../../schema/feedback.schema';
import { patientsTable } from '../../schema/patients.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import { toBookingView } from '../booking/booking.mapper';
import { BookingRepository } from '../booking/booking.repository';
import { COMPLAINT_ERROR_CODES, FEEDBACK_ERROR_CODES } from './feedback.constants';
import { ComplaintRepository } from './complaint.repository';
import { ComplaintService } from './complaint.service';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  otherPatientId: string;
  doctorId: string;
  adminId: string;
  consultationId: string;
  otherPatientConsultationId: string;
  ratingCheckConsultationId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9198${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `feedback_${runId}`, name: `Feedback Test Specialty ${runId}`, canPrescribe: false })
    .returning({ id: specialtiesTable.id });
  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });
  const [otherPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });
  const [doctor] = await db
    .insert(doctorsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Feedback Doctor ${runId}`, verificationStatus: 'verified', isListed: true })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id, isPrimary: true });

  async function makeConsultation(patientRowId: string, refSuffix: string): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `FB-${runId}-${refSuffix}`,
        patientId: patientRowId,
        doctorId: doctor.id,
        specialtyId: specialty.id,
        mode: 'scheduled',
        status: 'completed',
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }
  const consultationId = await makeConsultation(patient.id, '1');
  const otherPatientConsultationId = await makeConsultation(otherPatient.id, '2');
  const ratingCheckConsultationId = await makeConsultation(patient.id, '3');

  // `assigned_to_admin_id` FKs to `admins.id`, so the workflow tests below
  // need a real admin row for `assignComplaint` to satisfy the constraint.
  const [admin] = await db
    .insert(adminsTable)
    .values({ mobileNumber: nextPhone(), fullName: `Feedback Admin ${runId}` })
    .returning({ id: adminsTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    otherPatientId: otherPatient.id,
    doctorId: doctor.id,
    adminId: admin.id,
    consultationId,
    otherPatientConsultationId,
    ratingCheckConsultationId,
  };
}

/** Unwraps Drizzle's `DrizzleQueryError` to the underlying `pg` `DatabaseError`, which is where `code`/`constraint` actually live — `booking.slot-race.integration.spec.ts`'s helper. */
function causeOf(error: unknown): Record<string, unknown> {
  const wrapped = error as { cause?: unknown };
  return (wrapped?.cause ?? error) as Record<string, unknown>;
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const consultationIds = [fixtures.consultationId, fixtures.otherPatientConsultationId, fixtures.ratingCheckConsultationId];
  const patientIds = [fixtures.patientId, fixtures.otherPatientId];

  await db.delete(feedbackTable).where(inArray(feedbackTable.consultationId, consultationIds));
  await db.delete(complaintsTable).where(inArray(complaintsTable.patientId, patientIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.consultationId, consultationIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
  await db.delete(adminsTable).where(eq(adminsTable.id, fixtures.adminId));
}

describe('M-19 Feedback and Complaints, against a real database', () => {
  let db: Database;
  let fixtures: Fixtures;
  let feedback: FeedbackService;
  let complaints: ComplaintService;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    const audit = new AuditService(db);

    // *** THE REAL M-11 READ PATH, NOTHING ELSE OF BOOKING CONSTRUCTED. ***
    // See this file's own header for why this is faithful rather than a stub.
    const bookingRepo = new BookingRepository(db);
    const bookings: Pick<BookingFacade, 'getBooking'> = {
      getBooking: async (consultationId: string) => {
        const row = await bookingRepo.findById(consultationId);
        return row ? toBookingView(row) : null;
      },
    };

    feedback = new FeedbackService(new FeedbackRepository(db), bookings as BookingFacade, audit);
    complaints = new ComplaintService(db, new ComplaintRepository(db), bookings as BookingFacade, audit);
  });

  afterAll(async () => {
    await teardown(db, fixtures);
    await disconnectDatabase();
  });

  describe('post-consult feedback', () => {
    it('submits once, reads it back, and a second submission for the same consultation is refused 409 — the real UNIQUE index', async () => {
      const submitted = await feedback.submitFeedback(fixtures.consultationId, fixtures.patientId, {
        rating: 5,
        comment: 'Excellent, on time.',
      });
      expect(submitted.rating).toBe(5);

      const readBack = await feedback.getOwnFeedback(fixtures.consultationId, fixtures.patientId);
      expect(readBack?.id).toBe(submitted.id);

      await expect(feedback.submitFeedback(fixtures.consultationId, fixtures.patientId, { rating: 3 })).rejects.toMatchObject({
        response: { code: FEEDBACK_ERROR_CODES.ALREADY_SUBMITTED },
      });
    });

    it('a stranger to the consultation gets the same 404 as a nonexistent one — real BookingFacade.getBooking', async () => {
      await expect(
        feedback.submitFeedback(fixtures.otherPatientConsultationId, fixtures.patientId, { rating: 4 }),
      ).rejects.toMatchObject({ response: { code: FEEDBACK_ERROR_CODES.CONSULTATION_NOT_FOUND } });

      await expect(feedback.submitFeedback(randomUUID(), fixtures.patientId, { rating: 4 })).rejects.toMatchObject({
        response: { code: FEEDBACK_ERROR_CODES.CONSULTATION_NOT_FOUND },
      });
    });

    it('the admin list surfaces the submitted row, filterable by rating', async () => {
      const results = await feedback.listForAdmin({ rating: 5, limit: 50, offset: 0 });
      expect(results.some((r) => r.consultationId === fixtures.consultationId)).toBe(true);
    });

    it('feedback_rating_range_check refuses an out-of-range rating at the database — a second line of defence behind the DTO', async () => {
      // The DTO's own `@Min`/`@Max` (`SubmitFeedbackDto`) would normally
      // catch this before it ever reaches the service; calling the service
      // directly, as this suite does throughout, bypasses that pipe and
      // proves the CHECK constraint holds on its own.
      //
      // Read off `.cause`, not the top-level error — Drizzle 0.45 wraps the
      // driver error in a `DrizzleQueryError`; the real `pg` `DatabaseError`
      // carrying `code`/`constraint` hangs off `.cause`. See
      // `shared/errors/postgres-error.util.ts`'s header for the full story.
      let caught: unknown;
      try {
        await feedback.submitFeedback(fixtures.ratingCheckConsultationId, fixtures.patientId, { rating: 99 });
      } catch (error) {
        caught = error;
      }
      expect(causeOf(caught)).toMatchObject({ code: '23514', constraint: 'feedback_rating_range_check' });
    });
  });

  describe('complaints: raising, ownership, and the workflow against the real guarded UPDATE', () => {
    it('raises a complaint tied to a real consultation, and a stranger gets the ownership 404', async () => {
      await expect(
        complaints.raiseComplaint(fixtures.patientId, {
          category: 'doctor_conduct',
          subject: 'Late arrival',
          description: 'Doctor joined 20 minutes late.',
          consultationId: fixtures.otherPatientConsultationId,
        }),
      ).rejects.toMatchObject({ response: { code: COMPLAINT_ERROR_CODES.CONSULTATION_NOT_FOUND } });

      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'doctor_conduct',
        subject: 'Late arrival',
        description: 'Doctor joined 20 minutes late.',
        consultationId: fixtures.consultationId,
      });
      expect(raised.status).toBe('open');
      expect(raised.referenceCode).toMatch(/^CMP-/);

      const [row] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, raised.id));
      expect(row!.referenceCode).toBe(raised.referenceCode);
    });

    it('raises a complaint with no consultation at all — a real, valid case', async () => {
      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'other',
        subject: 'App keeps crashing',
        description: 'The app crashes on the booking screen.',
      });
      expect(raised.consultationId).toBeNull();
    });

    it('walks open -> in_progress -> resolved, and resolvedAt really persists on exactly that move', async () => {
      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'payment_issue',
        subject: 'Refund missing',
        description: 'Refund never arrived.',
      });

      const assigned = await complaints.assignComplaint(raised.id, fixtures.adminId, fixtures.adminId);
      expect(assigned.status).toBe('in_progress');
      expect(assigned.assignedToAdminId).toBe(fixtures.adminId);

      const resolved = await complaints.resolveComplaint(raised.id, fixtures.adminId, { resolutionNote: 'Refund reissued.' });
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedAt).not.toBeNull();

      const [row] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, raised.id));
      expect(row!.status).toBe('resolved');
      expect(row!.resolvedAt).not.toBeNull();
    });

    it('reject leaves resolvedAt null, at the row — rejected is not resolved', async () => {
      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'consultation_quality',
        subject: 'Unclear advice',
        description: 'Advice was contradictory.',
      });
      await complaints.assignComplaint(raised.id, fixtures.adminId, fixtures.adminId);
      const rejected = await complaints.rejectComplaint(raised.id, fixtures.adminId, { resolutionNote: 'No fault found on review.' });

      expect(rejected.status).toBe('rejected');
      expect(rejected.resolvedAt).toBeNull();

      const [row] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, raised.id));
      expect(row!.status).toBe('rejected');
      expect(row!.resolvedAt).toBeNull();
    });

    it('the guarded UPDATE really refuses resolving a still-open complaint', async () => {
      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'other',
        subject: 'Still open',
        description: 'Never assigned.',
      });

      await expect(complaints.resolveComplaint(raised.id, fixtures.adminId, { resolutionNote: 'x' })).rejects.toMatchObject({
        response: { code: COMPLAINT_ERROR_CODES.ILLEGAL_TRANSITION },
      });

      const [row] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, raised.id));
      expect(row!.status).toBe('open');
    });

    it('the message thread round-trips through real jsonb, and an internal note is invisible on the patient view', async () => {
      const raised = await complaints.raiseComplaint(fixtures.patientId, {
        category: 'other',
        subject: 'Thread test',
        description: 'Testing the message thread.',
      });

      await complaints.addPatientMessage(raised.id, fixtures.patientId, { body: 'Any update?' });
      await complaints.addAdminMessage(raised.id, fixtures.adminId, { body: 'Looking into it', isInternal: false });
      await complaints.addAdminMessage(raised.id, fixtures.adminId, { body: 'Escalate to finance', isInternal: true });

      const patientView = await complaints.getOwnComplaint(raised.id, fixtures.patientId);
      expect(patientView.messages.map((m) => m.body)).toEqual(['Any update?', 'Looking into it']);

      const adminView = await complaints.getForAdmin(raised.id);
      expect(adminView.messages).toHaveLength(3);
    });
  });

  describe('the M-20 seam', () => {
    it('countComplaintsByStatus fills every status, real GROUP BY behind it', async () => {
      const counts = await complaints.countComplaintsByStatus();

      expect(Object.keys(counts).sort()).toEqual(['in_progress', 'open', 'rejected', 'resolved'].sort());
      for (const value of Object.values(counts)) {
        expect(typeof value).toBe('number');
      }
      // At least the rows this suite itself created.
      expect(counts.resolved).toBeGreaterThanOrEqual(1);
      expect(counts.rejected).toBeGreaterThanOrEqual(1);
    });
  });
});
