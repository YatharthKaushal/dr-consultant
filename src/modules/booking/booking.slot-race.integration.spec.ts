/**
 * *** REAL-DATABASE TEST. Follows `document/patient-file.transaction.
 * integration.spec.ts`, which was written to be copied — see its header for
 * the four pattern rules this file obeys (one fixture helper, strict reverse-
 * FK teardown, per-run UUID namespacing, and a positive control). ***
 *
 * ── Why this cannot be a mocked test ───────────────────────────────────────
 *
 * `booking.service.ts` claims that when two patients book the SAME doctor at
 * the SAME instant, exactly one wins and the loser gets a clean 409 rather
 * than a 500. That claim rests entirely on a database object no mock can
 * stand in for: the PARTIAL UNIQUE INDEX
 * `consultations_doctor_slot_unique_idx` (`drizzle/0003_consultations_
 * double_booking_guard.sql`), which is unique on `(doctor_id,
 * scheduled_start_at)` only WHERE the status is one of the six occupying
 * ones.
 *
 * A unit test can assert that a simulated `23505` becomes a 409 — and
 * `booking.service.spec.ts` does. It cannot prove that Postgres actually
 * raises `23505` for this pair of concurrent inserts, that the index's
 * partial `WHERE` clause really does let a cancelled row share a slot, or
 * that `expired` really does free one. Those are facts about the migration,
 * not about the service, and only a real database can answer them.
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
import { patientsTable } from '../../schema/patients.schema';
import { paymentsTable } from '../../schema/payments.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { SLOT_OCCUPYING_STATUSES } from './booking.constants';
import { BookingRepository } from './booking.repository';

jest.setTimeout(30_000);

/** The one instant both racing bookings want. */
const CONTESTED_SLOT = new Date('2027-06-01T09:00:00.000Z');

