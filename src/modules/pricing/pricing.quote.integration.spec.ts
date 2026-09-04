/**
 * *** THE QUOTE LIFECYCLE AND THE DOCUMENT SERIALS, AGAINST A REAL DATABASE. ***
 *
 * Built on the pattern `modules/payment/refund.invariant.integration.spec.ts`
 * established, and for the same reason it gives: there is a class of claim a
 * mocked test CANNOT make.
 *
 * ── What a mocked test cannot prove here ───────────────────────────────────
 *
 * Three of this module's load-bearing guarantees live in SQL, not in TypeScript,
 * and a `jest.fn()` repository would assert nothing about any of them:
 *
 *   1. *** THE PIN IS ONE CONDITIONAL UPDATE. *** `SET status='pinned' WHERE
 *      id=$1 AND status='draft' AND expires_at > now()`. The claim that "nobody
 *      needs a timer for correctness" rests entirely on `now()` being evaluated
 *      by POSTGRES inside that statement. A mock returning `null` proves only
 *      that the mock was told to. Here the row is genuinely written with an
 *      `expires_at` in the past, and the pin genuinely matches zero rows.
 *
 *   2. *** THE CHECK CONSTRAINTS. *** `price_quotes_total_balances`,
 *      `price_quotes_single_tax_regime`, `price_quote_components_line_balances`,
 *      `price_quote_components_exempt_has_no_tax` and
 *      `refund_components_balances` are the database's own opinion on whether
 *      the engine's arithmetic is coherent. They can only be exercised by
 *      actually inserting.
 *
 *   3. *** THE DOCUMENT SERIALS ARE GAPLESS AND SERIALISED. *** The whole reason
 *      `pricing_document_sequences` is a TABLE and not a `SEQUENCE` is that
 *      `nextval` does not roll back. Proving that needs a real transaction and a
 *      real rollback, and proving the lock works needs genuinely concurrent
 *      callers on separate connections.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts do,
 * and fails loudly rather than skipping if the database is unreachable — a
 * silently-skipped integrity test is precisely the "test that only looks like
 * one" this pattern was written to replace.
 *
 * ── No gateway, no promotions ──────────────────────────────────────────────
 *
 * Nothing here touches a network. The discount port is the NULL OBJECT this
 * module ships with, which is the same binding `pricing.module.ts` uses until
 * promotions merges.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { priceQuoteComponentsTable } from '../../schema/price-quote-components.schema';
import { priceQuotesTable } from '../../schema/price-quotes.schema';
import { pricingDocumentSequencesTable } from '../../schema/pricing-document-sequences.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { PriceQuoteRepository } from './price-quote.repository';
import { PricingConfigRepository } from './pricing-config.repository';
import { PricingConfigService } from './pricing-config.service';
import { financialYearFor, PricingDocumentRepository } from './pricing-document.repository';
import { PricingRefundService } from './pricing-refund.service';
import { PricingService } from './pricing.service';
import { RefundComponentRepository } from './refund-component.repository';
import { UnavailableDiscountProvider } from './unavailable-discount.provider';
import { PRICING_DOCUMENT_SERIES } from './pricing.constants';

jest.setTimeout(45_000);

/** A financial year nothing else uses, so the serial assertions are not disturbed by other runs. */
const TEST_FY = '1999-00';

