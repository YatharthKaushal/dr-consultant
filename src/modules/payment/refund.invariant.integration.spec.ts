/**
 * *** THE REFUND INVARIANT, PROVED AGAINST A REAL DATABASE. ***
 *
 * Built on the pattern `modules/document/patient-file.transaction.integration.
 * spec.ts` established, and for the same reason it gives: there is a class of
 * claim a mocked test CANNOT make.
 *
 * ── What a mocked test cannot prove ────────────────────────────────────────
 *
 * `refund.service.spec.ts` asserts the refund RULES with a fake transaction:
 *
 *     const db = { transaction: jest.fn(async (cb) => cb(db)) }
 *
 * A mock that invokes its callback has no locking and no rollback semantics at
 * all. Its "over-refund is rejected" tests would pass identically against code
 * with NO `SELECT ... FOR UPDATE` in it, because a single-threaded fake never
 * interleaves two callers. It proves the arithmetic; it says nothing about
 * what Postgres does when two admins press Refund at the same instant.
 *
 * That is the failure this module exists to prevent. `docs/MODULES.md` M-12's
 * done-when is "a repeated webhook cannot double-charge or double-refund", and
 * `refunds.schema.ts` names the mechanism explicitly: "The sum of `processed`
 * rows for a payment is what must never exceed what was captured — enforced in
 * the service inside a `SELECT ... FOR UPDATE` on the payment, because a CHECK
 * constraint cannot see sibling rows."
 *
 * So this file uses the real thing: a real pool, real repositories, real
 * `db.transaction`, real row locks, real rows — and fires genuinely concurrent
 * refunds at one payment from separate connections.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do, and fails loudly rather than skipping if the database is unreachable —
 * a silently-skipped integrity test is precisely the "test that only looks
 * like one" this pattern was written to replace.
 *
 * ── THE GATEWAY IS STUBBED, AND THAT IS THE POINT ─────────────────────────
 *
 * `RazorpayClient` is replaced with an in-memory stub. No Razorpay test-mode
 * credentials are used and no HTTP call is made. That is deliberate rather
 * than a compromise: what is under test is OUR concurrency control over OUR
 * tables, and a real gateway call would add latency and a second failure mode
 * without strengthening the claim by one bit. The stub records what it was
 * asked for so the amount handed to the gateway is still asserted.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { paymentEventsTable } from '../../schema/payment-events.schema';
import { paymentsTable } from '../../schema/payments.schema';
import { patientsTable as _patients } from '../../schema/patients.schema';
import { refundsTable } from '../../schema/refunds.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PaymentEventRepository } from './payment-event.repository';
import { PaymentRepository } from './payment.repository';
import { PriceQuoteRepository } from '../pricing/price-quote.repository';
import { PricingConfigRepository } from '../pricing/pricing-config.repository';
import { PricingConfigService } from '../pricing/pricing-config.service';
import { PricingDocumentRepository } from '../pricing/pricing-document.repository';
import { PricingFacade } from '../pricing/pricing.facade';
import { PricingRefundService } from '../pricing/pricing-refund.service';
import { PricingService } from '../pricing/pricing.service';
import { RefundComponentRepository } from '../pricing/refund-component.repository';
import { UnavailableDiscountProvider } from '../pricing/unavailable-discount.provider';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { RefundRepository } from './refund.repository';
import { RefundService } from './refund.service';
import type { RazorpayClient } from './razorpay.client';

jest.setTimeout(45_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  doctorId: string;
  consultationId: string;
  paymentId: string;
}

/** FR-7.3's bill: 500 + 100 + 108 = 708.00 captured. */
const CONSULTATION_FEE = '500.00';
const CONVENIENCE_FEE = '100.00';
const GST_AMOUNT = '108.00';
const CAPTURED_TOTAL = '708.00';

/**
 * Builds the real row graph one refund needs, ending in a CAPTURED payment.
 *
 * A `consultations` row inserts on its own since migration 0006 corrected the
 * FK inversion — before it, `consultations.id` referenced
 * `payments.consultation_id` non-deferrably and a booking could not exist
 * until a payment already carried its id.
 */
