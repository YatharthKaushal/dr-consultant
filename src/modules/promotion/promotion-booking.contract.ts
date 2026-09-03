/**
 * *** THE M-13 -> M-11 (BOOKING) SEAM. READ BEFORE TOUCHING. ***
 *
 * This module needs to know ONE thing about a consultation — what status it is
 * in — and one thing about a patient — whether they have consulted before. It
 * cannot import `modules/booking` to find out.
 *
 * ── WHY A PORT AND NOT AN IMPORT ──────────────────────────────────────────
 *
 * BOOKING depends on PRICING, and PRICING depends on THIS MODULE (it binds
 * `PromotionFacade` at its `DISCOUNT_PORT`). A direct
 * `import from '../booking/booking.facade'` here would close that into a module
 * cycle: booking -> pricing -> promotion -> booking. Nest would fail to resolve
 * it, and even where it resolved, `backend/README.md` §2 is explicit that a
 * module's only public surface is its facade, reached through DI.
 *
 * So the interface is declared LOCALLY and bound to `PROMOTION_BOOKING_LOOKUP_PORT`
 * (`promotion.constants.ts`) — precisely the pattern
 * `booking/booking-payment.contract.ts` uses for `BookingPaymentPort`, and
 * `document/document-storage.contract.ts` uses for `DocumentStoragePort`.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `PROMOTION_BOOKING_LOOKUP_PORT` FROM
 * `UnavailablePromotionBookingLookupProvider` TO AN ADAPTER OVER `BookingFacade`
 * IN `promotion.module.ts`. *** That is the whole handover: one line in the
 * `providers` array. The methods below are deliberately NARROW — two reads, no
 * writes, no money — so the adapter is a few lines rather than a translation
 * layer.
 *
 * ── THE NULL OBJECT REPORTS `unknown`. IT DOES NOT THROW. ─────────────────
 *
 * This is the one place this module's port pattern DIVERGES from
 * `UnavailableBookingPaymentProvider`, which throws `PAYMENT_PORT_UNAVAILABLE`
 * as a 503. Throwing is right there, because every call site wraps it and a
 * patient sees "checkout is unavailable".
 *
 * Here the caller is a SWEEP that decides whether to release money-adjacent
 * state on a timer. A throw would be caught by the sweep's per-candidate
 * try/catch and counted as a failure — which is survivable — but an `unknown`
 * that is HANDLED is strictly better than an exception that is merely
 * SWALLOWED, because it forces the decision to be written down in the type.
 * So: `'unknown'` is a first-class value of `ConsultationLookupStatus`, and
 * every switch on it must handle it.
 *
 * ── *** `unknown` MEANS KEEP. THIS IS THE SAFETY ARGUMENT. *** ────────────
 *
 * `booking-slot-hold.service.ts` states the principle for slots: "The default on
 * an unknown or unreachable answer is to KEEP THE HOLD. Holding a slot too long
 * is a scheduling annoyance; releasing one under a live payment is a money
 * problem."
 *
 * The same holds here, harder. Releasing a reservation returns a redemption to
 * the pool — so a capped coupon that was already spent on a live checkout can be
 * spent AGAIN by somebody else, while the first patient's bill has already been
 * priced with it. An unbound port must not be able to leak redemptions, so
 * `unknown` keeps the reservation, forever if necessary. A stuck `reserved` row
 * is visible, queryable and releasable by a human; a double-spent coupon is
 * none of those.
 *
 * ── THE OTHER `unknown` POINTS THE OTHER WAY, AND THAT IS DELIBERATE ──────
 *
 * `countPriorConsultations` backs the referral programme's optional
 * "first consultation only" rule. When it reports `unknown`, that check is
 * SKIPPED rather than failed.
 *
 * The asymmetry is not an inconsistency — the risks are not symmetric:
 *
 *   - For the sweep, `unknown` -> release would DOUBLE-SPEND money, and the
 *     alternative costs nothing but a stuck row.
 *   - For the first-consultation rule, `unknown` -> refuse would mean referral
 *     codes NEVER WORK until the port is bound. That is the same class of
 *     failure as hard-coding the qualifying status (see
 *     `PROMOTION_DEFAULT_QUALIFYING_STATUSES`): a silent, total feature-off that
 *     nobody notices because nothing errors.
 *
 * And skipping it is not unguarded. The hard anti-abuse guarantees are
 * DATABASE-ENFORCED and do not depend on this port at all:
 * `referral_events_referee_once_idx` (a patient can be referred once, ever, which
 * also kills circular referral), `discount_redemptions_single_use_per_user_idx`,
 * `referral_events_not_self_check`, and the counted caps under the instrument's
 * row lock. The first-consultation rule is a POLICY refinement on top of those,
 * not the thing holding the line.
 */

/**
 * A consultation's status as this module needs to read it.
 *
 * A plain `string` for the real statuses rather than `ConsultationStatus`: the
 * qualifying set is `app_config` data (see
 * `PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES`) and an admin may widen
 * it to a value this module's compiled-in enum does not yet know. Narrowing the
 * type here would turn a config edit into a deploy, which is the whole thing the
 * config key exists to avoid.
 */
export type ConsultationLookupStatus = string | 'unknown';

export interface PromotionBookingLookupPort {
  /**
   * The status of each consultation named, or `'unknown'` where it cannot be
   * determined — including when the consultation does not exist.
   *
   * *** BATCH-ONLY, DELIBERATELY. *** There is no single-id variant, because the
   * sweep examines up to a hundred candidates a pass and one query is better
   * than a hundred — and because every method here is one more thing the
   * coordinator's `BookingFacade` adapter has to implement. A caller that wants
   * one status passes an array of one.
   *
   * Returns a map keyed by consultation id. An id the port cannot answer for is
   * either absent from the map or mapped to `'unknown'`; both mean the same
   * thing and callers must handle both. *** NEVER THROWS. ***
   */
  getConsultationStatuses(consultationIds: readonly string[]): Promise<ReadonlyMap<string, ConsultationLookupStatus>>;

  /**
   * How many consultations this patient has that are NOT the one being priced,
   * or `'unknown'`.
   *
   * Backs the referral programme's optional first-consultation rule. `'unknown'`
   * SKIPS that rule — see the header for why this `unknown` points the opposite
   * way from the sweep's. *** NEVER THROWS. ***
   */
  countPriorConsultations(patientId: string, excludeConsultationId: string | null): Promise<number | 'unknown'>;
}
