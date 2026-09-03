import { screenForDiagnosis } from './notification-diagnosis.util';
import {
  BODY_MAX_LENGTH,
  TEMPLATE_CODE_PATTERN,
  TITLE_MAX_LENGTH,
  declaredVariables,
  extractPlaceholders,
  lookupTemplate,
  parseTemplate,
  parseTemplateSet,
  renderTemplate,
} from './notification-template.util';

const BOOKING = {
  title: 'Appointment confirmed',
  body: 'Your consultation with {{doctorName}} is confirmed for {{scheduledAt}}.',
};

describe('extractPlaceholders', () => {
  it('finds every distinct placeholder, in order of first appearance', () => {
    expect(extractPlaceholders('{{b}} then {{a}} then {{b}} again')).toEqual(['b', 'a']);
  });

  it('returns nothing for copy with no placeholders', () => {
    expect(extractPlaceholders('Your prescription is ready')).toEqual([]);
  });

  it.each([
    ['{{ spaced }}', 'a name may not be padded'],
    ['{{9leading}}', 'a name must start with a letter'],
    ['{{has-dash}}', 'a name is letters, digits and underscores'],
    ['{single}', 'single braces are not a placeholder'],
    ['{{}}', 'an empty name is not a placeholder'],
  ])('ignores %s (%s)', (text) => {
    expect(extractPlaceholders(text)).toEqual([]);
  });

  /** A module-level regex with the `g` flag carries `lastIndex` between calls; a fresh one per call is what stops the second call returning half the matches. */
  it('is stable across repeated calls', () => {
    expect(extractPlaceholders(BOOKING.body)).toEqual(['doctorName', 'scheduledAt']);
    expect(extractPlaceholders(BOOKING.body)).toEqual(['doctorName', 'scheduledAt']);
    expect(extractPlaceholders(BOOKING.body)).toEqual(['doctorName', 'scheduledAt']);
  });
});

describe('declaredVariables', () => {
  it('unions the title and the body without repeating a name that is in both', () => {
    expect(
      declaredVariables({ title: '{{doctorName}} has joined', body: '{{doctorName}} is waiting for {{patientName}}' }),
    ).toEqual(['doctorName', 'patientName']);
  });

  /** Derived from the copy, never stored — a stored list could drift from the copy it describes. */
  it('is empty for copy with no placeholders', () => {
    expect(declaredVariables({ title: 'Approved', body: 'Your account has been verified.' })).toEqual([]);
  });
});

/* ========================================================================= */

