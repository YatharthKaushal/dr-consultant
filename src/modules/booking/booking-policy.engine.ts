import type { Party } from '../../schema/enums.schema';
import {
  applyPctToPaise,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
} from '../../shared/money/money.util';

/**
 * *** THE CANCELLATION / RESCHEDULE POLICY. THIS SHAPE IS INVENTED HERE. ***
 *
 * FR-6.4 says the patient may "reschedule or cancel within the configured
 * policy, with refund status shown", and `docs/SRS.md` §5.2 requires
 * configuration to "live in data, not code". Neither the SRS, `docs/MODULES.
 * md`, nor `docs/erd.sql` defines WHAT that policy looks like — there is no
 * example key, no JSON shape, no tier vocabulary anywhere in the documents.
 * So the shape below is DEFINED BY THIS MODULE and seeded as
 * `booking.cancellation_policy` / `booking.reschedule_policy` in `app_config`.
 * It is flagged as invented rather than presented as a spec requirement.
 *
 * ── The shape ──────────────────────────────────────────────────────────────
 *
 *   [{ "hoursBefore": 24, "refundPct": 100 },
 *    { "hoursBefore": 2,  "refundPct": 50  },
 *    { "hoursBefore": 0,  "refundPct": 0   }]
 *
 * A tier reads "if you cancel at least `hoursBefore` hours before the
 * consultation starts, you get `refundPct` percent back". Evaluation takes the
 * FIRST tier (scanning from the largest `hoursBefore` down) whose threshold
 * the remaining notice still clears. So with the default above: 30h notice ->
 * 100%, 5h -> 50%, 30min -> 0%.
 *
 * ── Why a tier LIST rather than two named windows ──────────────────────────
 *
 * Two fields (`freeCancellationHours`, `partialRefundHours`) would encode
 * today's three-step policy and nothing else; a fourth step, or a
 * specialty-specific curve, would need a code change and a release — exactly
 * what §5.2 forbids. A list of tiers expresses any monotonic step function,
 * including a single-tier "always 100%" or a ten-tier curve, with no schema
 * change. `reschedule_policy` reuses the identical shape: rescheduling moves
 * a payment rather than refunding it, so `refundPct` there is read as "how
 * much of the fee survives the move", and the default is a single 100% tier
 * (rescheduling is free at any notice) — the shape does not need to differ.
 *
 * ── Validation, and why a bad row can never break a cancellation ───────────
 *
 * `parseRefundPolicy` VALIDATES ON READ and returns the compiled-in default
 * for anything malformed, mirroring `AppConfigService`'s own contract that "a
 * missing or malformed row degrades to that default rather than breaking
 * sign-in". A typo in the admin panel must never make a booking
 * un-cancellable — the patient's ability to cancel is not negotiable, only
 * the percentage is.
 */
export interface RefundPolicyTier {
  /** Minimum hours of notice this tier requires. `0` is the catch-all floor. */
  hoursBefore: number;
  /** Whole percent of the consultation fee refunded at this notice level, 0-100. */
  refundPct: number;
}

export type RefundPolicy = RefundPolicyTier[];

/**
 * Seeded into `app_config` as `booking.cancellation_policy` and used whenever
 * that row is missing or malformed. Deliberately conservative and
 * patient-friendly at long notice, zero once the consult is imminent — the
 * doctor's time is by then committed.
 */
export const DEFAULT_CANCELLATION_POLICY: RefundPolicy = [
  { hoursBefore: 24, refundPct: 100 },
  { hoursBefore: 2, refundPct: 50 },
  { hoursBefore: 0, refundPct: 0 },
];

/**
 * Seeded as `booking.reschedule_policy`. A single 100% tier: moving a booking
 * is free at any notice, because the payment MOVES WITH IT (see
 * `booking.service.ts#reschedule`) rather than being refunded and recharged.
 * The tiered shape is kept so the client can later make short-notice
 * rescheduling cost something without a code change.
 */
export const DEFAULT_RESCHEDULE_POLICY: RefundPolicy = [{ hoursBefore: 0, refundPct: 100 }];

/**
 * Why a cancellation could not be priced automatically. Every one of these
 * routes to the admin resolution queue with the money HELD — never
 * auto-refunded, never silently kept.
 */
export type RefundAmbiguityReason =
  /** The consultation had no `scheduled_start_at` to measure notice against — an instant consult, or a row still awaiting routing. The tier ladder is meaningless without a start time. */
  | 'no_scheduled_start'
  /** The consultation's start time has already passed. Every tier is a "hours BEFORE" promise; none of them says anything about after. */
  | 'already_started'
  /** Cancelled by the doctor or an admin, not the patient. The tiers price the notice THE PATIENT GAVE; applying them to someone else's cancellation would, e.g., refund a patient 50% because the DOCTOR pulled out three hours ahead. That is a goodwill decision a human makes. */
  | 'not_cancelled_by_patient';

export type RefundDecision =
  /** Inside policy and priced. `refundPct > 0` — the caller raises an automatic refund for `refundPct` of the fee. */
  | { outcome: 'auto_refund'; refundPct: number; matchedTier: RefundPolicyTier }
  /** Inside policy, and the policy says nothing comes back. No refund call is made; this is a definite answer, not an ambiguous one. */
  | { outcome: 'no_refund'; refundPct: 0; matchedTier: RefundPolicyTier }
  /** Outside the policy's expressible range. Goes to the admin queue with the money held. */
  | { outcome: 'needs_admin_review'; reason: RefundAmbiguityReason };

