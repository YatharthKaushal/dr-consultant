import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { AffiliateService } from './affiliate.service';
import { PromotionService } from './promotion.service';
import { ReferralService } from './referral.service';
import { PreviewCodeDto, RecordAttributionDto } from './promotion.dto';
import { PROMOTION_DEFAULT_CURRENCY } from './promotion.constants';

/**
 * The PATIENT-facing surface.
 *
 * *** EVERY ROUTE TAKES ITS `patientId` FROM THE BEARER TOKEN, NEVER FROM THE
 * BODY. *** `@CurrentUser()` resolves it from the already-verified JWT. A
 * body-supplied patient id on a discount endpoint would let any authenticated
 * patient burn somebody else's per-user cap, probe which vouchers another
 * patient holds, and attribute themselves to another patient's referrer. There
 * is no ownership check to write here because there is no id to check — which is
 * the strongest form the rule can take.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * The public link-slug exchange is NOT here either, and that is structural
 * rather than stylistic: `AccountTypeGuard` reads `@AccountType(...)` off the
 * HANDLER OR THE CLASS and does not consult `@Public()`, so a `@Public()` route
 * inside this class-level `@AccountType('patient')` controller would still be
 * rejected with `WRONG_ACCOUNT_TYPE` — it has no `request.auth` to match. It
 * therefore lives in `PromotionLinkController`, which carries no class-level
 * account type at all. (Fixing the guard instead was rejected: `shared/auth` is
 * touched by every parallel worktree and this module does not need it changed.)
 *
 * There is NO `reserve`, `confirm` or `release` route. Those are called by
 * PRICING through `PromotionFacade`, inside a checkout it orchestrates — a
 * patient-triggerable `reserve` would let anyone pin a discount against a
 * consultation id they do not own, and a patient-triggerable `release` would let
 * them free somebody else's reservation. The only thing a patient does here is
 * ASK what a code is worth.
 */
@Controller('promotions')
@AccountType('patient')
export class PromotionController {
  constructor(
    private readonly promotions: PromotionService,
    private readonly referrals: ReferralService,
    private readonly affiliates: AffiliateService,
  ) {}

  /**
   * "What is this code worth on this order?"
   *
   * *** THIS IS THE ENUMERATION SURFACE, AND IT IS THROTTLED PER PATIENT AND PER
   * IP. *** `promotion-code-attempts.schema.ts`: a resolve endpoint is a machine
   * for discovering valid codes, and "hidden but still redeemable" is exactly
   * what makes discovering them worthwhile. `@Ip()` is what lets this route pass
   * the second subject that the pricing path — whose frozen
   * `DiscountOrderContext` carries no IP — cannot.
   *
   * *** IT RETURNS 200 FOR A REFUSAL. *** The body is a discriminated union
   * (`applicable: true | false`), not an exception. A 404 for "no such code"
   * would confirm which codes exist through the status line alone, defeating the
   * collapse into one `CODE_NOT_USABLE` that the whole throttle depends on.
   */
  @Post('codes/preview')
  async previewCode(@CurrentUser() auth: AuthContext, @Ip() ip: string, @Body() dto: PreviewCodeDto) {
    return this.promotions.previewForPatient(
      dto.code,
      {
        patientId: auth.accountId,
        doctorId: dto.doctorId ?? null,
        specialtyId: dto.specialtyId ?? null,
        components: dto.components ?? [],
        discountableAmount: dto.discountableAmount,
        currency: dto.currency ?? PROMOTION_DEFAULT_CURRENCY,
        mode: dto.mode,
      },
      ip || null,
    );
  }

  /**
   * The patient's own referral code, minted LAZILY on first request — most
   * patients never refer anyone.
   *
   * The response carries COUNTS, never the referees' identities. A referrer
   * learns how many of their referrals qualified; they never learn which of
   * their friends did or did not attend a consultation (`docs/SRS.md` §6.2,
   * minimum necessary). `toReferralEventSummary`, which does name both parties,
   * is admin-only for exactly this reason.
   */
  @Get('referral')
  async getReferralCode(@CurrentUser() auth: AuthContext) {
    return this.referrals.getOrCreateReferralCode(auth.accountId);
  }

  /** Every code this patient may redeem right now. UNLISTED CAMPAIGNS ARE NEVER RETURNED — that is what `is_publicly_listed` is for. */
  @Get('codes')
  async listRedeemable(@CurrentUser() auth: AuthContext) {
    return { codes: await this.promotions.listRedeemableForPatient(auth.accountId) };
  }

  /**
   * The FIRST AUTHENTICATED request carrying an affiliate link token writes the
   * attribution row; from then on the server is authoritative and the token is
   * never trusted again.
   *
   * *** NO ANONYMOUS CLICK TABLE AND NO DEVICE FINGERPRINTING. *** Nothing is
   * stored server-side for an anonymous visitor, ever
   * (`affiliate-attributions.schema.ts`); the token is carried client-side and
   * this is where it lands.
   *
   * Returns `{ attributed: false }` rather than a 4xx for a bad, stale or
   * switched-off token. A link that has expired in somebody's bookmark is not an
   * error the patient can act on, and a 400 would surface as a broken app on a
   * perfectly ordinary journey.
   */
  @Post('affiliate/attribution')
  async recordAttribution(@CurrentUser() auth: AuthContext, @Body() dto: RecordAttributionDto) {
    const result = await this.affiliates.recordAttribution({ patientId: auth.accountId, token: dto.token });
    if (!result) return { attributed: false };
    return { attributed: true, expiresAt: result.expiresAt.toISOString() };
  }
}