describe('renderTemplate', () => {
  it('substitutes a declared variable into the title and the body', () => {
    const rendered = renderTemplate(BOOKING, { doctorName: 'Dr Rao', scheduledAt: '10:30 am' });

    expect(rendered.title).toBe('Appointment confirmed');
    expect(rendered.body).toBe('Your consultation with Dr Rao is confirmed for 10:30 am.');
    expect(rendered.unresolved).toEqual([]);
    expect(rendered.ignored).toEqual([]);
  });

  it('accepts a numeric value', () => {
    const rendered = renderTemplate({ title: 't', body: 'You have {{seconds}} seconds.' }, { seconds: 45 });
    expect(rendered.body).toBe('You have 45 seconds.');
  });

  /* --- FR-16.2, LAYER 2 -------------------------------------------------- */

  /**
   * *** THE SUBSTITUTION IS AN ALLOW-LIST, NOT A MERGE. ***
   *
   * This is the STRUCTURAL half of FR-16.2, and the half that is an actual
   * guarantee rather than a heuristic: a value is used only where its name
   * already appears as a placeholder in this template's own copy, so a
   * caller passing clinical text under a name the template does not declare
   * cannot put those words in a body. The deny-list never even sees it,
   * because it is never used.
   */
  it('DROPS a variable the template does not declare, and reports it as ignored', () => {
    const rendered = renderTemplate(BOOKING, {
      doctorName: 'Dr Rao',
      scheduledAt: '10:30 am',
      diagnosis: 'type 2 diabetes',
    });

    expect(rendered.body).toBe('Your consultation with Dr Rao is confirmed for 10:30 am.');
    expect(rendered.body).not.toContain('diabetes');
    expect(rendered.title).not.toContain('diabetes');
    expect(rendered.ignored).toEqual(['diagnosis']);
    // And the rendered result is clean even though the caller passed a
    // diagnosis — because it was never substituted, not because it was
    // screened out.
    expect(screenForDiagnosis(rendered.body).clean).toBe(true);
  });

  it('drops every undeclared variable, not just the first', () => {
    const rendered = renderTemplate(BOOKING, { condition: 'x', notes: 'y', icd10: 'z' });
    expect(rendered.ignored).toEqual(['condition', 'notes', 'icd10']);
  });

  /**
   * *** SUBSTITUTION IS SINGLE-PASS. ***
   * A value containing `{{something}}` is inserted literally and never
   * re-scanned. A second pass would let a caller-supplied value name a
   * placeholder and pull in another variable — template injection, and a way
   * around the allow-list above.
   */
  it('does not re-scan a substituted value, so a value cannot name another placeholder', () => {
    const rendered = renderTemplate(
      { title: 't', body: 'Hello {{name}}' },
      { name: '{{secret}}', secret: 'type 2 diabetes' },
    );

    expect(rendered.body).toBe('Hello {{secret}}');
    expect(rendered.body).not.toContain('diabetes');
  });

  /** `String.replace` treats `$&`, `$1` and friends specially in a replacement STRING; the callback form returns its value literally. */
  it('inserts a value containing $-sequences literally', () => {
    const rendered = renderTemplate({ title: 't', body: 'Fee {{amount}}' }, { amount: '$&500' });
    expect(rendered.body).toBe('Fee $&500');
  });

  /* --- Unresolved placeholders ------------------------------------------ */

  /**
   * `notify` is best-effort and must never fail a caller's flow, so the
   * choice is between a slightly awkward sentence and no booking confirmation
   * at all. The caller's bug is still visible: `unresolved` is returned and
   * the service logs it.
   */
  it('removes an unresolved placeholder and tidies the whitespace it leaves behind', () => {
    const rendered = renderTemplate(BOOKING, { scheduledAt: '10:30 am' });

    expect(rendered.body).toBe('Your consultation with is confirmed for 10:30 am.');
    expect(rendered.body).not.toContain('{{');
    expect(rendered.unresolved).toEqual(['doctorName']);
  });

  it('tidies the space in front of a full stop when the trailing placeholder is unresolved', () => {
    const rendered = renderTemplate({ title: 't', body: 'Confirmed for {{scheduledAt}}.' }, {});
    expect(rendered.body).toBe('Confirmed for.');
  });

  it('treats no variables at all the same as an empty object', () => {
    expect(renderTemplate(BOOKING).unresolved).toEqual(['doctorName', 'scheduledAt']);
  });

  it('reports each unresolved name once even when it appears twice', () => {
    const rendered = renderTemplate({ title: '{{who}}', body: '{{who}} and {{who}}' }, {});
    expect(rendered.unresolved).toEqual(['who']);
  });

  /* --- Bounds ------------------------------------------------------------ */

  /**
   * `notifications.title` is `varchar(200)`. A longer render would be a
   * Postgres ERROR on insert, not a truncation — and `notify` would then
   * report `queued: false` for a notification that was perfectly fine apart
   * from one long variable.
   */
  it('bounds the title to the varchar(200) the column allows', () => {
    const rendered = renderTemplate({ title: '{{n}}', body: 'b' }, { n: 'x'.repeat(500) });
    expect(rendered.title).toHaveLength(TITLE_MAX_LENGTH);
  });

  it('bounds the body to the push-payload ceiling', () => {
    const rendered = renderTemplate({ title: 't', body: '{{n}}' }, { n: 'x'.repeat(BODY_MAX_LENGTH + 500) });
    expect(rendered.body).toHaveLength(BODY_MAX_LENGTH);
  });

  /**
   * Truncation happens BEFORE the service screens the rendered copy, so the
   * screen always sees exactly the bytes that will be stored and sent. It can
   * only ever remove text, never introduce a construction.
   */
  it('truncates before anything screens it, so the screen sees what will be stored', () => {
    const rendered = renderTemplate({ title: 't', body: '{{n}}' }, { n: `${'x'.repeat(BODY_MAX_LENGTH)} diabetes` });
    expect(rendered.body).toHaveLength(BODY_MAX_LENGTH);
    expect(rendered.body).not.toContain('diabetes');
  });
});

/* ========================================================================= */