/**
 * Validates an `app_config` value against the tier shape, returning
 * `fallback` for anything that does not conform. Never throws — see the
 * header comment on why a malformed policy must not break cancellation.
 *
 * Accepted: a non-empty array of `{hoursBefore, refundPct}` where both are
 * finite numbers, `hoursBefore >= 0`, and `0 <= refundPct <= 100`. The result
 * is returned sorted by `hoursBefore` DESCENDING, so evaluation can take the
 * first match without trusting the admin to have entered the tiers in order.
 */
export function parseRefundPolicy(raw: unknown, fallback: RefundPolicy): RefundPolicy {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;

  const tiers: RefundPolicyTier[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return fallback;
    const { hoursBefore, refundPct } = entry as { hoursBefore?: unknown; refundPct?: unknown };
    if (typeof hoursBefore !== 'number' || !Number.isFinite(hoursBefore) || hoursBefore < 0) return fallback;
    if (typeof refundPct !== 'number' || !Number.isFinite(refundPct) || refundPct < 0 || refundPct > 100) return fallback;
    tiers.push({ hoursBefore, refundPct });
  }

  return tiers.sort((a, b) => b.hoursBefore - a.hoursBefore);
}

/**
 * Prices a cancellation. PURE — no clock of its own, no database, no config
 * read; `now` and the already-parsed `policy` are passed in, so every branch
 * is directly testable.
 *
 * `cancelledByParty` is load-bearing, not decorative: see
 * `'not_cancelled_by_patient'` above.
 */
export function decideRefund(input: {
  policy: RefundPolicy;
  scheduledStartAt: Date | null;
  cancelledByParty: Party;
  now: Date;
}): RefundDecision {
  const { policy, scheduledStartAt, cancelledByParty, now } = input;

  if (cancelledByParty !== 'patient') {
    return { outcome: 'needs_admin_review', reason: 'not_cancelled_by_patient' };
  }
  if (scheduledStartAt === null) {
    return { outcome: 'needs_admin_review', reason: 'no_scheduled_start' };
  }

  const hoursOfNotice = (scheduledStartAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursOfNotice < 0) {
    return { outcome: 'needs_admin_review', reason: 'already_started' };
  }

  // `policy` is sorted descending by `parseRefundPolicy`, so the first tier
  // whose threshold the notice clears is the most generous applicable one.
  const matchedTier = policy.find((tier) => hoursOfNotice >= tier.hoursBefore);
  if (!matchedTier) {
    // Only reachable if every tier demands more notice than was given AND no
    // `hoursBefore: 0` floor exists — a policy that simply declines to say
    // what happens this close in. Ambiguous, so a human decides.
    return { outcome: 'needs_admin_review', reason: 'already_started' };
  }

  return matchedTier.refundPct > 0
    ? { outcome: 'auto_refund', refundPct: matchedTier.refundPct, matchedTier }
    : { outcome: 'no_refund', refundPct: 0, matchedTier };
}

/**
 * `refundPct` percent of `amount`, as a decimal string with exactly two
 * places — the shape `payments`/`refunds` store (`numeric(10,2)`) and the
 * shape `BookingPaymentPort.createRefund` expects.
 *
 * Computed in integer PAISE as `bigint` and rounded ONCE, half-up, which
 * favours the patient on a tie.
 *
 * ── WHAT THIS USED TO DO, AND WHY IT WAS WRONG ─────────────────────────────
 *
 * This function previously claimed, in this same comment, to compute in
 * integer paise. It did not. It ran `Number(amount)` on a `numeric(10,2)`
 * string, multiplied by a float percentage, and then went BACK through
 * floating point to format: `(refundPaise / 100).toFixed(2)`. The integer step
 * in the middle was undone at both ends.
 *
 * That mattered because this is not a display figure — the result is handed to
 * `BookingPaymentPort.createRefund` and becomes the amount sent to Razorpay.
 * It was real money computed in IEEE-754, which is precisely the class of error
 * `shared/money/money.util.ts` exists to prevent.
 *
 * It existed only because the money arithmetic used to live inside
 * `modules/payment`, where this module could not import it. Now that those
 * primitives are in `shared/`, there is one implementation and this uses it.
 *
 * ── DEGRADATION IS PART OF THE CONTRACT ────────────────────────────────────
 *
 * A malformed or negative amount, or a nonsensical percentage, returns
 * `'0.00'` rather than throwing. Callers treat a zero refund as "nothing to
 * refund" and carry on cancelling; throwing here would fail an otherwise-valid
 * cancellation over a figure that is already suspect. The shared primitives
 * are strict by design, so the refusal is caught and converted rather than
 * pre-empted by a looser parse — a negative percentage now yields `'0.00'`
 * instead of the NEGATIVE refund the old float path would happily produce.
 */
export function refundAmountFor(amount: string, refundPct: number): string {
  try {
    if (!Number.isFinite(refundPct)) return '0.00';

    const refundPaise = applyPctToPaise(rupeesToPaise(amount), pctToBasisPoints(refundPct.toFixed(2)));
    return paiseToRupees(refundPaise);
  } catch {
    // MoneyFormatError from any of the three: an unparsable or negative amount,
    // or a percentage outside 0.00-999.99. All mean "no computable refund".
    return '0.00';
  }
}
