import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../shared/auth/auth.decorator';
import { AffiliateService } from './affiliate.service';

/**
 * *** THE ONLY UNAUTHENTICATED ROUTE THIS MODULE HAS. ***
 *
 * ── WHY IT IS ITS OWN CONTROLLER ──────────────────────────────────────────
 *
 * `PromotionController` carries a class-level `@AccountType('patient')`, and
 * `AccountTypeGuard` reads that metadata off the HANDLER OR THE CLASS —
 * `getAllAndOverride([handler, class])` — without consulting `@Public()`. So a
 * `@Public()` handler inside that class would still be rejected with
 * `WRONG_ACCOUNT_TYPE`: it has no `request.auth`, and the class-level
 * requirement still applies to it.
 *
 * Teaching the shared guard about `@Public()` would work and would arguably be
 * correct, but `shared/auth` is touched by every parallel worktree and this
 * module does not need it changed. A controller with NO class-level account
 * type is the local, zero-risk expression of the same intent.
 *
 * ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 * A doctor shares `/r/dr-smith-clinic`. The landing page runs before anybody has
 * signed in, so it needs to turn that slug into the signed token the
 * authenticated `POST /promotions/affiliate/attribution` will later accept.
 *
 * *** NO ROW IS WRITTEN HERE, EVER. *** `affiliate-attributions.schema.ts` is
 * categorical: "There is no anonymous-visitor identity in this backend, and
 * inventing one for a mental-health app is a privacy cost with no owner ... So
 * nothing is stored server-side for an anonymous visitor. Ever." This endpoint
 * is a read and an HMAC, nothing more — no click row, no fingerprint, no cookie.
 *
 * The response carries ONLY a token: no partner id, no doctor name, no
 * commission terms. And an unknown slug, a paused partner and a switched-off
 * mechanism all return the same `{ resolved: false }`, so an unauthenticated
 * caller cannot walk the slug namespace to learn which doctors have
 * arrangements — the same collapse, for the same reason, as the code resolver's
 * single `CODE_NOT_USABLE`.
 *
 * *** TODAY IT RETURNS `{ resolved: false }` FOR EVERY SLUG ***, because
 * `promotion.affiliate_enabled` ships `false`.
 */
@Controller('promotions/affiliate/links')
export class PromotionLinkController {
  constructor(private readonly affiliates: AffiliateService) {}

  @Public()
  @Get(':linkSlug')
  async resolveLink(@Param('linkSlug') linkSlug: string) {
    const resolved = await this.affiliates.resolveLinkSlug(linkSlug);
    if (!resolved) return { resolved: false as const };
    return { resolved: true as const, token: resolved.token, expiresAt: resolved.expiresAt.toISOString() };
  }
}
