import type { AppConfigService } from '../../shared/app-config/app-config.service';
import { CrisisDetectorService, screenTextForCrisis } from './crisis-detector.service';
import { SEARCH_CONFIG_FALLBACKS } from './search.constants';

const KEYWORDS = SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS;

function createService(configuredKeywords?: unknown) {
  const appConfig = {
    getJson: jest.fn().mockResolvedValue(configuredKeywords ?? SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS),
  } as unknown as jest.Mocked<AppConfigService>;
  return { service: new CrisisDetectorService(appConfig), appConfig };
}

describe('screenTextForCrisis (pure)', () => {
  describe('English', () => {
    it.each([
      'i want to die',
      'I WANT TO DIE tonight',
      'thinking about suicide',
      'i keep thinking of killing myself',
      // Contraction folding: the curated keyword is "cant go on".
      "i can't go on",
      'i can’t go on',
      'i cant go on',
      'i want to end my life',
      'i have been cutting myself',
    ])('fires on %p', (query) => {
      expect(screenTextForCrisis(query, KEYWORDS).fired).toBe(true);
    });
  });

  describe('Hindi (Devanagari)', () => {
    it.each(['मुझे आत्महत्या के विचार आते हैं', 'खुदकुशी करने का मन करता है', 'मैं जीना नहीं चाहता'])(
      'fires on %p',
      (query) => {
        expect(screenTextForCrisis(query, KEYWORDS).fired).toBe(true);
      },
    );

    it('fires on a SUFFIXED form of a Devanagari keyword — Hindi inflects by suffix', () => {
      // Keyword is "मरना चाहता"; the query inflects it.
      expect(screenTextForCrisis('मैं मरना चाहता हूँ', KEYWORDS).fired).toBe(true);
      // "आत्महत्या" followed by a postposition, no space.
      expect(screenTextForCrisis('आत्महत्याके बारे में सोचता हूँ', KEYWORDS).fired).toBe(true);
    });

    it('matches a nukta spelling variant against a non-nukta keyword', () => {
      // Keyword list carries both "ज़िंदगी खत्म" and "जिंदगी खत्म"; either spelling must fire.
      expect(screenTextForCrisis('मेरी ज़िंदगी खत्म हो गई', KEYWORDS).fired).toBe(true);
      expect(screenTextForCrisis('मेरी जिंदगी खत्म हो गई', KEYWORDS).fired).toBe(true);
    });
  });

  describe('Hinglish / romanised', () => {
    it.each(['khudkushi ka khayal aata hai', 'main marna chahta hun', 'jeena nahi chahta ab', 'aatmahatya karni hai'])(
      'fires on %p',
      (query) => {
        expect(screenTextForCrisis(query, KEYWORDS).fired).toBe(true);
      },
    );
  });

  describe('word boundaries — the false-positive guard', () => {
    it('does NOT fire on an innocuous word that CONTAINS a keyword', () => {
      // "harm" is a keyword fragment; "harmony" must not fire.
      expect(screenTextForCrisis('i am looking for harmony in my life', ['harm']).fired).toBe(false);
      // "die" inside "diet".
      expect(screenTextForCrisis('my diet is bad and i feel low', ['die']).fired).toBe(false);
      // "overdose" as a substring of a longer token.
      expect(screenTextForCrisis('overdosed', ['overdose']).fired).toBe(false);
    });

    it('DOES fire when the same keyword appears as a whole word', () => {
      expect(screenTextForCrisis('i want to harm someone', ['harm']).fired).toBe(true);
    });

    it('does not fire on ordinary low-mood language that is not crisis language', () => {
      expect(screenTextForCrisis('i feel very low and cannot sleep at night', KEYWORDS).fired).toBe(false);
      expect(screenTextForCrisis('mujhe neend nahi aati', KEYWORDS).fired).toBe(false);
      expect(screenTextForCrisis('मुझे बहुत तनाव है', KEYWORDS).fired).toBe(false);
    });

    it('applies the STRICT both-sides rule to short Devanagari keywords, so a prefix cannot fire', () => {
      // "मर" is 2 chars, below MIN_DEVANAGARI_PREFIX_LENGTH, so it must not
      // prefix-match "मरम्मत" (repair).
      expect(screenTextForCrisis('घर की मरम्मत करानी है', ['मर']).fired).toBe(false);
    });
  });

  it('reports WHICH keyword matched, for server-side logging', () => {
    const result = screenTextForCrisis('i want to die', KEYWORDS);
    expect(result.fired).toBe(true);
    expect(result.matchedKeyword).toBe('want to die');
  });

  it('returns not-fired for empty or punctuation-only input', () => {
    expect(screenTextForCrisis('', KEYWORDS)).toEqual({ fired: false, matchedKeyword: null });
    expect(screenTextForCrisis('!!!', KEYWORDS)).toEqual({ fired: false, matchedKeyword: null });
  });

  it('ignores non-string entries in a malformed keyword list rather than throwing', () => {
    expect(screenTextForCrisis('i want to die', [null as never, 42 as never, 'want to die']).fired).toBe(true);
  });
});

describe('CrisisDetectorService', () => {
  it('screens against the ADMIN-EDITED list from app_config', async () => {
    const { service, appConfig } = createService(['bilkul alag phrase']);

    await expect(service.screen('this contains bilkul alag phrase')).resolves.toEqual({
      fired: true,
      matchedKeyword: 'bilkul alag phrase',
    });
    expect(appConfig.getJson).toHaveBeenCalledWith('search.crisis_keywords', SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS);
  });

  it('an admin edit takes effect with no code change — a phrase absent from the compiled list still fires', async () => {
    const { service } = createService(['naya crisis phrase']);
    await expect(service.screen('naya crisis phrase')).resolves.toMatchObject({ fired: true });
  });

  it('FAILS SAFE to the compiled-in starter list when app_config holds an empty array', async () => {
    const { service } = createService([]);
    // An empty configured list must not disable the guardrail.
    await expect(service.screen('i want to die')).resolves.toMatchObject({ fired: true });
  });

  it('FAILS SAFE to the compiled-in starter list when app_config holds a malformed value', async () => {
    const { service } = createService({ not: 'an array' });
    await expect(service.screen('i want to die')).resolves.toMatchObject({ fired: true });
  });

  it('FAILS SAFE when app_config holds an array with no usable strings', async () => {
    const { service } = createService([null, '', '   ']);
    await expect(service.screen('i want to die')).resolves.toMatchObject({ fired: true });
  });
});
