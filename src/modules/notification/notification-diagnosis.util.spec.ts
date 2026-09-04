import {
  DIAGNOSIS_DENY_LIST,
  collectStrings,
  normalize,
  screenAllForDiagnosis,
  screenForDiagnosis,
} from './notification-diagnosis.util';
import { NOTIFICATION_TEMPLATE_DEFAULTS } from './notification.constants';

/**
 * *** FR-16.2: "NOTIFICATION TEXT NEVER NAMES A DIAGNOSIS." ***
 *
 * These are the tests for LAYER 3 of the enforcement described in
 * `notification-diagnosis.util.ts` — the heuristic deny-list. The two layers
 * that are actual GUARANTEES are tested elsewhere, because they are not about
 * text at all:
 *
 *   - layer 1 (a caller cannot pass prose) is enforced by the shape of
 *     `NotificationRequest` and checked by `tsc`, plus the assertion in
 *     `notification.service.spec.ts` that the only copy reaching a row came
 *     from a template.
 *   - layer 2 (only DECLARED placeholders are substituted) is
 *     `notification-template.util.spec.ts`'s "drops a variable the template
 *     does not declare", and `notification.service.spec.ts`'s "a diagnosis in
 *     an undeclared variable never reaches the body".
 *
 * The KNOWN LIMITATIONS block below deliberately asserts the FALSE NEGATIVES.
 * Those tests exist so nobody reads this file and concludes the deny-list is
 * a guarantee: it is not, it never can be, and the honest thing is to write
 * the gaps down and let them fail loudly if someone "fixes" one without
 * thinking about the false positives that come with it.
 */
