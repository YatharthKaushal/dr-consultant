import {
  buildGeneratedCode,
  generateCodeBody,
  isValidPromotionCode,
  normalisePromotionCode,
  toStorableCode,
  PROMOTION_CODE_MAX_LENGTH,
} from './promotion-code.util';

/**
 * *** THE NORMALISER IS THE ONE THING BOTH SIDES DEPEND ON. ***
 *
 * `discount_instruments.code` carries a PLAIN `UNIQUE` and is still
 * case-insensitive, with no `citext` extension and no functional index. That
 * only works because the admin writer and the patient resolver normalise
 * IDENTICALLY — and the failure mode if they ever diverge is silent: an admin
 * creates `SaveMe`, a patient types `saveme`, and the resolver answers "this
 * code cannot be used" with no error in any log.
 *
 * So these tests are not about string handling. They are about the invariant
 * that makes one namespace safe.
 */
describe('promotion-code.util', () => {
  describe('normalisePromotionCode — total, never throws', () => {
    it('upper-cases, so the stored form and any typed form agree', () => {
      expect(normalisePromotionCode('saveme')).toBe('SAVEME');
      expect(normalisePromotionCode('SaveMe')).toBe('SAVEME');
      expect(normalisePromotionCode('SAVEME')).toBe('SAVEME');
    });

    it('strips the typography a patient reading off a poster actually types', () => {
      // Hyphens on the poster, a space in a chat message, whitespace from a
      // paste. None of these is a different code.
      expect(normalisePromotionCode('SAVE-ME')).toBe('SAVEME');
      expect(normalisePromotionCode('save me')).toBe('SAVEME');
      expect(normalisePromotionCode('  SAVEME  ')).toBe('SAVEME');
      expect(normalisePromotionCode('S.A.V.E_M.E')).toBe('SAVEME');
    });

    it('*** MAKES PUNCTUATION-ONLY VARIANTS THE SAME CODE ***, which is the stated cost', () => {
      // Two campaigns whose codes differ only by punctuation COLLIDE on
      // UNIQUE(code) at creation time — loudly, in the admin panel, which is the
      // correct place to find out. Asserted so nobody "fixes" the normaliser
      // later without seeing the consequence.
      expect(normalisePromotionCode('SAVE-ME')).toBe(normalisePromotionCode('SAVEME'));
      expect(normalisePromotionCode('SAVE_ME')).toBe(normalisePromotionCode('SAVE ME'));
    });

    it('upper-cases BEFORE stripping, so a lower-case letter survives as its upper-case self', () => {
      // The ordering bug this guards: strip-then-upper deletes every lower-case
      // letter as "not in A-Z", so `saveme` would normalise to the empty string
      // and every lower-case code in the product would stop resolving.
      expect(normalisePromotionCode('abcd')).toBe('ABCD');
      expect(normalisePromotionCode('abcd')).not.toBe('');
    });

    it('never throws, whatever it is handed', () => {
      // The resolver folds an unusable input into `CODE_NOT_USABLE` with no
      // try/catch, which only works if this is total.
      expect(normalisePromotionCode(undefined)).toBe('');
      expect(normalisePromotionCode(null)).toBe('');
      expect(normalisePromotionCode(42)).toBe('');
      expect(normalisePromotionCode({})).toBe('');
      expect(normalisePromotionCode('')).toBe('');
      expect(normalisePromotionCode('!!!')).toBe('');
    });

    it('is idempotent — normalising a stored code returns it unchanged', () => {
      // What makes it safe to normalise on both the write and the read path.
      const stored = normalisePromotionCode('save-me-2026');
      expect(normalisePromotionCode(stored)).toBe(stored);
    });
  });

  describe('isValidPromotionCode — exactly discount_instruments_code_shape_check', () => {
    it('accepts 4 to 32 characters of A-Z0-9', () => {
      expect(isValidPromotionCode('SAVE')).toBe(true);
      expect(isValidPromotionCode('S4V3M3')).toBe(true);
      expect(isValidPromotionCode('A'.repeat(32))).toBe(true);
    });

    it('refuses anything the CHECK constraint would refuse', () => {
      // If this drifted from the CHECK, the resolver would accept codes the
      // writer cannot store — or worse, the writer would attempt a store that
      // fails as a raw constraint violation instead of a named error.
      expect(isValidPromotionCode('ABC')).toBe(false);
      expect(isValidPromotionCode('A'.repeat(33))).toBe(false);
      expect(isValidPromotionCode('save')).toBe(false);
      expect(isValidPromotionCode('SAVE-ME')).toBe(false);
      expect(isValidPromotionCode('')).toBe(false);
    });
  });

  describe('toStorableCode', () => {
    it('normalises and validates in one step, returning null rather than throwing', () => {
      expect(toStorableCode('save-me')).toBe('SAVEME');
      expect(toStorableCode('  s a v e  ')).toBe('SAVE');
    });

    it('returns null when normalisation leaves something the CHECK would refuse', () => {
      expect(toStorableCode('ab')).toBeNull();
      expect(toStorableCode('!!!')).toBeNull();
      expect(toStorableCode(undefined)).toBeNull();
      expect(toStorableCode('A'.repeat(40))).toBeNull();
    });
  });

  describe('generated codes', () => {
    /** A deterministic stand-in for `node:crypto`'s `randomInt`, so a generated code can be asserted exactly. */
    const sequential = (): ((max: number) => number) => {
      let n = 0;
      return (max: number) => n++ % max;
    };

    it('produces only characters the CHECK constraint accepts', () => {
      // A generated code that could not be stored would surface as a `23505`-
      // shaped failure inside a sweep, hours after the referral it was minting.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const body = generateCodeBody(8, (max) => Math.floor(Math.random() * max));
        expect(body).toMatch(/^[A-Z0-9]{8}$/);
      }
    });

    it('*** EXCLUDES THE FOUR CHARACTERS THAT GET TRANSCRIBED WRONG. ***', () => {
      // I/O/0/1. A patient reads a referral code aloud to a friend or copies it
      // off a screenshot; excluding these costs ~12% of the namespace and
      // removes the most common class of "the code doesn't work" ticket.
      const body = generateCodeBody(2000, (max) => Math.floor(Math.random() * max));
      expect(body).not.toMatch(/[IO01]/);
    });

    it('builds a prefixed code that is itself normalised', () => {
      expect(buildGeneratedCode('REF', 4, sequential())).toBe('REFABCD');
    });

    it('normalises the prefix, so a prefix with punctuation cannot smuggle an illegal character in', () => {
      expect(buildGeneratedCode('r-e-f', 4, sequential())).toBe('REFABCD');
      expect(isValidPromotionCode(buildGeneratedCode('r-e-f', 4, sequential()))).toBe(true);
    });

    it('never exceeds the column width', () => {
      const long = buildGeneratedCode('VERYLONGPREFIXINDEED', 30, sequential());
      expect(long.length).toBeLessThanOrEqual(PROMOTION_CODE_MAX_LENGTH);
      expect(isValidPromotionCode(long)).toBe(true);
    });

    it('uses the injected generator rather than Math.random, so entropy is auditable', () => {
      // The reason `randomInt` is a parameter at all: a referral code is a
      // CAPABILITY — anyone holding it gets a discount — so the generator must
      // be the cryptographic one, and that is only checkable if it is injected.
      const spy = jest.fn((max: number) => max - 1);
      generateCodeBody(5, spy);
      expect(spy).toHaveBeenCalledTimes(5);
      expect(spy).toHaveBeenCalledWith(32);
    });
  });
});
