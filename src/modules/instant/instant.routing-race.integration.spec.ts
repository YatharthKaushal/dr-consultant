/**
 * *** REAL-DATABASE TEST. Follows `booking/booking.slot-race.integration.spec
 * .ts`, which follows `document/patient-file.transaction.integration.spec.ts`
 * — one fixture helper, strict reverse-FK teardown, per-run UUID namespacing,
 * and a positive control on every claim. ***
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * Four of M-13's load-bearing claims are claims about DATABASE OBJECTS, not
 * about service code, and a `jest.fn()` cannot answer any of them:
 *
 *   1. `instant.repository.ts`: "the unique index on `(consultation_id,
 *      attempt_number)` is what stops two concurrent routers both offering
 *      attempt N". A unit test can assert that a SIMULATED `23505` becomes
 *      `already_pending` — `instant.service.spec.ts` does. Only Postgres can
 *      say that two genuinely concurrent inserts produce one.
 *
 *   2. `doctor-presence.service.ts`: "the lock and the legality check are in
 *      ONE transaction, which is the only way the guard is worth anything
 *      under concurrency". That is a statement about `SELECT ... FOR UPDATE`
 *      serialising two sessions, which no mock has.
 *
 *   3. `doctor.repository.ts#listInstantRoutingCandidates`: SIX predicates,
 *      one of which (`blocked_by_consultation_id IS NULL`) is FR-10.5's
 *      SECOND, independent enforcement point. A mocked candidate list proves
 *      nothing about the WHERE clause that is supposed to be the safety net.
 *
 *   4. The `onlyFrom` narrowing added by this review: `updatePresenceIfIn`
 *      builds an `inArray` over the `from` set, and the whole fix is that a
 *      narrower array really does refuse a row the wider one would have moved.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do, and fails loudly rather than skipping if the database is unreachable: a
 * silently-skipped concurrency test is worse than no test.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { instantConsultancyTable } from '../../schema/instant-consultancy.schema';
import { patientsTable } from '../../schema/patients.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { BookingRepository } from '../booking/booking.repository';
import { DoctorReliabilityService } from '../doctor/doctor-reliability.service';
import { DoctorRepository } from '../doctor/doctor.repository';
import { InstantRepository } from './instant.repository';
import { LEGAL_PRESENCE_TRANSITIONS, ROUTING_CANDIDATE_FETCH } from './instant.constants';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  otherSpecialtyId: string;
  patientId: string;
  /** The one doctor every positive control uses: verified, listed, available, un-gated, right specialty. */
  routableDoctorId: string;
  /** One doctor per reason routing must refuse them. */
  scheduledOnlyDoctorId: string;
  unverifiedDoctorId: string;
  unlistedDoctorId: string;
  gatedDoctorId: string;
  noInstantPermissionDoctorId: string;
  wrongSpecialtyDoctorId: string;
  /** The consultation the gated doctor is gated BY, and the one every attempt row hangs off. */
  consultationId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9197${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `inst_${runId}`, name: `Instant Routing Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });
  const [otherSpecialty] = await db
    .insert(specialtiesTable)
    .values({ code: `inst2_${runId}`, name: `Other Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });

  async function makeDoctor(
    label: string,
    overrides: Partial<typeof doctorsTable.$inferInsert>,
    specialtyId: string = specialty.id,
  ): Promise<string> {
    const [row] = await db
      .insert(doctorsTable)
      .values({
        mobileNumber: nextPhone(),
        fullName: `${label} ${runId}`,
        verificationStatus: 'verified',
        isListed: true,
        presence: 'available_now',
        allowInstantConsult: true,
        ...overrides,
      })
      .returning({ id: doctorsTable.id });
    await db.insert(doctorSpecialtiesTable).values({ doctorId: row.id, specialtyId });
    return row.id;
  }

  const routableDoctorId = await makeDoctor('Routable', {});
  const scheduledOnlyDoctorId = await makeDoctor('ScheduledOnly', { presence: 'scheduled_only' });
  const unverifiedDoctorId = await makeDoctor('Unverified', { verificationStatus: 'pending' });
  const unlistedDoctorId = await makeDoctor('Unlisted', { isListed: false });
  const gatedDoctorId = await makeDoctor('Gated', {});
  const noInstantPermissionDoctorId = await makeDoctor('NoPermission', { allowInstantConsult: false });
  const wrongSpecialtyDoctorId = await makeDoctor('WrongSpecialty', {}, otherSpecialty.id);

  // The consultation every attempt row hangs off. `mode: 'instant'` with no
  // doctor and no slot is exactly what `createInstantBooking` writes.
  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `INST-${randomUUID().slice(0, 16)}`,
      patientId: patient.id,
      doctorId: null,
      specialtyId: specialty.id,
      mode: 'instant',
      status: 'awaiting_doctor',
      scheduledStartAt: null,
      durationMinutes: 15,
      holdExpiresAt: null,
    })
    .returning({ id: consultationsTable.id });

  // *** THE COMPLETION GATE, as a real column value. ***
  await db
    .update(doctorsTable)
    .set({ blockedByConsultationId: consultation.id })
    .where(eq(doctorsTable.id, gatedDoctorId));

  return {
    runId,
    specialtyId: specialty.id,
    otherSpecialtyId: otherSpecialty.id,
    patientId: patient.id,
    routableDoctorId,
    scheduledOnlyDoctorId,
    unverifiedDoctorId,
    unlistedDoctorId,
    gatedDoctorId,
    noInstantPermissionDoctorId,
    wrongSpecialtyDoctorId,
    consultationId: consultation.id,
  };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const doctorIds = [
    fixtures.routableDoctorId,
    fixtures.scheduledOnlyDoctorId,
    fixtures.unverifiedDoctorId,
    fixtures.unlistedDoctorId,
    fixtures.gatedDoctorId,
    fixtures.noInstantPermissionDoctorId,
    fixtures.wrongSpecialtyDoctorId,
  ];

  // `blocked_by_consultation_id` is an FK to the consultation about to go.
  await db.update(doctorsTable).set({ blockedByConsultationId: null }).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(instantConsultancyTable).where(inArray(instantConsultancyTable.doctorId, doctorIds));
  await db.execute(sql`delete from audit_log where consultation_id = ${fixtures.consultationId}`);
  await db.delete(consultationsTable).where(eq(consultationsTable.patientId, fixtures.patientId));
  await db.delete(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, doctorIds));
  await db.delete(doctorsTable).where(inArray(doctorsTable.id, doctorIds));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db
    .delete(specialtiesTable)
    .where(inArray(specialtiesTable.id, [fixtures.specialtyId, fixtures.otherSpecialtyId]));
}

