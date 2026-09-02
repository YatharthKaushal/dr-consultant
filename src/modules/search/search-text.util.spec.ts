import {
  containsDevanagari,
  containsLeftAnchored,
  containsPhrase,
  normalizeText,
  toLogExcerpt,
  toPaddedNormalized,
  tokenize,
} from './search-text.util';

describe('search-text.util', () => {
  describe('normalizeText', () => {
    it('lower-cases and strips punctuation to spaces', () => {
      expect(normalizeText('I cannot sleep!!  At NIGHT.')).toBe('i cannot sleep at night');
    });

    it('FOLDS CONTRACTIONS onto their unapostrophised spelling, in all three apostrophe forms', () => {
      // Without this, the curated crisis keyword "cant go on" could never
      // fire on "I can't go on" — which is exactly how it was found.
      expect(normalizeText("I can't sleep")).toBe('i cant sleep');
      expect(normalizeText('I can’t sleep')).toBe('i cant sleep');
      expect(normalizeText('I canʼt sleep')).toBe('i cant sleep');
      expect(normalizeText("I'm not okay")).toBe('im not okay');
    });

    it('collapses runs of whitespace and trims', () => {
      expect(normalizeText('  too    many   spaces  ')).toBe('too many spaces');
    });

    it('folds Latin diacritics so an accented spelling still matches', () => {
      expect(normalizeText('suicidé')).toBe('suicide');
      expect(normalizeText('ánxiety')).toBe('anxiety');
    });

    it('PRESERVES Devanagari matras — stripping them would collapse different Hindi words', () => {
      // आत्महत्या must NOT become आतमहतया.
      expect(normalizeText('आत्महत्या')).toBe('आत्महत्या');
      expect(normalizeText('नींद नहीं आती')).toBe('नींद नहीं आती');
    });

    it('drops the nukta and zero-width joiners so typing variants normalise together', () => {
      // ज़िंदगी (with nukta) and जिंदगी (without) are the same word to a user.
      expect(normalizeText('ज़िंदगी')).toBe(normalizeText('जिंदगी'));
      expect(normalizeText('क‍ख')).toBe('कख');
    });

    it('keeps digits and mixed-script text intact', () => {
      expect(normalizeText('neend nahi aati, नींद 3 din se')).toBe('neend nahi aati नींद 3 din se');
    });

    it('returns an empty string for punctuation-only input', () => {
      expect(normalizeText('!!! ... ???')).toBe('');
    });
  });

  describe('tokenize', () => {
    it('splits on spaces after normalising', () => {
      expect(tokenize('I CANNOT sleep!')).toEqual(['i', 'cannot', 'sleep']);
    });

    it('returns an empty array (never [""]) for empty input', () => {
      expect(tokenize('   ')).toEqual([]);
      expect(tokenize('')).toEqual([]);
    });
  });

  describe('containsPhrase (word-boundary on BOTH sides)', () => {
    const haystack = toPaddedNormalized('there is harmony in the diet plan');

    it('does not fire on a keyword contained inside a longer word', () => {
      expect(containsPhrase(haystack, 'harm')).toBe(false);
      expect(containsPhrase(haystack, 'die')).toBe(false);
    });

    it('fires on a whole word', () => {
      expect(containsPhrase(haystack, 'harmony')).toBe(true);
      expect(containsPhrase(haystack, 'diet')).toBe(true);
    });

    it('matches a multi-word phrase', () => {
      expect(containsPhrase(toPaddedNormalized('i want to die tonight'), 'want to die')).toBe(true);
    });

    it('matches across punctuation differences', () => {
      expect(containsPhrase(toPaddedNormalized('I want to die.'), 'want to die')).toBe(true);
    });

    it('returns false for an empty phrase rather than matching everything', () => {
      expect(containsPhrase(haystack, '')).toBe(false);
      expect(containsPhrase(haystack, '   ')).toBe(false);
    });
  });

  describe('containsLeftAnchored (word-boundary on the LEFT only)', () => {
    it('matches a suffixed continuation of the same word', () => {
      expect(containsLeftAnchored(toPaddedNormalized('मैं मरना चाहता हूँ'), 'मरन')).toBe(true);
      expect(containsLeftAnchored(toPaddedNormalized('diagnosed with something'), 'diagnos')).toBe(true);
    });

    it('still cannot fire from INSIDE a word', () => {
      expect(containsLeftAnchored(toPaddedNormalized('undiagnosed'), 'diagnos')).toBe(false);
    });
  });

  describe('containsDevanagari', () => {
    it('detects Devanagari and ignores Latin', () => {
      expect(containsDevanagari('आत्महत्या')).toBe(true);
      expect(containsDevanagari('khudkushi')).toBe(false);
      expect(containsDevanagari('mixed नींद text')).toBe(true);
    });
  });

  describe('toLogExcerpt', () => {
    it('collapses whitespace and truncates with an ellipsis', () => {
      expect(toLogExcerpt('a   b\n c')).toBe('a b c');
      expect(toLogExcerpt('x'.repeat(200))).toHaveLength(121);
    });
  });
});
