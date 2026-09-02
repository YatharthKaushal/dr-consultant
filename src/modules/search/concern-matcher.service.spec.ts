import type { PublicConcern } from '../catalogue/catalogue.contract';
import { ConcernMatcherService, matchConcerns, resolveConcernCodes } from './concern-matcher.service';

function concern(overrides: Partial<PublicConcern> & { code: string }): PublicConcern {
  return {
    id: `id-${overrides.code}`,
    specialtyId: 'specialty-1',
    name: overrides.code,
    matchPhrases: [],
    matchWeight: 1,
    isActive: true,
    ...overrides,
  };
}

const SLEEP = concern({
  code: 'sleep',
  name: 'Sleep problems',
  matchPhrases: ['cannot sleep', 'neend nahi aati', 'नींद नहीं आती', 'insomnia', 'awake all night'],
  matchWeight: 5,
});

const ANXIETY = concern({
  code: 'anxiety',
  name: 'Anxiety and stress',
  matchPhrases: ['panic at night', 'anxious', 'ghabrahat', 'चिंता'],
  matchWeight: 5,
});

const OCD = concern({
  code: 'ocd',
  name: 'Obsessive thoughts',
  matchPhrases: ['baar baar haath dhona', 'repeated thoughts'],
  matchWeight: 2,
});

const CORPUS = [SLEEP, ANXIETY, OCD];

