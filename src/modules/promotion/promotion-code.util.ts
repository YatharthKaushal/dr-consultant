/**
 * *** THE ONE NORMALISER. BOTH SIDES USE IT, SO THEY CANNOT DRIFT. ***
 *
 * `discount-instruments.schema.ts` stores codes ALREADY NORMALISED — upper
 * case, `A-Z0-9` only, enforced by `discount_instruments_code_shape_check`. That
 * is what lets a plain `UNIQUE(code)` be case-insensitive without `citext` (an
 * extension) or a functional index.
 *
 * The guarantee only holds if the ADMIN WRITER and the PATIENT RESOLVER
 * normalise identically. Two implementations would be two chances to disagree,
 * and the failure mode is silent: an admin creates `SaveMe`, it is stored
 * `SAVEME`, and a patient typing `saveme` matches — until one side changes.
 * So there is exactly one function, in one file, and both call it.
 *
 * ── WHY STRIPPING, NOT REJECTING ──────────────────────────────────────────
 *
 * A patient reading a code off a poster types `SAVE-ME`, `save me`, or pastes
 * ` SAVEME ` with a trailing space from a chat app. None of those is a
 * different code; they are the same code with typography attached. Dropping
 * everything outside `A-Z0-9` makes all of them resolve, which is what "one
 * input box resolves any code" actually means in a patient's hands.
 *
 * The cost is that `SAVE-ME` and `SAVEME` are THE SAME CODE. That is stated
 * rather than discovered: two campaigns whose codes differ only by punctuation
 * collide on `UNIQUE(code)` at creation time, loudly, in the admin panel —
 * which is the correct place to find out.
 *
 * Pure by design: no config, no row, no clock, so it is testable as a function
 * rather than as an integration.
 */

/** Exactly `discount_instruments_code_shape_check`. If the CHECK ever changes, change this — a mismatch means the resolver accepts what the writer cannot store. */
const CODE_PATTERN = /^[A-Z0-9]{4,32}$/;

export const PROMOTION_CODE_MIN_LENGTH = 4;
export const PROMOTION_CODE_MAX_LENGTH = 32;

/**
 * Anything a human might type -> the stored form.
 *
 * Never throws and never returns `null`: normalisation is a total function, and
 * whether the RESULT is a legal code is a separate question answered by
 * {@link isValidPromotionCode}. Keeping those apart is what lets the resolver
 * collapse "not a code at all" into the same `CODE_NOT_USABLE` as "no such
 * code", while the admin writer raises a specific `PROMOTION_CODE_INVALID`.
 */
export function normalisePromotionCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // `toUpperCase` BEFORE the strip, so a lower-case letter survives as its
  // upper-case self rather than being deleted as "not in A-Z".
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when `code` is already in the stored form and would satisfy the CHECK. Takes the NORMALISED value — call {@link normalisePromotionCode} first. */
export function isValidPromotionCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * Normalise and validate in one step, for the paths that need both.
 *
 * Returns `null` rather than throwing, so the patient resolver can fold an
 * unusable input into `CODE_NOT_USABLE` with no try/catch, and the admin writer
 * can raise its own typed exception with a message naming the field.
 */
export function toStorableCode(raw: unknown): string | null {
  const normalised = normalisePromotionCode(raw);
  return isValidPromotionCode(normalised) ? normalised : null;
}

/**
 * The alphabet for GENERATED codes (referral codes and minted rewards).
 *
 * `I`, `O`, `0`, `1` are excluded: a patient reads a referral code aloud to a
 * friend, or copies it off a screenshot, and those four are the pairs that get
 * transcribed wrong. Excluding them costs ~12% of the namespace and removes the
 * most common class of "the code doesn't work" support ticket. Every character
 * here is in `A-Z0-9`, so a generated code passes the CHECK by construction.
 */
const GENERATOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A random code body of `length` characters from {@link GENERATOR_ALPHABET}.
 *
 * `randomInt` from `node:crypto`, not `Math.random`: a referral code is a
 * capability — anyone holding it gets a discount — and a predictable generator
 * would let one be guessed from another. `randomInt` is also REJECTION-SAMPLED
 * by Node, so the distribution is uniform; `% alphabet.length` on a raw byte is
 * not, and biasing a code space is exactly the kind of thing nobody notices.
 */
export function generateCodeBody(length: number, randomInt: (max: number) => number): string {
  let body = '';
  for (let index = 0; index < length; index += 1) {
    body += GENERATOR_ALPHABET[randomInt(GENERATOR_ALPHABET.length)];
  }
  return body;
}

/**
 * A full generated code: a short human-readable prefix plus a random body.
 *
 * The prefix is what makes `REF7K2M9QX` legible as a referral code in a support
 * conversation. It is normalised along with everything else, so a prefix with a
 * hyphen in it cannot smuggle an illegal character into the stored value.
 */
export function buildGeneratedCode(prefix: string, bodyLength: number, randomInt: (max: number) => number): string {
  const cleanPrefix = normalisePromotionCode(prefix);
  const body = generateCodeBody(bodyLength, randomInt);
  return `${cleanPrefix}${body}`.slice(0, PROMOTION_CODE_MAX_LENGTH);
}

/** Prefix and body length for a patient's own referral code. 8 body characters over a 32-symbol alphabet is ~40 bits — not guessable at the throttle's 20 attempts an hour. */
export const REFERRAL_CODE_PREFIX = 'REF';
export const REFERRAL_CODE_BODY_LENGTH = 8;

/** Prefix and body length for a minted referral reward. Distinct from the referral prefix so the two are never confused in a log or a support conversation. */
export const REWARD_CODE_PREFIX = 'RW';
export const REWARD_CODE_BODY_LENGTH = 9;

/** How many times a generator retries on a `UNIQUE(code)` collision before giving up. Five is `booking.service.ts#generateReferenceCode`'s number, and the collision probability at 40 bits makes even one retry vanishingly rare. */
export const CODE_ALLOCATION_ATTEMPTS = 5;
