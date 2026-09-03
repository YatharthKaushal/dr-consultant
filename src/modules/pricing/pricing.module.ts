import { Module } from '@nestjs/common';
import { PriceQuoteRepository } from './price-quote.repository';
import { PricingAdminController } from './pricing-admin.controller';
import { PricingConfigRepository } from './pricing-config.repository';
import { PricingConfigService } from './pricing-config.service';
import { PromotionFacade } from '../promotion/promotion.facade';
import { PromotionModule } from '../promotion/promotion.module';
import { DISCOUNT_PORT } from './pricing-discount.contract';
import { PricingDocumentRepository } from './pricing-document.repository';
import { PricingFacade } from './pricing.facade';
import { PricingQuoteSweepService } from './pricing-quote-sweep.service';
import { PricingRefundService } from './pricing-refund.service';
import { PricingService } from './pricing.service';
import { RefundComponentRepository } from './refund-component.repository';
import { UnavailableDiscountProvider } from './unavailable-discount.provider';

/**
 * M-12.5, Pricing and Billing.
 *
 * NOT `@Global()` — like `PaymentModule`/`SearchModule`/`StorageModule`, nothing
 * outside this module resolves a DI token from here; `modules/payment` consumes
 * `PricingFacade` by importing `PricingModule` and injecting it normally.
 *
 * NO `imports`. `DATABASE`, `AuditService` and `AppConfigService` are all
 * `@Global()`, and this module depends on no other feature module. The
 * dependency runs payment -> pricing and never back: pricing knows nothing about
 * `payments`, `refunds` or Razorpay, and takes every id it needs as an ARGUMENT.
 * That is what keeps the two free of a circular dependency.
 *
 * *** `DISCOUNT_PORT` IS BOUND TO THE NULL OBJECT UNTIL PROMOTIONS MERGES. ***
 * `modules/promotion` is being built in a parallel worktree and implements
 * `DiscountPort` blind against the frozen shape in
 * `pricing-discount.contract.ts`. POST-MERGE, THE COORDINATOR REBINDS THIS ONE
 * LINE from `UnavailableDiscountProvider` to the promotions facade — that is the
 * whole handover. Because TypeScript is structural, no adapter and no cast is
 * needed on either side, and a signature drift surfaces here as a `tsc` error.
 *
 * `exports: [PricingFacade]` and nothing else. No repository, no service — a
 * caller reaching past the facade would be the "deep import"
 * `backend/README.md` §2 forbids.
 */
@Module({
  // Promotions is the only feature module pricing imports, and only so that
  // `DISCOUNT_PORT` can bind to the real `PromotionFacade`. The direction is
  // one-way: promotion imports NO feature module, so this closes no cycle.
  imports: [PromotionModule],
  controllers: [PricingAdminController],
  providers: [
    // Data access.
    PriceQuoteRepository,
    PricingConfigRepository,
    PricingDocumentRepository,
    RefundComponentRepository,
    // Rules.
    PricingConfigService,
    PricingService,
    PricingRefundService,
    // The stale-draft sweep. NOT load-bearing for price correctness — expiry is
    // enforced inside `pin`'s own conditional UPDATE — it exists only to release
    // discount reservations. See the service's header.
    PricingQuoteSweepService,
    // *** THE ONE LINE THE PROMOTIONS HANDOVER CHANGES. ***
    { provide: DISCOUNT_PORT, useExisting: PromotionFacade },
    // Public surface.
    PricingFacade,
  ],
  exports: [PricingFacade],
})
export class PricingModule {}