describe('parseTemplate — app_config.value is untyped jsonb', () => {
  it('accepts well-formed copy', () => {
    expect(parseTemplate(BOOKING)).toEqual(BOOKING);
  });

  it.each([
    [null],
    [undefined],
    ['a string'],
    [42],
    [[]],
    [{}],
    [{ title: 'only a title' }],
    [{ body: 'only a body' }],
    [{ title: '', body: 'b' }],
    [{ title: '   ', body: 'b' }],
    [{ title: 't', body: '' }],
    [{ title: 1, body: 'b' }],
    [{ title: 't', body: { nested: true } }],
  ])('rejects the malformed entry %s', (value) => {
    expect(parseTemplate(value)).toBeNull();
  });

  it('rejects copy longer than its column allows rather than storing something that cannot be inserted', () => {
    expect(parseTemplate({ title: 'x'.repeat(TITLE_MAX_LENGTH + 1), body: 'b' })).toBeNull();
    expect(parseTemplate({ title: 't', body: 'x'.repeat(BODY_MAX_LENGTH + 1) })).toBeNull();
  });
});

describe('parseTemplateSet', () => {
  it('keeps the entries it can parse', () => {
    expect(parseTemplateSet({ booking_confirmed: BOOKING })).toEqual({ booking_confirmed: BOOKING });
  });

  /**
   * A single malformed entry must not take down every other template. A
   * template that half-parses is worse than one that is absent — an absent
   * one falls back to the compiled-in default.
   */
  it('DROPS a malformed entry rather than throwing or repairing it, leaving the rest intact', () => {
    expect(parseTemplateSet({ booking_confirmed: BOOKING, broken: { title: 'no body' } })).toEqual({
      booking_confirmed: BOOKING,
    });
  });

  it('drops an entry whose code is not a legal template code', () => {
    expect(parseTemplateSet({ 'Not A Code': BOOKING, __proto__: BOOKING, ok_code: BOOKING })).toEqual({
      ok_code: BOOKING,
    });
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])('returns an empty set for the non-object %s', (value) => {
    expect(parseTemplateSet(value)).toEqual({});
  });
});

describe('lookupTemplate — a code must not fall through to Object.prototype', () => {
  it('returns a stored template', () => {
    expect(lookupTemplate({ booking_confirmed: BOOKING }, 'booking_confirmed')).toEqual(BOOKING);
  });

  it('returns null for a code that is absent', () => {
    expect(lookupTemplate({ booking_confirmed: BOOKING }, 'nope')).toBeNull();
  });

  /**
   * `TEMPLATE_CODE_PATTERN` refuses `__proto__` (a code must start with a
   * letter) but `constructor`, `toString` and `valueOf` all match it — and a
   * bare `set['constructor']` on an object literal returns a FUNCTION rather
   * than `undefined`. Without `hasOwnProperty`, `templateCode: 'constructor'`
   * would render `[object Object]` to a patient instead of taking the
   * `template_missing` path.
   */
  it.each([['constructor'], ['toString'], ['valueOf'], ['hasOwnProperty']])(
    'returns null for the inherited property %s',
    (code) => {
      expect(lookupTemplate({ booking_confirmed: BOOKING }, code)).toBeNull();
    },
  );
});

describe('TEMPLATE_CODE_PATTERN', () => {
  it.each([['booking_confirmed'], ['red_flag_alert'], ['abc'], ['a1_2'], [`a${'b'.repeat(79)}`]])(
    'accepts %s',
    (code) => {
      expect(TEMPLATE_CODE_PATTERN.test(code)).toBe(true);
    },
  );

  it.each([
    ['ab'],
    ['1abc'],
    ['_abc'],
    ['Booking_Confirmed'],
    ['booking-confirmed'],
    ['booking confirmed'],
    ['__proto__'],
    [`a${'b'.repeat(80)}`],
    [''],
  ])('refuses %s', (code) => {
    expect(TEMPLATE_CODE_PATTERN.test(code)).toBe(false);
  });

  /** `notifications.template_code` is `varchar(80)`, so the pattern's own ceiling has to match it exactly. */
  it('caps at the 80 characters the column holds', () => {
    expect(TEMPLATE_CODE_PATTERN.test('a'.repeat(80))).toBe(true);
    expect(TEMPLATE_CODE_PATTERN.test('a'.repeat(81))).toBe(false);
  });
});