describe('Pricing — the quote lifecycle against a REAL database (integration)', () => {
  let db: Database;
  let quotes: PriceQuoteRepository;
  let documents: PricingDocumentRepository;
  let pricing: PricingService;
  let refunds: PricingRefundService;
  /** Every quote this run created, for teardown. */
  let created: string[];

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    created = [];

    quotes = new PriceQuoteRepository(db);
    documents = new PricingDocumentRepository(db);

    const config = new PricingConfigService(
      db,
      new PricingConfigRepository(db),
      new AppConfigService(db),
      new AuditService(db),
    );

    // The NULL OBJECT, exactly as `pricing.module.ts` binds it until promotions
    // merges. Nothing here reaches a network.
    pricing = new PricingService(db, quotes, documents, config, new UnavailableDiscountProvider(), new AuditService(db));
    refunds = new PricingRefundService(quotes, new RefundComponentRepository(db));
  });

  afterAll(async () => {
    if (db) {
      for (const id of created) {
        // Components cascade on the quote's delete.
        await db.execute(sql`delete from audit_log where entity_id = ${id}`);
        await db.delete(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      }
      await db.execute(sql`delete from audit_log where entity_type = 'pricing_document_serial' and entity_id like ${'%/' + TEST_FY + '/%'}`);
      await db
        .delete(pricingDocumentSequencesTable)
        .where(eq(pricingDocumentSequencesTable.financialYear, TEST_FY));
    }
    await disconnectDatabase();
  });

  /** Creates a real draft quote and remembers it for teardown. */
  async function draft(fee = '500.00', stateCode?: string): Promise<string> {
    const view = await pricing.createQuote({
      consultationFeeInr: fee,
      placeOfSupplyStateCode: stateCode ?? null,
    });
    created.push(view.quoteId!);
    return view.quoteId!;
  }

  /* ================================================================== */
  /* The row the engine writes                                           */
  /* ================================================================== */

  describe('a written quote', () => {
    /**
     * *** THE CHECK CONSTRAINTS ARE THE DATABASE'S OWN OPINION ON THE
     * ARITHMETIC. *** If `price_quotes_total_balances` or
     * `price_quote_components_line_balances` disagreed with the engine, this
     * insert would fail outright rather than produce a subtly wrong bill.
     */
    it('inserts a balanced quote and its components', async () => {
      const id = await draft('500.00');

      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(row.status).toBe('draft');
      expect(row.totalPayable).toBe('618.00');
      expect(row.taxableTotal).toBe('600.00');
      expect(row.grossTotal).toBe('600.00');

      // The constraint, restated as an assertion so a failure names the number.
      const total =
        Number(row.taxableTotal) + Number(row.cgstTotal) + Number(row.sgstTotal) + Number(row.igstTotal);
      expect(total.toFixed(2)).toBe(row.totalPayable);

      const components = await db
        .select()
        .from(priceQuoteComponentsTable)
        .where(eq(priceQuoteComponentsTable.priceQuoteId, id))
        .orderBy(priceQuoteComponentsTable.position);

      expect(components.map((c) => c.code)).toEqual(['doctor_fee', 'convenience_fee']);
      expect(components[0].taxTreatment).toBe('exempt');
      expect(components[0].lineTotal).toBe('500.00');
      expect(components[1].lineTotal).toBe('118.00');
      // The derivation is snapshotted, so the bill is reproducible without
      // re-reading config.
      expect(components[1].basis).toBe('percent_of');
      expect(components[1].basisPct).toBe('20.00');
      expect(components[1].basisCodes).toEqual(['doctor_fee']);
    });

    /** Same-state splits CGST + SGST; different-state gives IGST. Both RECORDED. */
    it('records an intra-state supply as CGST + SGST', async () => {
      const id = await draft('500.00', '27');
      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));

      expect(row.placeOfSupplyKind).toBe('intra_state');
      expect(row.placeOfSupplyStateCode).toBe('27');
      expect(row.cgstTotal).toBe('9.00');
      expect(row.sgstTotal).toBe('9.00');
      expect(row.igstTotal).toBe('0.00');
    });

    it('records an inter-state supply as IGST, at the same total', async () => {
      const id = await draft('500.00', '29');
      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));

      expect(row.placeOfSupplyKind).toBe('inter_state');
      expect(row.placeOfSupplyStateCode).toBe('29');
      expect(row.igstTotal).toBe('18.00');
      expect(row.cgstTotal).toBe('0.00');
      expect(row.sgstTotal).toBe('0.00');
      // `price_quotes_single_tax_regime` would have rejected a row carrying both.
      expect(row.totalPayable).toBe('618.00');
    });
  });

  /* ================================================================== */
  /* The pin                                                             */
  /* ================================================================== */

  describe('pin — one conditional UPDATE, expiry checked by POSTGRES', () => {
    it('pins a live draft and attaches the consultation', async () => {
      const id = await draft();
      const pinned = await quotes.pinIfDraft(id, { consultationId: null as never });
      // `consultation_id` has an FK, so this integration test pins with null and
      // asserts the STATUS transition, which is what the guard is about.
      expect(pinned?.status).toBe('pinned');
      expect(pinned?.pinnedAt).not.toBeNull();
    });

    /**
     * *** THE CLAIM "NOBODY NEEDS A TIMER FOR CORRECTNESS", PROVED. ***
     *
     * The row is written with `expires_at` genuinely in the past, and NO SWEEP
     * HAS RUN — its status is still `draft`. The pin matches zero rows anyway,
     * because `now()` is evaluated by Postgres inside the statement.
     */
    it('REFUSES to pin a quote whose expires_at has passed, with no sweep involved', async () => {
      const id = await draft();

      await db
        .update(priceQuotesTable)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(priceQuotesTable.id, id));

      const [before] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(before.status).toBe('draft'); // still a draft; nothing swept it

      const pinned = await quotes.pinIfDraft(id, { consultationId: null as never });
      expect(pinned).toBeNull();
    });

    /** A second pin matches nothing — the guard is `status='draft'`, in the WHERE clause. */
    it('cannot pin the same quote twice', async () => {
      const id = await draft();
      expect(await quotes.pinIfDraft(id, { consultationId: null as never })).not.toBeNull();
      expect(await quotes.pinIfDraft(id, { consultationId: null as never })).toBeNull();
    });

    /**
     * *** TWO CONCURRENT PINS, ON SEPARATE CONNECTIONS. *** Exactly one wins.
     * A read-then-write would let both through, which is why the guard lives in
     * the statement.
     */
    it('lets exactly one of two concurrent pins win', async () => {
      const id = await draft();

      const [a, b] = await Promise.all([
        quotes.pinIfDraft(id, { consultationId: null as never }),
        quotes.pinIfDraft(id, { consultationId: null as never }),
      ]);

      expect([a, b].filter((row) => row !== null)).toHaveLength(1);
    });
  });

  /* ================================================================== */
  /* Lifecycle transitions                                               */
  /* ================================================================== */

  describe('lifecycle transitions are guarded', () => {
    it('consumes a pinned quote exactly once', async () => {
      const id = await draft();
      await quotes.pinIfDraft(id, { consultationId: null as never });

      expect(await quotes.markConsumedIfPinned(id)).toBe(1);
      // A replayed capture webhook updates zero rows.
      expect(await quotes.markConsumedIfPinned(id)).toBe(0);
    });

    /** *** AN ABANDONMENT MUST NEVER REVERSE A CAPTURE. *** */
    it('refuses to abandon a consumed quote', async () => {
      const id = await draft();
      await quotes.pinIfDraft(id, { consultationId: null as never });
      await quotes.markConsumedIfPinned(id);

      expect(await quotes.abandonIfOpen(id, 'expired')).toBe(0);

      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(row.status).toBe('consumed');
    });

    /** `expired` and `superseded` are distinct terminal states — a finance query asks which. */
    it('records a supersession distinctly from an expiry', async () => {
      const id = await draft();
      expect(await quotes.abandonIfOpen(id, 'superseded')).toBe(1);

      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(row.status).toBe('superseded');
    });
  });

  /* ================================================================== */
  /* The sweep's own SQL                                                 */
  /* ================================================================== */

  describe('the stale-draft sweep’s queries', () => {
    /**
     * *** THE SWEEP RUNS EVERY 60 SECONDS FOREVER, SO ITS SQL MUST ACTUALLY
     * RUN. *** `pricing-quote-sweep.service.spec.ts` mocks the repository, which
     * proves the orchestration and nothing about the statements. A malformed
     * query here would throw on every tick in production and be visible only as
     * a log line.
     */
    it('bulk-expires stale drafts that hold no reservation', async () => {
      const id = await draft();
      await db
        .update(priceQuotesTable)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(priceQuotesTable.id, id));

      const expired = await quotes.expireStaleDraftsWithoutReservations(new Date(), 100);
      expect(expired).toBeGreaterThanOrEqual(1);

      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(row.status).toBe('expired');
    });

    /** A LIVE draft is never touched — the price is still good. */
    it('leaves a draft that has not expired alone', async () => {
      const id = await draft();
      await quotes.expireStaleDraftsWithoutReservations(new Date(), 100);

      const [row] = await db.select().from(priceQuotesTable).where(eq(priceQuotesTable.id, id));
      expect(row.status).toBe('draft');
    });

    /** The candidate query runs and excludes drafts with no consultation, which hold no reservation. */
    it('finds no reservation-holding candidates among consultation-less drafts', async () => {
      const id = await draft();
      await db
        .update(priceQuotesTable)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(priceQuotesTable.id, id));

      const candidates = await quotes.findStaleDraftsHoldingReservations(new Date(), 100);
      expect(candidates.map((c) => c.id)).not.toContain(id);
    });
  });

  /* ================================================================== */
  /* Refund apportionment, over stored rows                              */
  /* ================================================================== */

  describe('a full refund of a 618.00 bill returns 618.00', () => {
    /**
     * The acceptance case, read back from the ACTUAL STORED COMPONENTS rather
     * than from a fixture — so it also proves the snapshot round-trips.
     */
    it('reverses exactly the tax that was charged, from the stored snapshot', async () => {
      const id = await draft('500.00', '27');

      const result = await refunds.apportionRefund({ quoteId: id, requestedAmount: '618.00' });

      expect(result.amount).toBe('618.00');
      expect(result.taxableValue).toBe('600.00');
      expect(result.cgstAmount).toBe('9.00');
      expect(result.sgstAmount).toBe('9.00');
      expect(result.igstAmount).toBe('0.00');
      expect(result.exhaustive).toBe(true);
    });

    /** *** THE COMMERCIAL CHANGE: a 100% tier now returns 618.00, not the 500.00 fee. *** */
    it('prices a 100% refund tier at the whole captured total', async () => {
      const id = await draft('500.00', '27');
      expect(await refunds.refundAmountForPct({ quoteId: id, pct: 100 })).toBe('618.00');
    });
  });

  /* ================================================================== */
  /* Document serials                                                    */
  /* ================================================================== */

  describe('document serials are gapless and serialised', () => {
    it('hands out consecutive numbers within a financial year', async () => {
      const first = await documents.withTransaction((tx) =>
        documents.allocate(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY, tx),
      );
      const second = await documents.withTransaction((tx) =>
        documents.allocate(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY, tx),
      );

      expect(first).toBe(`INV/${TEST_FY}/000001`);
      expect(second).toBe(`INV/${TEST_FY}/000002`);
    });

    /** Separate series do not share a counter. */
    it('keeps the credit-note series independent of the invoice series', async () => {
      const note = await documents.withTransaction((tx) =>
        documents.allocate(PRICING_DOCUMENT_SERIES.CREDIT_NOTE, TEST_FY, tx),
      );
      expect(note).toBe(`CRN/${TEST_FY}/000001`);
    });

    /**
     * *** THE WHOLE REASON THIS IS A TABLE AND NOT A `SEQUENCE`. ***
     *
     * `nextval` is explicitly non-transactional and would burn a number
     * permanently on an aborted transaction. A gap in a statutory series is its
     * own compliance question — "what happened to invoice 41?" — so the counter
     * must roll back with its transaction.
     */
    it('ROLLS BACK an allocation whose transaction aborts, leaving no gap', async () => {
      const before = await documents.peek(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY);

      await expect(
        documents.withTransaction(async (tx) => {
          await documents.allocate(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY, tx);
          throw new Error('the caller failed after allocating');
        }),
      ).rejects.toThrow('the caller failed after allocating');

      const after = await documents.peek(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY);
      expect(after).toBe(before);
    });

    /**
     * *** CONCURRENT ALLOCATION, ON SEPARATE CONNECTIONS. ***
     *
     * The `SELECT ... FOR UPDATE` serialises them, so five callers get five
     * DISTINCT consecutive numbers. Without the lock they would read the same
     * `next_value` and two invoices would carry one number — which the UNIQUE
     * constraint on `payments.invoice_number` would then reject, turning a
     * missing lock into a failed capture.
     */
    it('gives five concurrent callers five distinct consecutive numbers', async () => {
      const start = await documents.peek(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY);

      const numbers = await Promise.all(
        Array.from({ length: 5 }, () =>
          documents.withTransaction((tx) => documents.allocate(PRICING_DOCUMENT_SERIES.INVOICE, TEST_FY, tx)),
        ),
      );

      expect(new Set(numbers).size).toBe(5);
      const values = numbers.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
      expect(values).toEqual([start, start + 1, start + 2, start + 3, start + 4]);
    });
  });

  /* ================================================================== */

  describe('the financial year boundary', () => {
    /** Runs 1 April to 31 March — the series restarts each April, not each January. */
    it('puts March and April of one calendar year in different financial years', () => {
      expect(financialYearFor(new Date('2026-03-31T23:59:59Z'))).toBe('2025-26');
      expect(financialYearFor(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    });
  });
});