describe('screenForDiagnosis', () => {
  describe('the act of diagnosing', () => {
    it.each([
      ['Your diagnosis is ready'],
      ['We have diagnosed the issue'],
      ['A diagnostic report is available'],
      ['Your prognosis has been updated'],
      ['The clinical impression is attached'],
    ])('refuses %s', (text) => {
      expect(screenForDiagnosis(text).clean).toBe(false);
    });

    /** One `diagnos*` stem covers every inflection, which is the point of stems. */
    it.each([['diagnose'], ['diagnosis'], ['diagnosed'], ['diagnostic'], ['diagnoses'], ['diagnosing']])(
      'catches the inflection %s through the diagnos* stem',
      (word) => {
        const screening = screenForDiagnosis(`Tap to see your ${word} now`);
        expect(screening.clean).toBe(false);
        expect(screening.construction).toBe('diagnos*');
      },
    );
  });

  describe('attributing a condition to a person', () => {
    it.each([
      ['You may have something we should look at'],
      ['You might have a follow-up due'],
      ['It seems you are suffering from this'],
      ['Your test came back positive'],
      ['You tested positive'],
      ['Your condition has been updated'],
      ['Your results show a change'],
    ])('refuses %s', (text) => {
      expect(screenForDiagnosis(text).clean).toBe(false);
    });

    /**
     * *** BARE "you have" IS DELIBERATELY ALLOWED. ***
     * The shipped `instant_request` copy is "You have {{expiresInSeconds}}
     * seconds to accept". A rule that makes a required template unwritable is
     * a rule that gets deleted, so the hedged forms carry the clinical claim
     * and the bare verb does not.
     */
    it('allows the bare verb "you have", which carries no clinical claim', () => {
      expect(screenForDiagnosis('You have 45 seconds to accept.').clean).toBe(true);
    });
  });

  describe('named conditions', () => {
    it.each([
      ['Your diabetes review is due'],
      ['Reminder about your diabetic check'],
      ['Your hypertension follow-up'],
      ['Your cancer screening result'],
      ['Your HIV report is ready'],
      ['Your tuberculosis treatment plan'],
      ['Your COVID-19 result'],
      ['Your depression check-in is due'],
      ['Your anxiety disorder review'],
      ['Your PCOS consultation'],
      ['Your migraine follow-up'],
    ])('refuses %s', (text) => {
      expect(screenForDiagnosis(text).clean).toBe(false);
    });
  });

  describe('normalisation — punctuation, case, accents and hyphens cannot evade an entry', () => {
    it.each([['COVID-19'], ['covid 19'], ['...COVID!!!'], ['Covid'], ['(covid)']])('catches %s', (spelling) => {
      expect(screenForDiagnosis(`Your ${spelling} update`).clean).toBe(false);
    });

    /**
     * The limit of that: punctuation becomes a SPACE, not nothing. "C.O.V.I.D"
     * normalises to five separate one-letter tokens and matches nothing.
     * Deleting punctuation instead would fold "a. i. d. s." onto "aids" but
     * would also fold "e.g." onto "eg" and, more to the point, would make
     * every hyphenated compound in ordinary copy a potential match. Spacing is
     * the safer of the two, and this is the false negative it buys.
     */
    it('does NOT catch a letter-by-letter spelling out — punctuation becomes a space, not nothing', () => {
      expect(screenForDiagnosis('Your C.O.V.I.D update').clean).toBe(true);
    });

    it('folds an apostrophe rather than splitting on it, so "Crohn\'s" matches "crohns"', () => {
      expect(screenForDiagnosis("Your Crohn's follow-up").clean).toBe(false);
      expect(screenForDiagnosis('Your Crohns follow-up').clean).toBe(false);
      expect(screenForDiagnosis('Your Crohn’s follow-up').clean).toBe(false);
    });

    it('normalises to a lower-case, punctuation-free, space-collapsed string', () => {
      expect(normalize('  COVID-19,  results!! ')).toBe('covid 19 results');
    });

    it('preserves Devanagari, so a future Devanagari entry would work', () => {
      expect(normalize('मधुमेह')).toBe('मधुमेह');
    });

    it('returns clean for empty and whitespace-only text rather than matching everything', () => {
      expect(screenForDiagnosis('').clean).toBe(true);
      expect(screenForDiagnosis('   ').clean).toBe(true);
    });
  });

  describe('word boundaries — an exact entry must not fire from inside a word', () => {
    /** `aids` is on the list; "braids" and "first aid" must not trip it. */
    it.each([['Your braids appointment'], ['A first aid course'], ['This aid is available']])(
      'does not fire on %s',
      (text) => {
        expect(screenForDiagnosis(text).clean).toBe(true);
      },
    );

    it('does fire on the standalone word', () => {
      expect(screenForDiagnosis('Your AIDS report').clean).toBe(false);
    });

    /**
     * *** THE STEM THAT WAS NOT USED. *** `psychos*` would have swallowed
     * "psychosocial", which is ordinary non-clinical Care Hub language, so the
     * two inflections are listed instead.
     */
    it('allows "psychosocial support" while still refusing "psychosis"', () => {
      expect(screenForDiagnosis('Your psychosocial support session is booked').clean).toBe(true);
      expect(screenForDiagnosis('Your psychosis review').clean).toBe(false);
    });
  });

  describe('words notification copy legitimately needs', () => {
    /**
     * The deny-list is scoped to NAMING A DIAGNOSIS and is deliberately
     * NARROWER than `modules/search`'s `DIAGNOSTIC_DENY_LIST`, which also
     * blocks severity, urgency, probability and treatment language because it
     * guards MODEL PROSE shown instead of search results. Blocking these here
     * would not serve FR-16.2, it would make the required templates
     * unwritable.
     */
    it.each([
      ['Your prescription is ready'],
      ['A case needs your attention'],
      ['A case has been flagged for review'],
      ['Your medication reminder'],
      ['Your consultation starts soon'],
      ['Your report has been uploaded'],
      ['Your appointment is confirmed'],
    ])('allows %s', (text) => {
      expect(screenForDiagnosis(text).clean).toBe(true);
    });
  });

  describe('the construction it reports', () => {
    it('names the FIRST entry tripped, so a log line names one thing rather than a list', () => {
      const screening = screenForDiagnosis('Your diabetes and hypertension review');
      expect(screening.clean).toBe(false);
      expect(screening.construction).toBe('diabet*');
    });

    it('reports a null construction when the text is clean', () => {
      expect(screenForDiagnosis('Your appointment is confirmed')).toEqual({ clean: true, construction: null });
    });
  });

  /* ====================================================================== */

  /**
   * *** THE HONEST PART. ***
   *
   * Each of these is a KNOWN, ACCEPTED false negative, documented in
   * `notification-diagnosis.util.ts`. They are asserted rather than merely
   * commented so that anyone who "fixes" one has to come here, read why it was
   * left out, and take the false positive that comes with it on purpose.
   *
   * The general limitation they stand for: the deny-list names on the order of
   * sixty English constructions out of tens of thousands of diagnoses. It
   * reduces the chance of a leak. It does not eliminate it, and it is NOT what
   * makes FR-16.2 hold — layers 1 and 2 are.
   */
  describe('KNOWN LIMITATIONS — deliberate gaps, asserted so they cannot be silently "fixed"', () => {
    it('does NOT catch the abbreviation "TB": a doctorName of "Dr TB Sharma" would otherwise suppress every booking confirmation', () => {
      expect(screenForDiagnosis('Your TB result').clean).toBe(true);
      // ...while the full word is caught.
      expect(screenForDiagnosis('Your tuberculosis result').clean).toBe(false);
    });

    it('does NOT catch "BP" or "sugar", the everyday Indian shorthand for hypertension and diabetes', () => {
      expect(screenForDiagnosis('Your BP reading is high').clean).toBe(true);
      expect(screenForDiagnosis('Your sugar levels').clean).toBe(true);
    });

    it('does NOT catch a Hindi or Devanagari condition name — the clinical vocabulary is the client clinician-s to author (SRS section 8)', () => {
      // "madhumeh" / "मधुमेह" is diabetes. Neither spelling is on the list.
      expect(screenForDiagnosis('आपकी मधुमेह जांच').clean).toBe(true);
      expect(screenForDiagnosis('Aapki madhumeh jaanch').clean).toBe(true);
    });

    /**
     * Stems buy back SOME misspellings for free — `diabet*` catches
     * "diabetis" because the error is in the suffix — but only those. An
     * error inside the stem itself passes, and there is no spell-checker
     * here and should not be: a fuzzy match on clinical words would start
     * suppressing legitimate copy.
     */
    it('catches a misspelling only when the error falls after the stem', () => {
      expect(screenForDiagnosis('Your diabetis review').clean).toBe(false);
      // ...and not when it falls inside it.
      expect(screenForDiagnosis('Your hypertention review').clean).toBe(true);
      expect(screenForDiagnosis('Your daibetes review').clean).toBe(true);
    });

    it('does NOT catch a condition nobody listed', () => {
      expect(screenForDiagnosis('Your sarcoidosis review is due').clean).toBe(true);
    });

    it('does NOT catch a revealing description that names no condition', () => {
      expect(screenForDiagnosis('Your recent lab work has been reviewed').clean).toBe(true);
    });

    it('does NOT catch "pregnancy" — a condition, but not a diagnosis, and blocking it would break obstetric copy', () => {
      expect(screenForDiagnosis('Your pregnancy check-in is due').clean).toBe(true);
    });
  });
});