describe('matchConcerns (pure)', () => {
  describe('exact phrase matching', () => {
    it('matches a whole curated phrase', () => {
      const matches = matchConcerns('i cannot sleep at all', CORPUS);
      expect(matches.map((m) => m.concern.code)).toEqual(['sleep']);
      expect(matches[0]?.matchedPhrases).toContain('cannot sleep');
    });

    it('matches Hindi and Hinglish phrases from the same corpus', () => {
      expect(matchConcerns('mujhe neend nahi aati', CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
      expect(matchConcerns('मुझे नींद नहीं आती', CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
      expect(matchConcerns('bahut ghabrahat hoti hai', CORPUS).map((m) => m.concern.code)).toEqual(['anxiety']);
    });

    it("matches a concern's own NAME even when it is not a seeded phrase", () => {
      const bare = concern({ code: 'depression', name: 'Depression', matchPhrases: [], matchWeight: 3 });
      expect(matchConcerns('i think i have depression', [bare]).map((m) => m.concern.code)).toEqual(['depression']);
    });

    it('matches several concerns from one mixed query, best first', () => {
      const matches = matchConcerns('cannot sleep, panic at night', CORPUS);
      expect(matches.map((m) => m.concern.code).sort()).toEqual(['anxiety', 'sleep']);
    });
  });

  describe('partial token overlap', () => {
    it('awards partial credit when enough of a phrase’s content tokens appear', () => {
      // "baar baar haath dhona" -> content tokens baar/baar/haath/dhona;
      // "haath dhona baar baar" covers all of them in another order.
      const matches = matchConcerns('haath dhona baar baar karta hun', CORPUS);
      expect(matches.map((m) => m.concern.code)).toEqual(['ocd']);
    });

    it('scores a partial match BELOW a whole-phrase match', () => {
      const partial = matchConcerns('awake night', [SLEEP])[0];
      const exact = matchConcerns('awake all night', [SLEEP])[0];
      expect(partial).toBeDefined();
      expect(exact).toBeDefined();
      expect(partial!.score).toBeLessThan(exact!.score);
    });

    it('does NOT match on a single shared token of a multi-token phrase', () => {
      // "night" alone is 1 of 3 content tokens in "awake all night" (0.33 < 0.6).
      const onlyNight = concern({ code: 'x', name: 'X', matchPhrases: ['awake all night'] });
      expect(matchConcerns('good night everyone', [onlyNight])).toEqual([]);
    });

    it('does not let a stop word alone carry a two-token phrase', () => {
      const stopwordy = concern({ code: 'y', name: 'Y', matchPhrases: ['neend nahi'] });
      // "nahi" is a stop word, so the only content token is "neend" — absent here.
      expect(matchConcerns('mujhe nahi pata', [stopwordy])).toEqual([]);
    });
  });

  describe('weight ordering', () => {
    it('orders by matchWeight when the text evidence is equal', () => {
      const heavy = concern({ code: 'heavy', name: 'Heavy', matchPhrases: ['tired'], matchWeight: 9 });
      const light = concern({ code: 'light', name: 'Light', matchPhrases: ['tired'], matchWeight: 1 });
      expect(matchConcerns('i am tired', [light, heavy]).map((m) => m.concern.code)).toEqual(['heavy', 'light']);
    });

    it('lets stronger text evidence beat a heavier weight', () => {
      const heavyPartial = concern({ code: 'heavy', name: 'Heavy', matchPhrases: ['awake all night'], matchWeight: 6 });
      const lightExact = concern({ code: 'light', name: 'Light', matchPhrases: ['cannot sleep'], matchWeight: 5 });
      const matches = matchConcerns('cannot sleep, awake night', [heavyPartial, lightExact]);
      expect(matches[0]?.concern.code).toBe('light');
    });

    it('rewards corroboration — two matching phrases beat one, and the bonus is capped', () => {
      const one = concern({ code: 'one', name: 'One', matchPhrases: ['insomnia'] });
      const two = concern({ code: 'two', name: 'Two', matchPhrases: ['insomnia', 'cannot sleep'] });
      const matches = matchConcerns('insomnia, i cannot sleep', [one, two]);
      expect(matches[0]?.concern.code).toBe('two');
      expect(matches[1]?.concern.code).toBe('one');
    });
  });

  describe('ordering is total and stable', () => {
    it('breaks a full tie by code ascending, so identical requests never shuffle', () => {
      const b = concern({ code: 'bbb', name: 'Bbb', matchPhrases: ['tired'] });
      const a = concern({ code: 'aaa', name: 'Aaa', matchPhrases: ['tired'] });
      expect(matchConcerns('tired', [b, a]).map((m) => m.concern.code)).toEqual(['aaa', 'bbb']);
      expect(matchConcerns('tired', [a, b]).map((m) => m.concern.code)).toEqual(['aaa', 'bbb']);
    });
  });

  describe('zero match', () => {
    it('returns an EMPTY LIST, never an error — the pipeline turns this into browse suggestions', () => {
      expect(matchConcerns('where can i park my car', CORPUS)).toEqual([]);
    });

    it('returns empty for an empty or punctuation-only query', () => {
      expect(matchConcerns('', CORPUS)).toEqual([]);
      expect(matchConcerns('???', CORPUS)).toEqual([]);
    });
  });

  describe('inactive concerns', () => {
    it('never scores a concern an admin has deactivated', () => {
      const retired = concern({ code: 'retired', name: 'Retired', matchPhrases: ['cannot sleep'], isActive: false });
      expect(matchConcerns('i cannot sleep', [retired])).toEqual([]);
    });
  });

  describe('preselected concerns (FR-5.5, the same engine)', () => {
    it('floors a deliberately chosen concern so it survives even with no text evidence', () => {
      const matches = matchConcerns('hello', CORPUS, { preselectedConcernIds: [OCD.id] });
      expect(matches.map((m) => m.concern.code)).toEqual(['ocd']);
      expect(matches[0]?.score).toBeGreaterThan(0);
    });

    it('does not lower a preselected concern that ALSO matched the text strongly', () => {
      const withHint = matchConcerns('i cannot sleep', CORPUS, { preselectedConcernIds: [SLEEP.id] })[0];
      const without = matchConcerns('i cannot sleep', CORPUS)[0];
      expect(withHint!.score).toBeGreaterThanOrEqual(without!.score);
    });
  });

  it('honours a limit', () => {
    expect(matchConcerns('cannot sleep, panic at night', CORPUS, { limit: 1 })).toHaveLength(1);
  });

  it('ignores non-string entries in a malformed matchPhrases array', () => {
    const messy = concern({ code: 'messy', name: 'Messy', matchPhrases: [null as never, 'insomnia'] });
    expect(matchConcerns('insomnia', [messy]).map((m) => m.concern.code)).toEqual(['messy']);
  });
});

describe('resolveConcernCodes (stage 3, the AI path)', () => {
  it('resolves model-supplied codes against the live corpus, preserving the model ranking', () => {
    const resolved = resolveConcernCodes(['anxiety', 'sleep'], CORPUS);
    expect(resolved.map((m) => m.concern.code)).toEqual(['anxiety', 'sleep']);
  });

  it('DROPS a code the model invented', () => {
    expect(resolveConcernCodes(['bipolar_disorder', 'sleep'], CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
  });

  it('DROPS a code naming an INACTIVE concern — a retired taxonomy entry stays retired', () => {
    const retired = concern({ code: 'retired', name: 'Retired', isActive: false });
    expect(resolveConcernCodes(['retired'], [...CORPUS, retired])).toEqual([]);
  });

  it('returns an empty list when every code is unresolvable, so the caller can fall back', () => {
    expect(resolveConcernCodes(['nonsense', 'also_nonsense'], CORPUS)).toEqual([]);
  });

  it('de-duplicates repeated codes and tolerates casing/whitespace', () => {
    expect(resolveConcernCodes([' SLEEP ', 'sleep'], CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
  });

  it('ignores non-string entries rather than throwing', () => {
    expect(resolveConcernCodes([42 as never, 'sleep'], CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
  });
});

describe('ConcernMatcherService', () => {
  it('delegates to the pure functions', () => {
    const service = new ConcernMatcherService();
    expect(service.match('i cannot sleep', CORPUS).map((m) => m.concern.code)).toEqual(['sleep']);
    expect(service.resolveCodes(['anxiety'], CORPUS).map((m) => m.concern.code)).toEqual(['anxiety']);
  });
});
