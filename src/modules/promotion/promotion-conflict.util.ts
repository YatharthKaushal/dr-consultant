import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import type { DiscountRefusalReason } from './promotion.contract';
import { PROMOTION_INDEXES } from './promotion.constants';

/**
 * *** TURNING ONE `23505` INTO THREE DIFFERENT ANSWERS. ***
 *
 * Three separate partial unique indexes stand behind the reservation
 * transaction, and each of them means something different to a patient:
 *
 *   `discount_redemptions_live_consultation_unique_idx` -> ALREADY_APPLIED
 *   `discount_redemptions_single_use_per_user_idx`      -> USER_LIMIT_REACHED
 *   `referral_events_referee_once_idx`                  -> ALREADY_REFERRED
 *
 * Postgres reports all three as SQLSTATE `23505` and distinguishes them only by
 * the `constraint` field on the driver error. Without this mapping, every one of
 * them would collapse into the same generic conflict and a patient re-applying a
 * coupon would be told "you have already used this code" — which is false, and
 * which is the kind of wrong message that generates a support ticket rather than
 * a retry.
 *
 * ── WHY THE `cause` CHAIN IS WALKED HERE TOO ──────────────────────────────
 *
 * `shared/errors/postgres-error.util.ts` documents the trap in full: Drizzle
 * 0.45 wraps the driver error in its own `DrizzleQueryError`, whose `code` is
 * `undefined`, and hangs the real `pg` `DatabaseError` off `.cause`. A top-level
 * read of `.constraint` returns `undefined` for every real violation raised
 * through a query builder, exactly as a top-level read of `.code` returned
 * `false`.
 *
 * The SQLSTATE test itself is DELEGATED to that shared helper rather than
 * reimplemented — it is the one place that knowledge belongs, and it is already
 * tested there. This file only adds the constraint-name extraction, which is
 * this module's concern rather than everyone's: no other module has three
 * indexes whose violations must be told apart.
 */

/** Drizzle wraps once; the bound matches `postgres-error.util.ts`'s, as generous headroom in case a future version wraps again. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The name of the constraint a Postgres error names, or `null`.
 *
 * Bounded rather than recursive, so a malformed or self-referential `cause`
 * cannot turn an error path into an infinite loop.
 */
export function constraintNameOf(error: unknown): string | null {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint.length > 0) return constraint;
    if (!('cause' in current)) return null;
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

/**
 * A unique violation -> the refusal a patient should actually see, or `null` if
 * this is not a unique violation at all (in which case the caller must rethrow —
 * a genuine fault is not a refusal).
 *
 * *** A `23505` THIS MODULE DOES NOT RECOGNISE IS STILL A REFUSAL, NOT A 500. ***
 * It maps to `CODE_NOT_USABLE`, which is both truthful (the code did not go
 * through) and safe (it leaks nothing). Rethrowing instead would turn a new
 * index — one added by a later migration — into a 500 on the checkout path,
 * which is a worse failure than a slightly vague message. The unrecognised name
 * is handed back so the caller can log it, because a constraint this module has
 * not heard of firing on the reservation path is something an operator should
 * see.
 */
export function refusalForUniqueViolation(
  error: unknown,
): { reason: DiscountRefusalReason; constraint: string | null } | null {
  if (!isUniqueConstraintViolation(error)) return null;

  const constraint = constraintNameOf(error);

  switch (constraint) {
    case PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE:
      // *** NO STACKING, RACE-PROOF. *** One live discount per consultation,
      // enforced by the index rather than by a service check with a
      // read-then-write window.
      return { reason: 'ALREADY_APPLIED', constraint };

    case PROMOTION_INDEXES.SINGLE_USE_PER_USER:
      // The index-enforced half of the per-user cap. Reaching it means the
      // counted check was raced — which is precisely what it exists for.
      return { reason: 'USER_LIMIT_REACHED', constraint };

    case PROMOTION_INDEXES.REFERRAL_REFEREE_ONCE:
      // A patient can be referred once, ever. Also what makes circular referral
      // (A refers B, then B refers A) impossible.
      return { reason: 'ALREADY_REFERRED', constraint };

    default:
      return { reason: 'CODE_NOT_USABLE', constraint };
  }
}
