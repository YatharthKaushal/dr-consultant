/**
 * *** REAL-DATABASE TEST. THIS FILE IS THE MODULE'S CORRECTNESS CLAIM. ***
 *
 * Follows `booking/booking.slot-race.integration.spec.ts`, which follows
 * `document/patient-file.transaction.integration.spec.ts` — see the latter's
 * header for the four pattern rules this file obeys (one fixture helper, strict
 * reverse-FK teardown, per-run UUID namespacing, and a positive control).
 *
 * ── THE CLAIM ─────────────────────────────────────────────────────────────
 *
 * *** A CAPPED COUPON CANNOT BE OVER-REDEEMED UNDER CONCURRENT CHECKOUT. ***
 *
 * `discount-instruments.schema.ts` is explicit that there is deliberately NO
 * `redeemed_count` column, because "a denormalised counter is a second source of
 * truth that drifts from the redemption rows, silently and unrecoverably".
 * Instead every cap is answered by a COUNT taken under the instrument's
 * `SELECT ... FOR UPDATE` — the same decision `RefundService` makes for the
 * refund ceiling, for the same stated reason: a CHECK constraint sees one row and
 * a unique index cannot express a sum.
 *
 * ── WHY THIS CANNOT BE A MOCKED TEST ──────────────────────────────────────
 *
 * The claim rests entirely on database objects no mock can stand in for:
 *
 *   - `SELECT ... FOR UPDATE` actually SERIALISING two transactions on one row.
 *     A mocked repository returns whatever it is told to; it cannot demonstrate
 *     that Postgres makes the second caller BLOCK until the first commits and
 *     then read a count that already includes it. Without that, both callers
 *     read the same stale count, both pass, and the cap is exceeded by one.
 *   - The three PARTIAL UNIQUE INDEXES that back the checks:
 *     `discount_redemptions_live_consultation_unique_idx` (no stacking),
 *     `discount_redemptions_single_use_per_user_idx` (one per customer) and
 *     `referral_events_referee_once_idx` (referred once, ever). A unit test can
 *     assert that a simulated `23505` maps to the right refusal — and
 *     `promotion.service.spec.ts` does. It cannot prove Postgres raises `23505`
 *     for these inserts, nor that the partial `WHERE` clauses really do let a
 *     `released` row coexist with a new `reserved` one.
 *
 * Those are facts about the migration, not about the service, and only a real
 * database can answer them.
 *
 * ── REQUIRES A REACHABLE POSTGRES ─────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts do,
 * and fails loudly rather than skipping if the database is unreachable: a
 * silently-skipped concurrency test is worse than no test.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { consultationsTable } from '../../schema/consultations.schema';
import { discountInstrumentsTable } from '../../schema/discount-instruments.schema';
import { discountRedemptionsTable } from '../../schema/discount-redemptions.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { promotionCodeAttemptsTable } from '../../schema/promotion-code-attempts.schema';
import { referralEventsTable } from '../../schema/referral-events.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AffiliateRepository } from './affiliate.repository';
import { AffiliateService } from './affiliate.service';
import { PromotionConfigRepository } from './promotion-config.repository';
import { PromotionConfigService } from './promotion-config.service';
import { PromotionRepository } from './promotion.repository';
import { PromotionService } from './promotion.service';
import { ReferralRepository } from './referral.repository';
import { UnavailablePromotionBookingLookupProvider } from './unavailable-promotion-booking-lookup.provider';
import { PROMOTION_INDEXES } from './promotion.constants';
import type { DiscountOrderContext } from './promotion.contract';

jest.setTimeout(60_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  doctorId: string;
  patientIds: string[];
}

/** Enough patients that a per-patient throttle (20/hour) can never be the reason a test failed. */
const PATIENT_COUNT = 12;

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `promo_${runId}`, name: `Promo Race Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: `+9197${runId.slice(0, 6)}00`,
      fullName: `Promo Race Doctor ${runId}`,
      verificationStatus: 'verified',
    })
    .returning({ id: doctorsTable.id });

  // The `consultations_doctor_specialty_fk` composite FK means an assigned
  // doctor must actually practise the booked specialty — without this row every
  // consultation insert below would fail for the wrong reason.
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const patientIds: string[] = [];
  for (let index = 0; index < PATIENT_COUNT; index += 1) {
    const [patient] = await db
      .insert(patientsTable)
      .values({ mobileNumber: `+9197${runId.slice(0, 6)}${String(index + 10).padStart(2, '0')}`, status: 'active' })
      .returning({ id: patientsTable.id });
    patientIds.push(patient.id);
  }

  return { runId, specialtyId: specialty.id, doctorId: doctor.id, patientIds };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const ourConsultations = db
    .select({ id: consultationsTable.id })
    .from(consultationsTable)
    .where(eq(consultationsTable.doctorId, fixtures.doctorId));

  const ourInstruments = db
    .select({ id: discountInstrumentsTable.id })
    .from(discountInstrumentsTable)
    .where(sql`${discountInstrumentsTable.code} like ${'ZZ' + fixtures.runId.toUpperCase() + '%'}`);

  // `referral_events` -> `discount_redemptions` -> `discount_instruments`, and
  // audit rows reference consultations. Order matters and is not incidental.
  await db.delete(referralEventsTable).where(inArray(referralEventsTable.consultationId, ourConsultations));
  await db.delete(discountRedemptionsTable).where(inArray(discountRedemptionsTable.consultationId, ourConsultations));
  await db.execute(
    sql`delete from audit_log where consultation_id in (select id from consultations where doctor_id = ${fixtures.doctorId})`,
  );
  await db.execute(
    sql`delete from audit_log where entity_id in (select id::text from discount_instruments where code like ${'ZZ' + fixtures.runId.toUpperCase() + '%'})`,
  );
  // Referral instruments are keyed by patient, not by our code prefix.
  await db
    .delete(discountInstrumentsTable)
    .where(inArray(discountInstrumentsTable.referrerPatientId, fixtures.patientIds));
  await db.delete(discountInstrumentsTable).where(inArray(discountInstrumentsTable.id, ourInstruments));
  await db.delete(consultationsTable).where(eq(consultationsTable.doctorId, fixtures.doctorId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db
    .delete(promotionCodeAttemptsTable)
    .where(inArray(promotionCodeAttemptsTable.patientId, fixtures.patientIds));
  await db.delete(patientsTable).where(inArray(patientsTable.id, fixtures.patientIds));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/** Unwraps Drizzle's `DrizzleQueryError` to the underlying `pg` `DatabaseError`, which is where `code`/`constraint` actually live. */
function causeOf(error: unknown): Record<string, unknown> {
  const wrapped = error as { cause?: unknown };
  return (wrapped?.cause ?? error) as Record<string, unknown>;
}

describe('Redemption race — the row lock and the partial unique indexes are the authority (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let repo: PromotionRepository;
  let referralRepo: ReferralRepository;
  let service: PromotionService;

  /** Codes are namespaced per run so concurrent runs against a shared dev database cannot collide on `UNIQUE(code)`. */
  let codeSeq = 0;
  const nextCode = () => `ZZ${fixtures.runId.toUpperCase()}${String(codeSeq++).padStart(3, '0')}`;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    // *** EVERY DEPENDENCY IS THE REAL ONE, INCLUDING THE PORT'S NULL OBJECT. ***
    // The point of this file is that the DATABASE enforces the invariant, so
    // substituting any of these would weaken exactly what is being proved. The
    // one deliberate stand-in is `UnavailablePromotionBookingLookupProvider`,
    // which is not a mock — it is the provider this module actually ships bound
    // to until the coordinator rebinds it.
    repo = new PromotionRepository(db);
    referralRepo = new ReferralRepository(db);
    const affiliateRepo = new AffiliateRepository(db);
    const audit = new AuditService(db);
    const appConfig = new AppConfigService(db);
    const config = new PromotionConfigService(new PromotionConfigRepository(db), appConfig, audit);
    const affiliates = new AffiliateService(db, affiliateRepo, config, audit);

    service = new PromotionService(
      db,
      repo,
      referralRepo,
      affiliateRepo,
      affiliates,
      config,
      new UnavailablePromotionBookingLookupProvider(),
      audit,
    );
  });

  /**
   * `disconnectDatabase()` is in a `finally`, and that is not tidiness — see
   * `booking.slot-race.integration.spec.ts`'s note. A throwing teardown would
   * otherwise skip the disconnect, leak the `pg` pool, and get the Jest worker
   * force-killed, turning a green suite into an unreproducible red.
   */
  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      await disconnectDatabase();
    }
  });

  /**
   * The enumeration throttle counts EVERY attempt, resolved or refused
   * (`promotion-code-attempts.schema.ts`: "a throttle that only counts failures
   * is trivially evaded"). Across a whole suite that would eventually refuse a
   * patient with `TOO_MANY_ATTEMPTS` for reasons that have nothing to do with
   * the invariant under test, so the counter is cleared between tests. The
   * throttle itself is proved in `promotion.service.spec.ts`, where it can be
   * driven deterministically.
   */
  beforeEach(async () => {
    await db
      .delete(promotionCodeAttemptsTable)
      .where(inArray(promotionCodeAttemptsTable.patientId, fixtures.patientIds));
  });

  /* ---- Fixture helpers -------------------------------------------------- */

  async function createConsultation(patientId: string, offsetMinutes: number): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `PROMO-${randomUUID().slice(0, 16)}`,
        patientId,
        doctorId: fixtures.doctorId,
        specialtyId: fixtures.specialtyId,
        mode: 'scheduled',
        status: 'pending_payment',
        // Each consultation gets its own instant, so
        // `consultations_doctor_slot_unique_idx` never refuses a fixture insert
        // for a reason unrelated to this file.
        scheduledStartAt: new Date(Date.UTC(2029, 0, 1, 0, 0, 0) + offsetMinutes * 60_000),
        durationMinutes: 30,
        holdExpiresAt: new Date(Date.now() + 20 * 60_000),
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }

  async function createCoupon(overrides: Partial<typeof discountInstrumentsTable.$inferInsert> = {}) {
    const [row] = await db
      .insert(discountInstrumentsTable)
      .values({
        code: nextCode(),
        kind: 'coupon',
        status: 'active',
        label: 'Race test coupon',
        valueKind: 'flat',
        flatAmount: '100.00',
        minOrderAmount: '0.00',
        maxRedemptionsPerUser: 1,
        ...overrides,
      })
      .returning();
    return row;
  }

  function context(patientId: string, discountableAmount = '500.00'): DiscountOrderContext {
    return {
      patientId,
      doctorId: fixtures.doctorId,
      specialtyId: fixtures.specialtyId,
      components: [{ code: 'convenience_fee', label: 'Convenience fee', grossAmount: discountableAmount }],
      discountableAmount,
      currency: 'INR',
      mode: 'scheduled',
    };
  }

  /** Reads straight from Postgres, bypassing the repository — assertions must not trust the code under test. */
  async function countLive(instrumentId: string): Promise<number> {
    const rows = await db
      .select({ id: discountRedemptionsTable.id })
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.instrumentId, instrumentId),
          inArray(discountRedemptionsTable.status, ['reserved', 'consumed']),
        ),
      );
    return rows.length;
  }

  const holdExpiresAt = () => new Date(Date.now() + 20 * 60_000);

  /* ====================================================================== */
  /* THE CLAIM                                                              */
  /* ====================================================================== */

  it('TWO CONCURRENT RESERVES of a coupon capped at 1: exactly one wins, and the loser is told the cap is reached', async () => {
    const coupon = await createCoupon({ maxTotalRedemptions: 1 });
    const [consultationA, consultationB] = await Promise.all([
      createConsultation(fixtures.patientIds[0], 0),
      createConsultation(fixtures.patientIds[1], 30),
    ]);

    // Both reserves are ISSUED before either is awaited, so they genuinely
    // contend inside Postgres. The second BLOCKS on the instrument's row lock
    // until the first commits, then counts a total that already includes it —
    // which is precisely the production race.
    const results = await Promise.all([
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[0]),
        consultationId: consultationA,
        holdExpiresAt: holdExpiresAt(),
      }),
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[1]),
        consultationId: consultationB,
        holdExpiresAt: holdExpiresAt(),
      }),
    ]);

    const winners = results.filter((result) => result.reserved);
    const losers = results.filter((result) => !result.reserved);

    // EXACTLY ONE WINNER.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // And the loser was refused for the RIGHT reason — a cap that was genuinely
    // full when it was counted, not an incidental conflict.
    expect(losers[0]).toMatchObject({ reserved: false, reason: 'TOTAL_LIMIT_REACHED' });

    // *** THE DATABASE AGREES: ONE LIVE REDEMPTION, NOT TWO. *** This is the
    // assertion the whole module exists to make true.
    expect(await countLive(coupon.id)).toBe(1);
  });

  it('TEN CONCURRENT RESERVES against a cap of 3: exactly 3 win, and no more exist in the table', async () => {
    const coupon = await createCoupon({ maxTotalRedemptions: 3 });
    const consultationIds = await Promise.all(
      fixtures.patientIds.slice(0, 10).map((patientId, index) => createConsultation(patientId, 100 + index * 30)),
    );

    const results = await Promise.all(
      consultationIds.map((consultationId, index) =>
        service.reserve({
          code: coupon.code,
          context: context(fixtures.patientIds[index]),
          consultationId,
          holdExpiresAt: holdExpiresAt(),
        }),
      ),
    );

    expect(results.filter((result) => result.reserved)).toHaveLength(3);
    expect(await countLive(coupon.id)).toBe(3);

    // Every loser was told the total cap was reached — not an assortment of
    // incidental conflicts that happen to add up to the right number.
    for (const loser of results.filter((result) => !result.reserved)) {
      expect(loser).toMatchObject({ reserved: false, reason: 'TOTAL_LIMIT_REACHED' });
    }
  });

  it('POSITIVE CONTROL: an UNCAPPED coupon lets both concurrent reserves through', async () => {
    // Without this, "exactly one succeeded" above could pass vacuously because of
    // something unrelated to the cap — a deadlock, a shared fixture, a bug that
    // refuses every second call.
    const coupon = await createCoupon({ maxTotalRedemptions: null, maxDistinctRedeemers: null });
    const [consultationA, consultationB] = await Promise.all([
      createConsultation(fixtures.patientIds[2], 300),
      createConsultation(fixtures.patientIds[3], 330),
    ]);

    const results = await Promise.all([
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[2]),
        consultationId: consultationA,
        holdExpiresAt: holdExpiresAt(),
      }),
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[3]),
        consultationId: consultationB,
        holdExpiresAt: holdExpiresAt(),
      }),
    ]);

    expect(results.every((result) => result.reserved)).toBe(true);
    expect(await countLive(coupon.id)).toBe(2);
  });

  /* ====================================================================== */
  /* NO STACKING                                                            */
  /* ====================================================================== */

  it('NO STACKING: a second code on the SAME consultation is refused ALREADY_APPLIED', async () => {
    const first = await createCoupon();
    const second = await createCoupon();
    const consultationId = await createConsultation(fixtures.patientIds[4], 600);

    const one = await service.reserve({
      code: first.code,
      context: context(fixtures.patientIds[4]),
      consultationId,
      holdExpiresAt: holdExpiresAt(),
    });
    expect(one.reserved).toBe(true);

    const two = await service.reserve({
      code: second.code,
      context: context(fixtures.patientIds[4]),
      consultationId,
      holdExpiresAt: holdExpiresAt(),
    });

    expect(two).toMatchObject({ reserved: false, reason: 'ALREADY_APPLIED' });
    expect(await countLive(second.id)).toBe(0);
  });

  it('and the index is what refuses it — a raw concurrent insert really does raise 23505 on the live-consultation index', async () => {
    // Proves the mapping in `promotion-conflict.util.ts` is keyed to an index
    // that EXISTS and fires, rather than to a name somebody typed. If the
    // migration renames it, this fails loudly instead of silently degrading
    // every refusal to CODE_NOT_USABLE.
    const coupon = await createCoupon();
    const consultationId = await createConsultation(fixtures.patientIds[5], 700);

    const values = (instrumentId: string) => ({
      instrumentId,
      patientId: fixtures.patientIds[5],
      consultationId,
      status: 'reserved' as const,
      valueKind: 'flat' as const,
      flatAmount: '100.00',
      discountableBase: '500.00',
      discountAmount: '100.00',
      enforcesSingleUsePerUser: false,
      expiresAt: holdExpiresAt(),
    });

    const other = await createCoupon();
    const results = await Promise.allSettled([
      db.transaction(async (tx) => repo.insertRedemption(values(coupon.id), tx)),
      db.transaction(async (tx) => repo.insertRedemption(values(other.id), tx)),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isUniqueConstraintViolation(rejected[0].reason)).toBe(true);

    // Read off `.cause`, not the top-level error: Drizzle 0.45 wraps the driver
    // error and hangs the real `pg` `DatabaseError` underneath.
    expect(causeOf(rejected[0].reason)).toMatchObject({
      code: '23505',
      constraint: PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE,
    });
  });

  /* ====================================================================== */
  /* PER-USER AND DISTINCT-REDEEMER CAPS                                    */
  /* ====================================================================== */

  it('PER-USER CAP: the same patient cannot use a one-per-customer coupon on a second consultation', async () => {
    const coupon = await createCoupon({ maxRedemptionsPerUser: 1 });
    const [consultationA, consultationB] = await Promise.all([
      createConsultation(fixtures.patientIds[6], 800),
      createConsultation(fixtures.patientIds[6], 830),
    ]);

    const one = await service.reserve({
      code: coupon.code,
      context: context(fixtures.patientIds[6]),
      consultationId: consultationA,
      holdExpiresAt: holdExpiresAt(),
    });
    expect(one.reserved).toBe(true);

    const two = await service.reserve({
      code: coupon.code,
      context: context(fixtures.patientIds[6]),
      consultationId: consultationB,
      holdExpiresAt: holdExpiresAt(),
    });

    expect(two).toMatchObject({ reserved: false, reason: 'USER_LIMIT_REACHED' });
    expect(await countLive(coupon.id)).toBe(1);
  });

  it('and CONCURRENTLY, the single-use index catches what the count could not have seen', async () => {
    // The counted check and the index are two layers, and this is the case only
    // the index can refuse: two transactions for the SAME patient, neither of
    // which can see the other's uncommitted row.
    //
    // Both take the instrument's row lock, so in practice they serialise and the
    // counted check refuses the second — but the index is what makes that
    // guaranteed rather than merely likely, and either refusal is correct.
    // `discount-redemptions.schema.ts` calls it the "second line of defence".
    const coupon = await createCoupon({ maxRedemptionsPerUser: 1 });
    const [consultationA, consultationB] = await Promise.all([
      createConsultation(fixtures.patientIds[7], 900),
      createConsultation(fixtures.patientIds[7], 930),
    ]);

    const results = await Promise.all([
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[7]),
        consultationId: consultationA,
        holdExpiresAt: holdExpiresAt(),
      }),
      service.reserve({
        code: coupon.code,
        context: context(fixtures.patientIds[7]),
        consultationId: consultationB,
        holdExpiresAt: holdExpiresAt(),
      }),
    ]);

    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.filter((result) => !result.reserved)).toMatchObject([
      { reserved: false, reason: 'USER_LIMIT_REACHED' },
    ]);
    expect(await countLive(coupon.id)).toBe(1);
  });

  it('DISTINCT-REDEEMER CAP: a second person is refused, but the first person’s SECOND use is not', async () => {
    // *** THE SUBTLE ONE. *** A patient who already holds a live redemption is
    // not a NEW distinct redeemer, so a "first N customers" coupon must still
    // let customer 1 take their second allowed use after the cap is full.
    // Without `counts.forPatient === 0` in the check, the distinct cap would
    // silently become a total cap for everybody who was not first.
    const coupon = await createCoupon({ maxDistinctRedeemers: 1, maxRedemptionsPerUser: 2 });
    const first = fixtures.patientIds[8];
    const second = fixtures.patientIds[9];

    const c1 = await createConsultation(first, 1000);
    const c2 = await createConsultation(second, 1030);
    const c3 = await createConsultation(first, 1060);

    expect((await service.reserve({ code: coupon.code, context: context(first), consultationId: c1, holdExpiresAt: holdExpiresAt() })).reserved).toBe(true);

    const otherPerson = await service.reserve({
      code: coupon.code,
      context: context(second),
      consultationId: c2,
      holdExpiresAt: holdExpiresAt(),
    });
    expect(otherPerson).toMatchObject({ reserved: false, reason: 'DISTINCT_USER_LIMIT_REACHED' });

    const samePersonAgain = await service.reserve({
      code: coupon.code,
      context: context(first),
      consultationId: c3,
      holdExpiresAt: holdExpiresAt(),
    });
    expect(samePersonAgain.reserved).toBe(true);
    expect(await countLive(coupon.id)).toBe(2);
  });

  /* ====================================================================== */
  /* RELEASE, CONFIRM, AND THE PARTIAL INDEX'S `WHERE`                      */
  /* ====================================================================== */

  it('RELEASING frees capacity on a full coupon — the partial index’s WHERE clause in action', async () => {
    const coupon = await createCoupon({ maxTotalRedemptions: 1 });
    const consultationA = await createConsultation(fixtures.patientIds[0], 1200);
    const consultationB = await createConsultation(fixtures.patientIds[1], 1230);

    expect(
      (await service.reserve({ code: coupon.code, context: context(fixtures.patientIds[0]), consultationId: consultationA, holdExpiresAt: holdExpiresAt() })).reserved,
    ).toBe(true);

    // Full.
    expect(
      await service.reserve({ code: coupon.code, context: context(fixtures.patientIds[1]), consultationId: consultationB, holdExpiresAt: holdExpiresAt() }),
    ).toMatchObject({ reserved: false, reason: 'TOTAL_LIMIT_REACHED' });

    const released = await service.release({ consultationId: consultationA, reason: 'test_abandoned' });
    expect(released).toMatchObject({ status: 'released' });

    // `released` is not in the index's status list, so the capacity is back —
    // and the released row and a new reserved one coexist for the same
    // instrument, which is exactly what the partial index allows.
    expect(await countLive(coupon.id)).toBe(0);
    expect(
      (await service.reserve({ code: coupon.code, context: context(fixtures.patientIds[1]), consultationId: consultationB, holdExpiresAt: holdExpiresAt() })).reserved,
    ).toBe(true);
    expect(await countLive(coupon.id)).toBe(1);
  });

  it('RELEASE NEVER FORCES: once a confirm has won, release returns null and the consumed row stands', async () => {
    // *** THE RACE THIS PROTECTS AGAINST. *** A capture webhook and the expiry
    // sweep can genuinely fire together. If release could overwrite a `consumed`
    // row, a capped coupon would get a capacity slot back that had ALREADY been
    // spent on a bill the patient has already paid — so it could be redeemed
    // once more than its cap allows.
    const coupon = await createCoupon({ maxTotalRedemptions: 1 });
    const consultationId = await createConsultation(fixtures.patientIds[2], 1300);

    await service.reserve({
      code: coupon.code,
      context: context(fixtures.patientIds[2]),
      consultationId,
      holdExpiresAt: holdExpiresAt(),
    });

    // Confirm with no payment id, which is the sweep's backstop path — the same
    // `consumed` end state, reachable without a `payments` row this module may
    // not create.
    expect(await service.confirmFromSweep(consultationId, 'scheduled')).toBe(true);

    const released = await service.release({ consultationId, reason: 'sweep_after_confirm' });
    expect(released).toBeNull();

    const [row] = await db
      .select()
      .from(discountRedemptionsTable)
      .where(eq(discountRedemptionsTable.consultationId, consultationId));
    expect(row.status).toBe('consumed');
    expect(row.releasedAt).toBeNull();
    // Still counting against the cap, which is the whole point.
    expect(await countLive(coupon.id)).toBe(1);
  });

  it('CONFIRM and RELEASE are both idempotent, and a second call changes nothing', async () => {
    const coupon = await createCoupon();
    const consultationId = await createConsultation(fixtures.patientIds[3], 1400);

    await service.reserve({
      code: coupon.code,
      context: context(fixtures.patientIds[3]),
      consultationId,
      holdExpiresAt: holdExpiresAt(),
    });

    expect(await service.release({ consultationId, reason: 'first' })).toMatchObject({ status: 'released' });
    // No live row left, so there is nothing to release. `null`, not an error.
    expect(await service.release({ consultationId, reason: 'second' })).toBeNull();
    expect(await service.confirmFromSweep(consultationId, 'scheduled')).toBe(false);
  });

  /* ====================================================================== */
  /* REFERRAL ABUSE, AGAINST THE REAL INDEXES                               */
  /* ====================================================================== */

  describe('referral abuse cases', () => {
    /** Mints a referral instrument directly, so these tests do not depend on the lazy-mint path (which has its own unit coverage). */
    async function createReferralCode(referrerPatientId: string) {
      const [row] = await db
        .insert(discountInstrumentsTable)
        .values({
          code: nextCode(),
          kind: 'referral',
          status: 'active',
          label: 'Referral code',
          valueKind: 'flat',
          flatAmount: '100.00',
          minOrderAmount: '0.00',
          maxRedemptionsPerUser: 1,
          referrerPatientId,
        })
        .returning();
      return row;
    }

    it('SELF-REFERRAL is refused before anything is written', async () => {
      const referrer = fixtures.patientIds[10];
      const code = await createReferralCode(referrer);
      const consultationId = await createConsultation(referrer, 1500);

      const result = await service.reserve({
        code: code.code,
        context: context(referrer),
        consultationId,
        holdExpiresAt: holdExpiresAt(),
      });

      expect(result).toMatchObject({ reserved: false, reason: 'SELF_REFERRAL' });
      expect(await countLive(code.id)).toBe(0);
      // And `referral_events_not_self_check` would have refused it anyway — the
      // service answer exists so a patient gets a message, not so the database
      // is trusted less.
      const events = await db
        .select()
        .from(referralEventsTable)
        .where(eq(referralEventsTable.refereePatientId, referrer));
      expect(events).toHaveLength(0);
    });

    it('REPEAT REFEREE: a patient can be referred once, ever — even by a different referrer', async () => {
      const referrerA = fixtures.patientIds[0];
      const referrerB = fixtures.patientIds[1];
      const referee = fixtures.patientIds[11];

      const codeA = await createReferralCode(referrerA);
      const codeB = await createReferralCode(referrerB);
      const c1 = await createConsultation(referee, 1600);
      const c2 = await createConsultation(referee, 1630);

      expect(
        (await service.reserve({ code: codeA.code, context: context(referee), consultationId: c1, holdExpiresAt: holdExpiresAt() })).reserved,
      ).toBe(true);

      const second = await service.reserve({
        code: codeB.code,
        context: context(referee),
        consultationId: c2,
        holdExpiresAt: holdExpiresAt(),
      });
      expect(second).toMatchObject({ reserved: false, reason: 'ALREADY_REFERRED' });

      const events = await db
        .select()
        .from(referralEventsTable)
        .where(eq(referralEventsTable.refereePatientId, referee));
      expect(events).toHaveLength(1);
    });

    it('CIRCULAR REFERRAL: A and B can each refer the other exactly once, and neither can be referred twice', async () => {
      // *** THE INDEX CONSTRAINS REFEREES, NOT REFERRERS, AND THAT IS THE RIGHT
      // SHAPE. *** Referring many people is the product; being referred many
      // times is the abuse. So A referring B AND B referring A is permitted —
      // it is two ordinary referrals that happen to point at each other — while
      // the loop that would actually pay out forever, each party farming the
      // other repeatedly, is closed by `referral_events_referee_once_idx`.
      const a = fixtures.patientIds[4];
      const b = fixtures.patientIds[5];
      const outsider = fixtures.patientIds[3];

      const codeOfA = await createReferralCode(a);
      const codeOfB = await createReferralCode(b);
      const codeOfOutsider = await createReferralCode(outsider);

      // A is referred by B. A is now a referee.
      const c1 = await createConsultation(a, 1700);
      expect(
        (await service.reserve({ code: codeOfB.code, context: context(a), consultationId: c1, holdExpiresAt: holdExpiresAt() })).reserved,
      ).toBe(true);

      // B is referred by A. Allowed: B has referred somebody, but has never
      // BEEN referred, and those are different facts.
      const c2 = await createConsultation(b, 1730);
      expect(
        (await service.reserve({ code: codeOfA.code, context: context(b), consultationId: c2, holdExpiresAt: holdExpiresAt() })).reserved,
      ).toBe(true);

      // *** THE LOOP IS NOW CLOSED IN BOTH DIRECTIONS. *** Neither can be
      // referred again — not by each other, and not by an uninvolved third
      // party either, which is what stops the pair from simply recruiting a
      // chain of accomplices.
      const c3 = await createConsultation(a, 1760);
      expect(
        await service.reserve({ code: codeOfOutsider.code, context: context(a), consultationId: c3, holdExpiresAt: holdExpiresAt() }),
      ).toMatchObject({ reserved: false, reason: 'ALREADY_REFERRED' });

      const c4 = await createConsultation(b, 1790);
      expect(
        await service.reserve({ code: codeOfOutsider.code, context: context(b), consultationId: c4, holdExpiresAt: holdExpiresAt() }),
      ).toMatchObject({ reserved: false, reason: 'ALREADY_REFERRED' });

      // Exactly two referral events exist across the pair, not a chain.
      const events = await db
        .select()
        .from(referralEventsTable)
        .where(inArray(referralEventsTable.refereePatientId, [a, b]));
      expect(events).toHaveLength(2);
    });

    it('CONCURRENT repeat-referee attempts: the referee-once index decides, and only one event exists', async () => {
      const referrerA = fixtures.patientIds[6];
      const referrerB = fixtures.patientIds[7];
      const referee = fixtures.patientIds[8];

      // This referee has not been referred before in this run's fixtures.
      const codeA = await createReferralCode(referrerA);
      const codeB = await createReferralCode(referrerB);
      const [c1, c2] = await Promise.all([createConsultation(referee, 1800), createConsultation(referee, 1830)]);

      const results = await Promise.all([
        service.reserve({ code: codeA.code, context: context(referee), consultationId: c1, holdExpiresAt: holdExpiresAt() }),
        service.reserve({ code: codeB.code, context: context(referee), consultationId: c2, holdExpiresAt: holdExpiresAt() }),
      ]);

      expect(results.filter((result) => result.reserved)).toHaveLength(1);
      expect(results.filter((result) => !result.reserved)).toMatchObject([
        { reserved: false, reason: 'ALREADY_REFERRED' },
      ]);

      const events = await db
        .select()
        .from(referralEventsTable)
        .where(eq(referralEventsTable.refereePatientId, referee));
      expect(events).toHaveLength(1);
    });

    it('a redeemed referral writes a `qualifying` event — NOT a qualified one, and no reward', async () => {
      // *** THE ANTI-FARMING GATE. *** Minting at capture would let somebody
      // refer a burner account, book, pay, take the discount and cancel inside
      // the free-cancellation window that already auto-refunds. The reward waits
      // for a qualifying status.
      const referrer = fixtures.patientIds[9];
      const referee = fixtures.patientIds[10];
      const code = await createReferralCode(referrer);
      const consultationId = await createConsultation(referee, 1900);

      const reserved = await service.reserve({
        code: code.code,
        context: context(referee),
        consultationId,
        holdExpiresAt: holdExpiresAt(),
      });
      expect(reserved.reserved).toBe(true);

      const [event] = await db
        .select()
        .from(referralEventsTable)
        .where(eq(referralEventsTable.consultationId, consultationId));
      expect(event.status).toBe('qualifying');
      expect(event.qualifiedAt).toBeNull();

      // No reward instrument exists for either side yet.
      const rewards = await db
        .select()
        .from(discountInstrumentsTable)
        .where(eq(discountInstrumentsTable.referralEventId, event.id));
      expect(rewards).toHaveLength(0);
    });
  });

  /* ====================================================================== */
  /* THE NORMALISER, END TO END                                             */
  /* ====================================================================== */

  it('ONE NORMALISER: a code stored by the admin writer resolves however a patient types it', async () => {
    // The guarantee that lets `discount_instruments.code` carry a plain UNIQUE
    // and still match case-insensitively, with no `citext` and no functional
    // index. Proved against the real CHECK constraint, which would refuse a
    // badly-normalised value outright.
    const coupon = await createCoupon();
    const consultationId = await createConsultation(fixtures.patientIds[11], 2000);

    const typed = `${coupon.code.toLowerCase().slice(0, 4)}-${coupon.code.toLowerCase().slice(4)} `;
    const result = await service.reserve({
      code: typed,
      context: context(fixtures.patientIds[11]),
      consultationId,
      holdExpiresAt: holdExpiresAt(),
    });

    expect(result).toMatchObject({ reserved: true, code: coupon.code });
  });
});
