import { Module } from '@nestjs/common';
import { PROMOTION_BOOKING_LOOKUP_PORT } from './promotion.constants';
import { AffiliateRepository } from './affiliate.repository';
import { AffiliateService } from './affiliate.service';
import { PromotionAdminController } from './promotion-admin.controller';
import { PromotionAdminService } from './promotion-admin.service';
import { PromotionConfigRepository } from './promotion-config.repository';
import { PromotionConfigService } from './promotion-config.service';
import { PromotionController } from './promotion.controller';
import { PromotionLinkController } from './promotion-link.controller';
import { PromotionFacade } from './promotion.facade';
import { PromotionRepository } from './promotion.repository';
import { PromotionService } from './promotion.service';
import { PromotionSweepService } from './promotion-sweep.service';
import { ReferralRepository } from './referral.repository';
import { ReferralService } from './referral.service';
import { UnavailablePromotionBookingLookupProvider } from './unavailable-promotion-booking-lookup.provider';

/**
 * M-13: promotions — coupons, vouchers, refer-and-earn, and doctor affiliate
 * commission.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; other modules consume `PromotionFacade`
 * via normal constructor injection after importing `PromotionModule`.
 *
 * *** IT IMPORTS NO FEATURE MODULE AT ALL. *** `DATABASE`, `AuditService` and
 * `AppConfigService` are all `@Global()`, so they need no `imports` entry, and
 * everything else this module needs about another module's data comes through
 * `PROMOTION_BOOKING_LOOKUP_PORT`. That is what keeps the dependency graph
 * acyclic: BOOKING depends on PRICING, PRICING depends on THIS module, so any
 * import from here back into booking would close the loop.
 *
 * ---------------------------------------------------------------------------
 * *** `PROMOTION_BOOKING_LOOKUP_PORT` IS THE M-11 SEAM. ***
 *
 * Bound to `UnavailablePromotionBookingLookupProvider`, a null object that
 * reports `unknown` for every read and NEVER THROWS. The COORDINATOR rebinds it
 * post-merge to an adapter over `BookingFacade` — one line in the `providers`
 * array below.
 *
 * Until then the sweep releases NOTHING (`unknown` means KEEP, see
 * `promotion-booking.contract.ts`) and the referral programme's optional
 * first-consultation rule is skipped. Both defaults are stated in that file,
 * and they deliberately point in OPPOSITE directions because the risks are not
 * symmetric.
 *
 * ---------------------------------------------------------------------------
 * *** WHAT PRICING MUST BIND, AND WHY IT NEEDS NOTHING FROM HERE. ***
 *
 * `modules/pricing` declares its own local mirror of `DiscountContract` and a
 * `DISCOUNT_PORT` token. Post-merge the coordinator changes ONE line there:
 *
 *     { provide: DISCOUNT_PORT, useExisting: PromotionFacade }
 *
 * `PromotionFacade` satisfies that interface STRUCTURALLY — no adapter, no cast
 * — so a drift on either side is a `tsc` error at the binding rather than a
 * runtime surprise. See `promotion.contract.ts`.
 *
 * ---------------------------------------------------------------------------
 * *** THE SWEEP RUNS ON A PLAIN `setInterval`. *** `@nestjs/schedule` is NOT
 * installed and this module does not add it — see
 * `promotion-sweep.service.ts`'s `SWEEP_SCHEDULING` comment, which copies
 * `booking-slot-hold.service.ts`'s reasoning: a `package.json` +
 * `package-lock.json` edit across four parallel worktrees is a self-inflicted
 * collision for one fixed-period job.
 */
@Module({
  controllers: [PromotionController, PromotionLinkController, PromotionAdminController],
  providers: [
    PromotionRepository,
    PromotionConfigRepository,
    ReferralRepository,
    AffiliateRepository,
    // The null object. Rebound by the coordinator to a BookingFacade adapter.
    { provide: PROMOTION_BOOKING_LOOKUP_PORT, useClass: UnavailablePromotionBookingLookupProvider },
    PromotionConfigService,
    PromotionAdminService,
    AffiliateService,
    ReferralService,
    PromotionService,
    // Driven by its own timer, never called. Not exported.
    PromotionSweepService,
    PromotionFacade,
  ],
  exports: [PromotionFacade],
})
export class PromotionModule {}