async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  const consultationId = randomUUID();

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `pay_itest_${runId}`, name: `Payment Integration Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: `+9198${runId.slice(0, 6)}01`, status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: `+9198${runId.slice(0, 6)}02`,
      fullName: `Payment Integration Doctor ${runId}`,
      verificationStatus: 'verified',
    })
    .returning({ id: doctorsTable.id });

  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  await db.insert(consultationsTable).values({
    id: consultationId,
    referenceCode: `PAY-ITEST-${runId}`,
    patientId: patient.id,
    doctorId: doctor.id,
    specialtyId: specialty.id,
    mode: 'scheduled',
    status: 'completed',
    durationMinutes: 30,
  });

  // A payment already CAPTURED — the only state a refund is legal against.
  const [payment] = await db
    .insert(paymentsTable)
    .values({
      consultationId,
      currency: 'INR',
      consultationFee: CONSULTATION_FEE,
      convenienceFeePct: '20.00',
      convenienceFee: CONVENIENCE_FEE,
      gstPct: '18.00',
      gstAmount: GST_AMOUNT,
      status: 'paid',
      gatewayOrderId: `order_itest_${runId}`,
      gatewayPaymentId: `pay_itest_${runId}`,
      paymentMethod: 'upi',
      paidAt: new Date(),
    })
    .returning({ id: paymentsTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    doctorId: doctor.id,
    consultationId,
    paymentId: payment.id,
  };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  await db.delete(refundsTable).where(eq(refundsTable.paymentId, fixtures.paymentId));
  await db.delete(paymentEventsTable).where(eq(paymentEventsTable.paymentId, fixtures.paymentId));
  await db.execute(sql`delete from audit_log where entity_id = ${fixtures.paymentId}`);
  await db.execute(sql`delete from audit_log where consultation_id = ${fixtures.consultationId}`);
  await db.execute(
    sql`delete from audit_log where entity_type = 'refund' and entity_id in (select id::text from refunds where payment_id = ${fixtures.paymentId})`,
  );
  await db.delete(paymentsTable).where(eq(paymentsTable.id, fixtures.paymentId));
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.consultationId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/**
 * Real pricing services over the real database, with the DISCOUNT PORT NULL
 * OBJECT bound — the same binding `pricing.module.ts` uses until promotions
 * merges. Nothing here reaches a network.
 */
function buildPricingFacade(db: Database): PricingFacade {
  const quotes = new PriceQuoteRepository(db);
  const documents = new PricingDocumentRepository(db);
  const config = new PricingConfigService(
    db,
    new PricingConfigRepository(db),
    new AppConfigService(db),
    new AuditService(db),
  );
  const pricing = new PricingService(
    db,
    quotes,
    documents,
    config,
    new UnavailableDiscountProvider(),
    new AuditService(db),
  );
  return new PricingFacade(pricing, new PricingRefundService(quotes, new RefundComponentRepository(db)));
}

describe('RefundService — the refund invariant under REAL concurrency (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let service: RefundService;
  let pricingFacade: PricingFacade;
  /** Every amount, in paise, the stub gateway was asked to refund. */
  let gatewayCalls: number[];
  /** Set to make the stub gateway settle immediately instead of returning `pending`. */
  let gatewaySettlesImmediately: boolean;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);

    gatewayCalls = [];
    gatewaySettlesImmediately = false;

    // REAL repositories, a REAL db handle, a REAL AuditService — the whole
    // point. Only the genuinely external thing is stubbed.
    const payments = new PaymentRepository(db);
    const refunds = new RefundRepository(db);

    const gateway = {
      createRefund: async (_paymentId: string, request: { amount: number }) => {
        gatewayCalls.push(request.amount);
        // A small delay WIDENS the window between the two concurrent callers,
        // making a missing row lock far more likely to be caught rather than
        // hidden by luck.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          id: `rfnd_itest_${randomUUID().slice(0, 12)}`,
          status: gatewaySettlesImmediately ? 'processed' : 'pending',
        };
      },
    } as unknown as RazorpayClient;

    // REAL pricing wiring too — the fixtures here are LEGACY payments
    // (`price_quote_id` is null), so `capturedTotalPaise` takes the
    // `calculateBill` branch and none of these are consulted. Building them for
    // real rather than mocking keeps this spec honest about what it is
    // exercising: the concurrency control, against real rows.
    pricingFacade = buildPricingFacade(db);
    service = new RefundService(
      db,
      payments,
      refunds,
      gateway,
      new AuditService(db),
      pricingFacade,
      new RefundComponentRepository(db),
      new PaymentEventRepository(db),
    );
  });

  afterAll(async () => {
    if (db && fixtures) await teardown(db, fixtures);
    await disconnectDatabase();
  });

  /** Reads straight from Postgres, bypassing every repository — assertions must not trust the code under test. */
  async function readRefundRows(): Promise<Array<{ amount: string; status: string; gatewayRefundId: string | null }>> {
    const rows = await db
      .select({
        amount: refundsTable.amount,
        status: refundsTable.status,
        gatewayRefundId: refundsTable.gatewayRefundId,
      })
      .from(refundsTable)
      .where(eq(refundsTable.paymentId, fixtures.paymentId))
      .orderBy(refundsTable.createdAt);
    return rows;
  }

  async function readPaymentStatus(): Promise<string | undefined> {
    const [row] = await db
      .select({ status: paymentsTable.status })
      .from(paymentsTable)
      .where(eq(paymentsTable.id, fixtures.paymentId));
    return row?.status;
  }

  /** The sum of every non-failed refund, computed in SQL rather than in JS. */
  async function readCommittedTotalPaise(): Promise<number> {
    const result = await db.execute<{ total: string }>(
      sql`select coalesce(sum(amount), 0)::text as total from refunds
          where payment_id = ${fixtures.paymentId} and status <> 'failed'`,
    );
    return Math.round(Number(result.rows[0]?.total ?? '0') * 100);
  }

  /* ================================================================== */

  it('starts from a captured payment with no refunds', async () => {
    expect(await readPaymentStatus()).toBe('paid');
    expect(await readRefundRows()).toHaveLength(0);
  });

  /**
   * *** THE CASE THE OLD SCHEMA MADE IMPOSSIBLE. ***
   *
   * `payments` carried refunds as inline columns, so exactly ONE refund per
   * payment was representable. Two sequential partials is the whole reason
   * `refunds` is now its own table.
   */
  it('allows a partial refund, then a SECOND partial refund', async () => {
    const first = await service.createRefund({
      paymentId: fixtures.paymentId,
      amount: '300.00',
      reason: 'Partial refund one',
      initiatedByAdminId: null,
      isAutomatic: true,
    });
    expect(first.refundId).toBeDefined();

    const second = await service.createRefund({
      paymentId: fixtures.paymentId,
      amount: '200.00',
      reason: 'Partial refund two',
      initiatedByAdminId: null,
      isAutomatic: true,
    });
    expect(second.refundId).toBeDefined();
    expect(second.refundId).not.toBe(first.refundId);

    const rows = await readRefundRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amount)).toEqual(['300.00', '200.00']);
    // Each row carries its OWN amount, not a running total
    // (`refunds.schema.ts`: "This refund alone, NOT the running total").
    expect(await readCommittedTotalPaise()).toBe(50_000);

    // The gateway saw integer paise, both times.
    expect(gatewayCalls).toEqual([30_000, 20_000]);
  });

  it('rejects a refund that would exceed what was captured', async () => {
    // 500 already committed of 708. A further 300 would make 800.
    await expect(
      service.createRefund({
        paymentId: fixtures.paymentId,
        amount: '300.00',
        reason: 'Over-refund attempt',
        initiatedByAdminId: null,
        isAutomatic: true,
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'REFUND_EXCEEDS_CAPTURED' } });

    // *** The assertion that matters: Postgres holds no extra row. ***
    expect(await readRefundRows()).toHaveLength(2);
    expect(await readCommittedTotalPaise()).toBe(50_000);
  });

  /* ================================================================== */
  /* THE CONCURRENCY PROOF                                               */
  /* ================================================================== */

  /**
   * *** THIS IS THE TEST THE FILE EXISTS FOR. ***
   *
   * 208.00 remains refundable. Two admins each request 200.00 AT THE SAME
   * TIME, on separate pooled connections.
   *
   * Without the `SELECT ... FOR UPDATE`, both transactions read the same
   * "500.00 already committed" total, both compute 208.00 remaining, both pass
   * the check, and the payment ends up refunded for 900.00 of a 708.00
   * capture — 192.00 of the platform's money gone, with two perfectly
   * innocent-looking rows to show for it.
   *
   * With the lock, the second transaction BLOCKS on the payment row until the
   * first commits, then re-reads a total that already includes it, and is
   * refused.
   */
  it('two CONCURRENT refunds cannot together exceed what was captured', async () => {
    const before = await readCommittedTotalPaise();
    expect(before).toBe(50_000); // 500.00 of 708.00 committed; 208.00 left.

    const attempt = (label: string) =>
      service.createRefund({
        paymentId: fixtures.paymentId,
        amount: '200.00',
        reason: `Concurrent ${label}`,
        initiatedByAdminId: null,
        isAutomatic: true,
      });

    // Genuinely concurrent: two promises in flight at once, each opening its
    // own transaction on its own connection from the pool.
    const results = await Promise.allSettled([attempt('A'), attempt('B')]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // EXACTLY one succeeds. Not zero (that would mean the lock deadlocked or
    // the invariant is too strict), not two (that is the double-refund).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      response: { code: 'REFUND_EXCEEDS_CAPTURED' },
    });

    // *** THE INVARIANT, READ BACK FROM POSTGRES. ***
    const committedPaise = await readCommittedTotalPaise();
    expect(committedPaise).toBe(70_000); // 500.00 + 200.00
    expect(committedPaise).toBeLessThanOrEqual(70_800); // never more than captured

    const rows = await readRefundRows();
    expect(rows).toHaveLength(3);
  });

  /**
   * The same guarantee at the exact boundary, and with more than two callers.
   * 8.00 remains; five admins each ask for 8.00 simultaneously.
   */
  it('holds under five concurrent attempts at the last refundable rupee', async () => {
    const remainingBefore = await service.getRefundableAmount(fixtures.paymentId);
    expect(remainingBefore).toBe('8.00');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_unused, index) =>
        service.createRefund({
          paymentId: fixtures.paymentId,
          amount: '8.00',
          reason: `Race ${index}`,
          initiatedByAdminId: null,
          isAutomatic: true,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);

    // Exactly the captured amount, to the paise. Not one paise more.
    expect(await readCommittedTotalPaise()).toBe(70_800);
    expect(await service.getRefundableAmount(fixtures.paymentId)).toBe('0.00');
  });

  it('refuses any further refund once the whole capture is committed', async () => {
    await expect(
      service.createRefund({
        paymentId: fixtures.paymentId,
        amount: '0.01',
        reason: 'One paise too far',
        initiatedByAdminId: null,
        isAutomatic: true,
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'REFUND_EXCEEDS_CAPTURED' } });

    expect(await readCommittedTotalPaise()).toBe(70_800);
  });

  /* ================================================================== */
  /* PAYMENT STATUS TRANSITIONS                                          */
  /* ================================================================== */

  /**
   * `partially_refunded` "only became a representable state once one payment
   * could carry many refunds" (`enums.schema.ts`). Driven by SETTLED refunds
   * only — a refund still in flight has not moved money.
   */
  it('moves the payment to partially_refunded, then refunded, as refunds settle', async () => {
    // Nothing has settled yet: every row is still `pending`/`processing`.
    expect(await readPaymentStatus()).toBe('paid');

    const rows = await db
      .select({ id: refundsTable.id, amount: refundsTable.amount })
      .from(refundsTable)
      .where(eq(refundsTable.paymentId, fixtures.paymentId))
      .orderBy(refundsTable.createdAt);

    // Settle the first refund only (300.00 of 708.00).
    await db.update(refundsTable).set({ status: 'processed' }).where(eq(refundsTable.id, rows[0].id));
    await service.recomputePaymentRefundStatus(fixtures.paymentId);
    expect(await readPaymentStatus()).toBe('partially_refunded');

    // Settle everything else.
    await db
      .update(refundsTable)
      .set({ status: 'processed' })
      .where(sql`payment_id = ${fixtures.paymentId} and status <> 'failed'`);
    await service.recomputePaymentRefundStatus(fixtures.paymentId);
    expect(await readPaymentStatus()).toBe('refunded');
  });

  /**
   * The legacy inline columns must stay untouched — `payments.schema.ts` marks
   * every one of them `@deprecated ... Do not write.` Read straight from
   * Postgres after a full refund lifecycle has run.
   */
  it('never writes the deprecated inline payments.refund_* columns', async () => {
    const result = await db.execute<{
      refund_amount: string;
      refund_reason: string | null;
      refund_initiated_by_admin_id: string | null;
      gateway_refund_id: string | null;
      refunded_at: Date | null;
    }>(
      sql`select refund_amount, refund_reason, refund_initiated_by_admin_id, gateway_refund_id, refunded_at
          from payments where id = ${fixtures.paymentId}`,
    );

    const row = result.rows[0];
    // Still at their defaults after three settled refunds totalling 708.00.
    expect(Number(row.refund_amount)).toBe(0);
    expect(row.refund_reason).toBeNull();
    expect(row.refund_initiated_by_admin_id).toBeNull();
    expect(row.gateway_refund_id).toBeNull();
    expect(row.refunded_at).toBeNull();
  });

  /* ================================================================== */
  /* THE ROW-BEFORE-THE-CALL ORDERING                                    */
  /* ================================================================== */

  /**
   * `refunds.schema.ts`: "the row is created BEFORE the gateway call (so a
   * crash mid-call leaves evidence rather than a silent gap)."
   *
   * Proved by making the gateway throw and then going back to Postgres: the
   * row must be there, marked `failed`, not absent.
   */
  it('leaves a durable failed row behind when the gateway call throws', async () => {
    // A fresh payment, so this test does not depend on the one above.
    const consultationId = randomUUID();
    await db.insert(consultationsTable).values({
      id: consultationId,
      referenceCode: `PAY-ITEST-B-${fixtures.runId}`,
      patientId: fixtures.patientId,
      doctorId: fixtures.doctorId,
      specialtyId: fixtures.specialtyId,
      mode: 'scheduled',
      status: 'completed',
      durationMinutes: 30,
    });

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        consultationId,
        currency: 'INR',
        consultationFee: CONSULTATION_FEE,
        convenienceFeePct: '20.00',
        convenienceFee: CONVENIENCE_FEE,
        gstPct: '18.00',
        gstAmount: GST_AMOUNT,
        status: 'paid',
        gatewayOrderId: `order_itest_b_${fixtures.runId}`,
        gatewayPaymentId: `pay_itest_b_${fixtures.runId}`,
        paidAt: new Date(),
      })
      .returning({ id: paymentsTable.id });

    const failingGateway = {
      createRefund: async () => {
        throw Object.assign(new Error('gateway refused'), {
          response: { code: 'PAYMENT_REFUND_NOT_PERMITTED' },
        });
      },
    } as unknown as RazorpayClient;

    const failingService = new RefundService(
      db,
      new PaymentRepository(db),
      new RefundRepository(db),
      failingGateway,
      new AuditService(db),
      pricingFacade,
      new RefundComponentRepository(db),
      new PaymentEventRepository(db),
    );

    await expect(
      failingService.createRefund({
        paymentId: payment.id,
        amount: '100.00',
        reason: 'Will fail at the gateway',
        initiatedByAdminId: null,
        isAutomatic: true,
      }),
    ).rejects.toThrow('gateway refused');

    // *** EVIDENCE, NOT A GAP. *** A fresh read from Postgres.
    const rows = await db
      .select({ amount: refundsTable.amount, status: refundsTable.status, failureReason: refundsTable.failureReason })
      .from(refundsTable)
      .where(eq(refundsTable.paymentId, payment.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe('100.00');
    expect(rows[0].status).toBe('failed');
    expect(rows[0].failureReason).toBe('PAYMENT_REFUND_NOT_PERMITTED');

    // A failed refund does not count against the capture — that money never left.
    expect(await failingService.getRefundableAmount(payment.id)).toBe(CAPTURED_TOTAL);

    // Cleanup for this test's own extra rows.
    await db.delete(refundsTable).where(eq(refundsTable.paymentId, payment.id));
    await db.execute(sql`delete from audit_log where consultation_id = ${consultationId}`);
    await db.execute(sql`delete from audit_log where entity_id = ${payment.id}`);
    await db.delete(paymentsTable).where(eq(paymentsTable.id, payment.id));
    await db.delete(consultationsTable).where(eq(consultationsTable.id, consultationId));
  });
});
