import { Injectable } from '@nestjs/common';
import { PricingRefundService } from './pricing-refund.service';
import { PricingService } from './pricing.service';
import type {
  PriceQuoteView,
  PricingContract,
  QuoteRequest,
  RefundApportionment,
} from './pricing.contract';

/**
 * M-12.5's only public surface (`backend/README.md` §2). Thin by design — every
 * rule lives in `PricingService` and `PricingRefundService`, and this class
 * exists to be the one type another module imports, so swapping the local
 * implementation for a TCP client later changes nothing at any call site.
 * Mirrors `PaymentFacade`, `StorageFacade` and `AiFacade`.
 *
 * `implements PricingContract` is what keeps the contract honest: a signature
 * drift surfaces here as a `tsc` error rather than as a runtime surprise.
 *
 * *** THE ONLY CONSUMER IS `modules/payment`. *** The dependency runs
 * payment -> pricing and never back — pricing knows nothing about `payments`,
 * `refunds` or Razorpay, and takes every id it needs as an argument. That is
 * what keeps the two free of a cycle.
 */
@Injectable()
export class PricingFacade implements PricingContract {
  constructor(
    private readonly pricing: PricingService,
    private readonly refunds: PricingRefundService,
  ) {}

  async preview(request: QuoteRequest): Promise<PriceQuoteView> {
    return this.pricing.preview(request);
  }

  async createQuote(request: QuoteRequest): Promise<PriceQuoteView> {
    return this.pricing.createQuote(request);
  }

  async pin(input: { quoteId: string; consultationId: string; patientId?: string | null }): Promise<PriceQuoteView> {
    return this.pricing.pin(input);
  }

  async materialiseAndPin(request: QuoteRequest & { consultationId: string }): Promise<PriceQuoteView> {
    return this.pricing.materialiseAndPin(request);
  }

  async getQuote(quoteId: string): Promise<PriceQuoteView | null> {
    return this.pricing.getQuote(quoteId);
  }

  async getQuoteTotals(quoteIds: readonly string[]): Promise<Record<string, string>> {
    return this.pricing.getQuoteTotals(quoteIds);
  }

  async markConsumed(input: {
    quoteId: string;
    consultationId: string | null;
    paymentId: string;
  }): Promise<{ changed: boolean }> {
    return this.pricing.markConsumed(input);
  }

  async abandon(input: {
    quoteId: string;
    consultationId: string | null;
    reason: string;
    status?: 'expired' | 'superseded';
  }): Promise<{ changed: boolean }> {
    return this.pricing.abandon(input);
  }

  async allocateInvoiceNumber(at?: Date): Promise<{ number: string; issuedAt: Date }> {
    return this.pricing.allocateInvoiceNumber(at);
  }

  async allocateCreditNoteNumber(at?: Date): Promise<{ number: string; issuedAt: Date }> {
    return this.pricing.allocateCreditNoteNumber(at);
  }

  async apportionRefund(input: {
    quoteId: string;
    requestedAmount: string;
    alreadyRefundedByCode?: Record<string, string>;
  }): Promise<RefundApportionment> {
    return this.refunds.apportionRefund(input);
  }

  async refundAmountForPct(input: { quoteId: string; pct: number }): Promise<string> {
    return this.refunds.refundAmountForPct(input);
  }

  async hasCatalogue(): Promise<boolean> {
    return this.pricing.hasCatalogue();
  }
}