interface Fixtures {
  runId: string;
  specialtyId: string;
  doctorId: string;
  patientAId: string;
  patientBId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `race_${runId}`, name: `Slot Race Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: `+9198${runId.slice(0, 6)}01`,
      fullName: `Slot Race Doctor ${runId}`,
      verificationStatus: 'verified',
    })
    .returning({ id: doctorsTable.id });

  // The `consultations_doctor_specialty_fk` composite FK means an assigned
  // doctor must actually practise the booked specialty — without this row
  // every insert below would fail for the wrong reason.
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [patientA] = await db
    .insert(patientsTable)
    .values({ mobileNumber: `+9198${runId.slice(0, 6)}02`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [patientB] = await db
    .insert(patientsTable)
    .values({ mobileNumber: `+9198${runId.slice(0, 6)}03`, status: 'active' })
    .returning({ id: patientsTable.id });

  return { runId, specialtyId: specialty.id, doctorId: doctor.id, patientAId: patientA.id, patientBId: patientB.id };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const ourConsultations = db
    .select({ id: consultationsTable.id })
    .from(consultationsTable)
    .where(eq(consultationsTable.doctorId, fixtures.doctorId));

  await db.delete(paymentsTable).where(inArray(paymentsTable.consultationId, ourConsultations));
  await db.execute(sql`delete from audit_log where consultation_id in (select id from consultations where doctor_id = ${fixtures.doctorId})`);
  await db.delete(consultationsTable).where(eq(consultationsTable.doctorId, fixtures.doctorId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(inArray(patientsTable.id, [fixtures.patientAId, fixtures.patientBId]));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/** Unwraps Drizzle's `DrizzleQueryError` to the underlying `pg` `DatabaseError`, which is where `code`/`constraint` actually live. */
function causeOf(error: unknown): Record<string, unknown> {
  const wrapped = error as { cause?: unknown };
  return (wrapped?.cause ?? error) as Record<string, unknown>;
}

describe('Slot race — the partial unique index is the authority (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let repo: BookingRepository;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);
    repo = new BookingRepository(db);
  });

  afterAll(async () => {
    if (db && fixtures) await teardown(db, fixtures);
    await disconnectDatabase();
  });

  /** Reads straight from Postgres, bypassing the repository — assertions must not trust the code under test. */
  async function countOccupyingAt(startsAt: Date): Promise<number> {
    const rows = await db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, fixtures.doctorId),
          eq(consultationsTable.scheduledStartAt, startsAt),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
        ),
      );
    return rows.length;
  }

  function bookingValues(patientId: string, startsAt: Date, status: 'pending_payment' | 'scheduled' = 'pending_payment') {
    return {
      referenceCode: `RACE-${randomUUID().slice(0, 16)}`,
      patientId,
      doctorId: fixtures.doctorId,
      specialtyId: fixtures.specialtyId,
      mode: 'scheduled' as const,
      status,
      scheduledStartAt: startsAt,
      durationMinutes: 30,
      holdExpiresAt: new Date(Date.now() + 20 * 60_000),
    };
  }

  it('TWO CONCURRENT BOOKINGS OF THE SAME SLOT: exactly one wins, and the loser fails with a real 23505', async () => {
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(0);

    // Both transactions are opened and both inserts are issued before either
    // is awaited, so they genuinely contend inside Postgres. The second one
    // BLOCKS on the unique index until the first commits, then fails — which
    // is precisely the production race.
    const attempt = (patientId: string) =>
      db.transaction(async (tx) => repo.insert(bookingValues(patientId, CONTESTED_SLOT), tx));

    const results = await Promise.allSettled([attempt(fixtures.patientAId), attempt(fixtures.patientBId)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // EXACTLY ONE WINNER.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // And the loser failed for the RIGHT reason — a genuine Postgres unique
    // violation from the partial index, which is what the service converts
    // into a 409 rather than letting it fall through as a 500.
    expect(isUniqueConstraintViolation(rejected[0].reason)).toBe(true);

    // And it was OUR index that refused it, not some other constraint.
    //
    // Read off `.cause`, not the top-level error: Drizzle 0.45 wraps the
    // driver error in a `DrizzleQueryError` whose message is the SQL text,
    // and hangs the real `pg` `DatabaseError` — the one carrying `code` and
    // `constraint` — underneath. That wrapping is exactly what
    // `isUniqueConstraintViolation` had to be taught to see through; see
    // `shared/errors/postgres-error.util.ts`.
    expect(causeOf(rejected[0].reason)).toMatchObject({
      code: '23505',
      constraint: 'consultations_doctor_slot_unique_idx',
    });

    // The database agrees: one occupying row, not two.
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(1);
  });

  it('a third sequential attempt on the now-taken slot is refused the same way', async () => {
    const error = await db
      .transaction(async (tx) => repo.insert(bookingValues(fixtures.patientBId, CONTESTED_SLOT), tx))
      .catch((e: unknown) => e);

    expect(isUniqueConstraintViolation(error)).toBe(true);
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(1);
  });

  it('CANCELLING frees the slot for rebooking — the index’s partial WHERE clause in action', async () => {
    const [held] = await db
      .select()
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, fixtures.doctorId),
          eq(consultationsTable.scheduledStartAt, CONTESTED_SLOT),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
        ),
      );
    expect(held).toBeDefined();

    await repo.updateStatusIfIn(held.id, ['pending_payment', 'scheduled'], {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledByParty: 'patient',
      holdExpiresAt: null,
    });

    // `cancelled` is not in the index's status list, so the slot is free —
    // and the cancelled row and the new one coexist at the same
    // (doctor, start) pair, which is exactly what the partial index allows.
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(0);

    const rebooked = await db.transaction(async (tx) =>
      repo.insert(bookingValues(fixtures.patientBId, CONTESTED_SLOT), tx),
    );
    expect(rebooked.id).toBeDefined();
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(1);
  });

  it('EXPIRING a hold frees the slot too — the abandoned-checkout path', async () => {
    const [held] = await db
      .select()
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, fixtures.doctorId),
          eq(consultationsTable.scheduledStartAt, CONTESTED_SLOT),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
        ),
      );
    expect(held).toBeDefined();

    await repo.updateStatusIfIn(held.id, ['pending_payment'], { status: 'expired', holdExpiresAt: null });
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(0);

    const rebooked = await db.transaction(async (tx) =>
      repo.insert(bookingValues(fixtures.patientAId, CONTESTED_SLOT), tx),
    );
    expect(rebooked.status).toBe('pending_payment');
    expect(await countOccupyingAt(CONTESTED_SLOT)).toBe(1);
  });

  it('POSITIVE CONTROL: a DIFFERENT time for the same doctor is not contended at all', async () => {
    // Without this, "exactly one insert succeeded" above could pass vacuously
    // because of something unrelated to the slot. Two different instants must
    // both succeed.
    const slotA = new Date('2027-06-01T11:00:00.000Z');
    const slotB = new Date('2027-06-01T11:30:00.000Z');

    const results = await Promise.allSettled([
      db.transaction(async (tx) => repo.insert(bookingValues(fixtures.patientAId, slotA), tx)),
      db.transaction(async (tx) => repo.insert(bookingValues(fixtures.patientBId, slotB), tx)),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await countOccupyingAt(slotA)).toBe(1);
    expect(await countOccupyingAt(slotB)).toBe(1);
  });

  it('the sweep’s candidate query finds an expired hold and reports it as Tier 1 when no gateway order exists', async () => {
    const alreadyExpired = new Date('2027-06-02T09:00:00.000Z');
    const created = await db.transaction(async (tx) =>
      repo.insert(
        { ...bookingValues(fixtures.patientAId, alreadyExpired), holdExpiresAt: new Date(Date.now() - 60_000) },
        tx,
      ),
    );

    const candidates = await repo.findExpiredHoldCandidates(new Date(), 100);
    const ours = candidates.find((candidate) => candidate.consultationId === created.id);

    expect(ours).toBeDefined();
    // No `payments` row was created, so the LEFT JOIN yields nulls — Tier 1,
    // released without any gateway call.
    expect(ours?.paymentId).toBeNull();
    expect(ours?.gatewayOrderId).toBeNull();
  });

  /**
   * The reschedule invariant, against the real constraint. `payments.
   * consultation_id` is UNIQUE and NOT NULL, so "move the payment across"
   * has to be an UPDATE — an INSERT would violate the unique index and a
   * second payment row would mean the patient was charged twice. Only a real
   * database can prove the UPDATE is actually permitted.
   */
  it('RESCHEDULE: the payment moves to the new consultation and the old slot is freed', async () => {
    const oldSlot = new Date('2027-07-01T09:00:00.000Z');
    const newSlot = new Date('2027-07-01T14:00:00.000Z');

    const original = await db.transaction(async (tx) =>
      repo.insert({ ...bookingValues(fixtures.patientAId, oldSlot, 'scheduled'), holdExpiresAt: null }, tx),
    );

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        consultationId: original.id,
        consultationFee: '750.00',
        convenienceFeePct: '5.00',
        convenienceFee: '37.50',
        gstPct: '18.00',
        gstAmount: '141.75',
        status: 'paid',
        gatewayOrderId: `order_itest_${fixtures.runId}`,
      })
      .returning({ id: paymentsTable.id });

    // Exactly the order `booking.service.ts#reschedule` uses: cancel the old
    // row FIRST (freeing its slot), then insert the replacement, then move
    // the payment.
    const replacement = await db.transaction(async (tx) => {
      await repo.updateStatusIfIn(
        original.id,
        ['scheduled'],
        { status: 'cancelled', cancelledAt: new Date(), cancelledByParty: 'patient', cancellationReason: 'Rescheduled', holdExpiresAt: null },
        tx,
      );
      const created = await repo.insert(
        {
          ...bookingValues(fixtures.patientAId, newSlot, 'scheduled'),
          holdExpiresAt: null,
          rescheduledFromConsultationId: original.id,
        },
        tx,
      );
      await repo.movePaymentToConsultation(payment.id, created.id, tx);
      return created;
    });