/* ========================================================================= */

describe('screenAllForDiagnosis', () => {
  it('returns the first piece that trips, and reports which construction', () => {
    expect(screenAllForDiagnosis(['Appointment confirmed', 'Your diabetes review is due'])).toEqual({
      clean: false,
      construction: 'diabet*',
    });
  });

  it('is clean when every piece is clean', () => {
    expect(screenAllForDiagnosis(['Appointment confirmed', 'Tap to see the details']).clean).toBe(true);
  });

  /**
   * Pieces are screened SEPARATELY rather than concatenated. Joining could
   * manufacture a phrase spanning a boundary that no reader sees as one
   * sentence, and report a construction that appears in neither piece.
   */
  it('does not manufacture a hit across a piece boundary', () => {
    expect(screenAllForDiagnosis(['Tap to see your', 'condition of the road']).clean).toBe(true);
    // Whereas the same words in ONE piece are the real construction.
    expect(screenForDiagnosis('Tap to see your condition').clean).toBe(false);
  });

  it('is clean for an empty list', () => {
    expect(screenAllForDiagnosis([]).clean).toBe(true);
  });
});

/* ========================================================================= */

describe('collectStrings — the deep-link payload is part of the notification', () => {
  it('collects nested string values', () => {
    expect(collectStrings({ screen: 'consultation', ids: ['a', 'b'] })).toEqual(
      expect.arrayContaining(['consultation', 'a', 'b']),
    );
  });

  it('collects object KEYS too — { diabetes: true } names a diagnosis as surely as { tag: "diabetes" }', () => {
    expect(collectStrings({ diabetes: true })).toContain('diabetes');
    expect(screenAllForDiagnosis(collectStrings({ diabetes: true })).clean).toBe(false);
  });

  it('ignores non-string scalars but keeps their keys', () => {
    expect(collectStrings({ a: 1, b: true, c: null })).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for undefined, so an absent payload screens clean', () => {
    expect(collectStrings(undefined)).toEqual([]);
    expect(screenAllForDiagnosis(collectStrings(undefined)).clean).toBe(true);
  });

  /**
   * *** NESTING WAS A ONE-LINE WAY AROUND THE SEND-TIME SCREEN. ***
   *
   * The walk used to give up at depth 6 and return NOTHING for anything
   * below it, so `{a:{b:{c:{d:{e:{f:{g:'you have diabetes'}}}}}}}` screened
   * clean — and was then written to `deep_link_data`, projected back to the
   * client by `notification.mapper.ts` and put in the FCM `data` block. The
   * bound is on nodes visited now, not on depth.
   */
  it('screens a string buried below the old depth cap', () => {
    const buried = { a: { b: { c: { d: { e: { f: { g: 'you have diabetes' } } } } } } };
    expect(collectStrings(buried)).toContain('you have diabetes');
    expect(screenAllForDiagnosis(collectStrings(buried)).clean).toBe(false);
  });

  /** An unbounded walk over caller-supplied JSON is a denial-of-service shape — and the walk is iterative, so depth cannot overflow the stack either. */
  it('terminates on a pathologically deep payload, and still sees what is at the bottom', () => {
    let deep: unknown = 'diabetes';
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => collectStrings(deep)).not.toThrow();
    expect(collectStrings(deep)).toContain('diabetes');
  });

  it('terminates on a very deep payload without a stack overflow', () => {
    let deep: unknown = 'diabetes';
    for (let i = 0; i < 50_000; i += 1) deep = { next: deep };
    expect(() => collectStrings(deep)).not.toThrow();
  });

  /** A self-referential payload used to terminate only by running out of depth, re-collecting the same strings six times over. */
  it('walks a cyclic payload once', () => {
    const cyclic: Record<string, unknown> = { screen: 'consultation' };
    cyclic.self = cyclic;
    const found = collectStrings(cyclic);
    expect(found.filter((entry) => entry === 'consultation')).toHaveLength(1);
    expect(() => collectStrings(cyclic)).not.toThrow();
  });
});