/** Unwraps Drizzle's `DrizzleQueryError` to the underlying `pg` `DatabaseError`, which is where `code`/`constraint` actually live. */
function causeOf(error: unknown): Record<string, unknown> {
  const wrapped = error as { cause?: unknown };
  return (wrapped?.cause ?? error) as Record<string, unknown>;
}

describe('Instant routing — the index, the row lock and the candidate WHERE clause (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let instantRepo: InstantRepository;
  let doctorRepo: DoctorRepository;
  let bookingRepo: BookingRepository;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);
    instantRepo = new InstantRepository(db);
    doctorRepo = new DoctorRepository(db);
    bookingRepo = new BookingRepository(db);
  });

  /** See `booking.slot-race.integration.spec.ts` for why the disconnect is in a `finally`. */
  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      await disconnectDatabase();
    }
  });

  /** Reads straight from Postgres, bypassing the code under test. */
  async function presenceOf(doctorId: string): Promise<string> {
    const [row] = await db.select({ presence: doctorsTable.presence }).from(doctorsTable).where(eq(doctorsTable.id, doctorId));
    return row.presence;
  }

  async function setPresence(doctorId: string, presence: typeof doctorsTable.$inferInsert.presence): Promise<void> {
    await db.update(doctorsTable).set({ presence }).where(eq(doctorsTable.id, doctorId));
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 1. Two routers, one attempt number
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the unique index on (consultation_id, attempt_number)', () => {
    it('*** LETS EXACTLY ONE OF TWO CONCURRENT ROUTERS OFFER ATTEMPT N *** — the loser takes a real 23505', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const attemptNumber = 1;

      const results = await Promise.allSettled([
        instantRepo.insertAttempt({
          consultationId: fixtures.consultationId,
          doctorId: fixtures.routableDoctorId,
          attemptNumber,
          expiresAt,
        }),
        instantRepo.insertAttempt({
          consultationId: fixtures.consultationId,
          // A DIFFERENT doctor — the collision is on the attempt number, not
          // the doctor, which is precisely the race the router describes.
          doctorId: fixtures.scheduledOnlyDoctorId,
          attemptNumber,
          expiresAt,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser's error must be one `instant.service.ts` recognises, or it
      // rethrows instead of reporting `already_pending`.
      expect(isUniqueConstraintViolation(rejected[0].reason)).toBe(true);
      expect(causeOf(rejected[0].reason).code).toBe('23505');

      const rows = await db
        .select({ id: instantConsultancyTable.id })
        .from(instantConsultancyTable)
        .where(
          and(
            eq(instantConsultancyTable.consultationId, fixtures.consultationId),
            eq(instantConsultancyTable.attemptNumber, attemptNumber),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it('POSITIVE CONTROL: a different attempt number on the same consultation is not contended at all', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      await expect(
        instantRepo.insertAttempt({
          consultationId: fixtures.consultationId,
          doctorId: fixtures.unlistedDoctorId,
          attemptNumber: 2,
          expiresAt,
        }),
      ).resolves.toMatchObject({ attemptNumber: 2 });
    });

    it('the SAME doctor can be offered the SAME consultation twice at the database level — nothing but the router stops it', async () => {
      // Written down as a fact about the schema, not as an endorsement: the
      // unique index is on `(consultation_id, attempt_number)` and NOT on
      // `(consultation_id, doctor_id)`, so "never re-offer a doctor" is
      // enforced ONLY by `getRoutingState().triedDoctorIds` feeding
      // `excludeDoctorIds`. The next test proves that half.
      await expect(
        instantRepo.insertAttempt({
          consultationId: fixtures.consultationId,
          doctorId: fixtures.routableDoctorId,
          attemptNumber: 3,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).resolves.toMatchObject({ attemptNumber: 3 });
    });

    it('getRoutingState reports every doctor already tried, whatever the outcome — so a declined doctor is never re-offered', async () => {
      await db
        .update(instantConsultancyTable)
        .set({ outcome: 'declined' })
        .where(
          and(
            eq(instantConsultancyTable.consultationId, fixtures.consultationId),
            eq(instantConsultancyTable.attemptNumber, 1),
          ),
        );

      const state = await instantRepo.getRoutingState(fixtures.consultationId);

      expect(state.lastAttemptNumber).toBe(3);
      // Distinct, and includes the DECLINED doctor: that list becomes
      // `excludeDoctorIds` on the very next candidate query.
      expect(new Set(state.triedDoctorIds)).toEqual(
        new Set([fixtures.routableDoctorId, fixtures.unlistedDoctorId]),
      );

      const candidates = await doctorRepo.listInstantRoutingCandidates({
        specialtyId: fixtures.specialtyId,
        excludeDoctorIds: state.triedDoctorIds,
        limit: ROUTING_CANDIDATE_FETCH,
      });
      expect(candidates.map((row) => row.id)).not.toContain(fixtures.routableDoctorId);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. The candidate WHERE clause — FR-10.3 and FR-10.5's second enforcement
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('listInstantRoutingCandidates', () => {
    it('*** REFUSES EVERY INELIGIBLE DOCTOR, AND RETURNS THE ONE ELIGIBLE ONE *** — six predicates, against real SQL', async () => {
      const candidates = await doctorRepo.listInstantRoutingCandidates({
        specialtyId: fixtures.specialtyId,
        limit: 50,
      });
      const ids = candidates.map((row) => row.id);

      // POSITIVE CONTROL first: if this ever stops being true the negatives
      // below are all vacuously green.
      expect(ids).toContain(fixtures.routableDoctorId);

      // FR-10.3: "stays bookable by slot but receives no instant requests".
      expect(ids).not.toContain(fixtures.scheduledOnlyDoctorId);
      expect(ids).not.toContain(fixtures.unverifiedDoctorId);
      expect(ids).not.toContain(fixtures.unlistedDoctorId);
      // *** FR-10.5's SECOND, INDEPENDENT ENFORCEMENT POINT. *** This doctor
      // is `available_now`, verified, listed, permitted and practises the
      // specialty. The gate alone keeps them out.
      expect(ids).not.toContain(fixtures.gatedDoctorId);
      expect(ids).not.toContain(fixtures.noInstantPermissionDoctorId);
      expect(ids).not.toContain(fixtures.wrongSpecialtyDoctorId);
    });

    it('a doctor who is paused or offline is not a candidate either — only available_now routes', async () => {
      await setPresence(fixtures.routableDoctorId, 'paused');
      let ids = (await doctorRepo.listInstantRoutingCandidates({ specialtyId: fixtures.specialtyId, limit: 50 })).map((r) => r.id);
      expect(ids).not.toContain(fixtures.routableDoctorId);

      await setPresence(fixtures.routableDoctorId, 'offline');
      ids = (await doctorRepo.listInstantRoutingCandidates({ specialtyId: fixtures.specialtyId, limit: 50 })).map((r) => r.id);
      expect(ids).not.toContain(fixtures.routableDoctorId);

      await setPresence(fixtures.routableDoctorId, 'available_now');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. Two routers, one doctor
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the doctor row lock', () => {
    it('*** LETS EXACTLY ONE OF TWO CONCURRENT REQUESTS RESERVE THE SAME DOCTOR *** — FOR UPDATE plus a guarded UPDATE', async () => {
      await setPresence(fixtures.routableDoctorId, 'available_now');

      /** One router's reservation, exactly as `DoctorPresenceService#transitionPresence` shapes it. */
      const reserve = () =>
        db.transaction(async (tx) => {
          const locked = await doctorRepo.findByIdForUpdate(fixtures.routableDoctorId, tx);
          if (!locked) return false;
          const updated = await doctorRepo.updatePresenceIfIn(
            fixtures.routableDoctorId,
            LEGAL_PRESENCE_TRANSITIONS.request_pending,
            'request_pending',
            { requireNotGated: true },
            tx,
          );
          return updated !== null;
        });

      const [a, b] = await Promise.all([reserve(), reserve()]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await presenceOf(fixtures.routableDoctorId)).toBe('request_pending');
    });

    it('*** A GATED DOCTOR CANNOT BE RESERVED, WHATEVER THEIR PRESENCE SAYS *** — requireNotGated is a predicate in the UPDATE', async () => {
      await setPresence(fixtures.gatedDoctorId, 'available_now');

      const updated = await doctorRepo.updatePresenceIfIn(
        fixtures.gatedDoctorId,
        LEGAL_PRESENCE_TRANSITIONS.request_pending,
        'request_pending',
        { requireNotGated: true },
      );

      expect(updated).toBeNull();
      expect(await presenceOf(fixtures.gatedDoctorId)).toBe('available_now');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. The `onlyFrom` narrowing this review added
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('a system release must not force-write available_now', () => {
    /**
     * DEFECT, at the SQL level. `available_now`'s legal `from` set contains
     * `offline`, `paused` and `scheduled_only`, so the acceptance sweep giving
     * a doctor back after a timeout moved them out of a state THEY had chosen.
     * The scenario needs no infrastructure failure: `paused` is legal, and
     * self-settable, from `request_pending`.
     */
    it('the WIDE legal from-set really would drag a PAUSED doctor back into the pool — this is the bug', async () => {
      await setPresence(fixtures.routableDoctorId, 'paused');

      const updated = await doctorRepo.updatePresenceIfIn(
        fixtures.routableDoctorId,
        LEGAL_PRESENCE_TRANSITIONS.available_now,
        'available_now',
        { requireNotGated: true },
      );

      expect(updated).not.toBeNull();
      expect(await presenceOf(fixtures.routableDoctorId)).toBe('available_now');
    });

    it('the NARROWED from-set leaves them exactly where they put themselves — this is the fix', async () => {
      await setPresence(fixtures.routableDoctorId, 'paused');

      const updated = await doctorRepo.updatePresenceIfIn(
        fixtures.routableDoctorId,
        // What `onlyFrom: ['request_pending']` intersects down to.
        ['request_pending'],
        'available_now',
        { requireNotGated: true },
      );

      expect(updated).toBeNull();
      expect(await presenceOf(fixtures.routableDoctorId)).toBe('paused');

      // POSITIVE CONTROL: the same narrowed set DOES release a doctor who is
      // genuinely still holding the offer.
      await setPresence(fixtures.routableDoctorId, 'request_pending');
      await expect(
        doctorRepo.updatePresenceIfIn(fixtures.routableDoctorId, ['request_pending'], 'available_now', { requireNotGated: true }),
      ).resolves.not.toBeNull();
      expect(await presenceOf(fixtures.routableDoctorId)).toBe('available_now');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. Sweep 3's candidate query
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('listStaleAwaitingDoctorRequests — the stranded-request sweep', () => {
    /**
     * The consultation this suite seeded is `awaiting_doctor` with NO
     * `hold_expires_at`, which is exactly the shape that was invisible to
     * every sweep in the system before this query existed.
     */
    it('*** FINDS A CONSULTATION NO OTHER SWEEP CAN SEE *** — awaiting_doctor, no hold, no pending attempt', async () => {
      // Nothing driven off a hold can see it.
      expect(await bookingRepo.listExpiredInstantHolds(new Date(Date.now() + 3_600_000), 100)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ consultationId: fixtures.consultationId })]),
      );
      expect(await bookingRepo.findExpiredHoldCandidates(new Date(Date.now() + 3_600_000), 100)).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ consultationId: fixtures.consultationId })]),
      );

      const stale = await bookingRepo.listStaleAwaitingDoctorRequests(new Date(Date.now() + 3_600_000), 100);
      expect(stale.map((row) => row.consultationId)).toContain(fixtures.consultationId);
    });

    it('leaves a request that has only just started routing alone', async () => {
      const stale = await bookingRepo.listStaleAwaitingDoctorRequests(new Date(Date.now() - 3_600_000), 100);
      expect(stale.map((row) => row.consultationId)).not.toContain(fixtures.consultationId);
    });

    it('ignores a consultation that has already moved on', async () => {
      await db
        .update(consultationsTable)
        .set({ status: 'expired' })
        .where(eq(consultationsTable.id, fixtures.consultationId));

      const stale = await bookingRepo.listStaleAwaitingDoctorRequests(new Date(Date.now() + 3_600_000), 100);
      expect(stale.map((row) => row.consultationId)).not.toContain(fixtures.consultationId);

      await db
        .update(consultationsTable)
        .set({ status: 'awaiting_doctor' })
        .where(eq(consultationsTable.id, fixtures.consultationId));
    });
  });
  /* ═══════════════════════════════════════════════════════════════════════
   * 6. FR-18.6's acceptance rate, against the rows that actually feed it
   * ═══════════════════════════════════════════════════════════════════════ */

  describe('the FR-18.6 acceptance rate', () => {
    /**
     * DEFECT. The denominator was `count(*)` over every `instant_consultancy`
     * row for the doctor, so it counted two outcomes that say nothing about
     * them: `superseded` (the request stopped being routable — the patient
     * cancelled) and `pending` (an offer that is on their screen right now).
     *
     * `supersedePendingAttempts` exists precisely so a patient's cancellation
     * is NOT written down as `declined` ("which the doctor did not do") or
     * `timed_out` ("which is not what happened") — and then the metric put it
     * in the denominator anyway, so the distinction bought the doctor nothing.
     *
     * Only real SQL can answer this: the unit spec mocks the row the query
     * returns, so it can prove the arithmetic and not the WHERE clause.
     */
    it('*** COUNTS ONLY THE OFFERS THE DOCTOR COULD HAVE ANSWERED *** — superseded and pending are not failures', async () => {
      const reliability = new DoctorReliabilityService(db, doctorRepo);
      const expiresAt = new Date(Date.now() + 60_000);

      // A clean doctor with a hand-built history: 1 accepted, 1 declined,
      // 1 timed out, plus 1 superseded and 1 still pending.
      await db.delete(instantConsultancyTable).where(eq(instantConsultancyTable.doctorId, fixtures.unverifiedDoctorId));
      let attemptNumber = 10;
      for (const outcome of ['accepted', 'declined', 'timed_out', 'superseded', 'pending'] as const) {
        await db.insert(instantConsultancyTable).values({
          consultationId: fixtures.consultationId,
          doctorId: fixtures.unverifiedDoctorId,
          attemptNumber: attemptNumber++,
          outcome,
          expiresAt,
        });
      }

      const metrics = await reliability.getMetrics(fixtures.unverifiedDoctorId);

      // 1 accepted out of 3 answerable. The old `count(*)` denominator was 5,
      // which would have reported 0.2 — a doctor punished for a patient's
      // change of mind and for an offer they are still looking at.
      expect(metrics.acceptanceRate).toBeCloseTo(1 / 3, 10);
    });

    it('reports null rather than 0 when every row is one the doctor never got to answer', async () => {
      const reliability = new DoctorReliabilityService(db, doctorRepo);
      await db.delete(instantConsultancyTable).where(eq(instantConsultancyTable.doctorId, fixtures.unverifiedDoctorId));
      await db.insert(instantConsultancyTable).values({
        consultationId: fixtures.consultationId,
        doctorId: fixtures.unverifiedDoctorId,
        attemptNumber: 20,
        outcome: 'superseded',
        expiresAt: new Date(Date.now() + 60_000),
      });

      // "No data yet" is a different fact from "0% reliable" — and one
      // superseded offer is no data.
      await expect(reliability.getMetrics(fixtures.unverifiedDoctorId)).resolves.toMatchObject({ acceptanceRate: null });
    });
  });
});