    // The link back is set.
    expect(replacement.rescheduledFromConsultationId).toBe(original.id);

    // ONE payment row, now pointing at the replacement — not two.
    const paymentsForBoth = await db
      .select({ id: paymentsTable.id, consultationId: paymentsTable.consultationId })
      .from(paymentsTable)
      .where(inArray(paymentsTable.consultationId, [original.id, replacement.id]));
    expect(paymentsForBoth).toHaveLength(1);
    expect(paymentsForBoth[0]).toMatchObject({ id: payment.id, consultationId: replacement.id });

    // The old slot is free and the new one is taken.
    expect(await countOccupyingAt(oldSlot)).toBe(0);
    expect(await countOccupyingAt(newSlot)).toBe(1);

    // And the freed old slot really can be re-booked by someone else.
    const rebooked = await db.transaction(async (tx) => repo.insert(bookingValues(fixtures.patientBId, oldSlot), tx));
    expect(rebooked.id).toBeDefined();
  });

  it('a live hold is NOT a sweep candidate', async () => {
    const future = new Date('2027-06-03T09:00:00.000Z');
    const created = await db.transaction(async (tx) =>
      repo.insert({ ...bookingValues(fixtures.patientBId, future), holdExpiresAt: new Date(Date.now() + 20 * 60_000) }, tx),
    );

    const candidates = await repo.findExpiredHoldCandidates(new Date(), 100);
    expect(candidates.some((candidate) => candidate.consultationId === created.id)).toBe(false);
  });
});