/* ========================================================================= */

/**
 * *** THE SHIPPED COPY IS ITSELF SCREENED, IN CI. ***
 *
 * `notification.seed.ts` re-checks this before writing to a database, but a
 * test is what makes a bad edit fail before it is ever merged. Without this,
 * "no notification names a diagnosis" would be a property of the code paths
 * and not of the words the platform actually sends on day one.
 */
describe('the compiled-in default template copy', () => {
  const entries = Object.entries(NOTIFICATION_TEMPLATE_DEFAULTS);

  it('ships copy for all nine codes the schema names', () => {
    expect(entries).toHaveLength(9);
  });

  it.each(entries)('%s: the title names no diagnosis', (_code, template) => {
    expect(screenForDiagnosis(template.title)).toEqual({ clean: true, construction: null });
  });

  it.each(entries)('%s: the body names no diagnosis', (_code, template) => {
    expect(screenForDiagnosis(template.body)).toEqual({ clean: true, construction: null });
  });
});

describe('the deny-list itself', () => {
  it('has no blank or whitespace-only entries, which would match everything', () => {
    for (const entry of DIAGNOSIS_DENY_LIST) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DIAGNOSIS_DENY_LIST).size).toBe(DIAGNOSIS_DENY_LIST.length);
  });

  /** A one- or two-character entry is the initials problem the header documents; none should have slipped in. */
  it('has no entry short enough to fire on someone-s initials', () => {
    for (const entry of DIAGNOSIS_DENY_LIST) {
      expect(normalize(entry.replace(/\*$/, '')).length).toBeGreaterThanOrEqual(3);
    }
  });
});
