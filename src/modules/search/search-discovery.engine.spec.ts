import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import type { ListedDoctorSummary } from '../doctor/doctor.contract';
import { ConcernMatcherService } from './concern-matcher.service';
import { DoctorRankerService } from './doctor-ranker.service';
import { ResponseValidatorService } from './response-validator.service';
import {
  buildResolvableReferences,
  createInitialState,
  runDiscoveryPipeline,
  stageAssemble,
  stageCrisisGate,
  stageInterpret,
  stageMapConcernsToSpecialties,
  stageRank,
  stageValidate,
  type DiscoveryPorts,
  type DiscoveryRuntimeConfig,
  type DiscoveryTaxonomy,
} from './search-discovery.engine';
import type { DiscoveryRequest } from './search.contract';
import { SEARCH_DISCLAIMER, SEARCH_TEMPLATE_GUIDANCE } from './search.constants';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-09-07T00:00:00Z');

function specialty(overrides: Partial<PublicSpecialty> & { code: string }): PublicSpecialty {
  return {
    id: `sp-${overrides.code}`,
    name: overrides.code,
    description: null,
    canPrescribe: false,
    intakeForm: null,
    firstConsultForm: null,
    requiredDocuments: [],
    isActive: true,
    ...overrides,
  };
}

function concern(overrides: Partial<PublicConcern> & { code: string }): PublicConcern {
  return {
    id: `c-${overrides.code}`,
    specialtyId: 'sp-psychiatry',
    name: overrides.code,
    matchPhrases: [],
    matchWeight: 5,
    isActive: true,
    ...overrides,
  };
}

const PSYCHIATRY = specialty({ code: 'psychiatry', name: 'Psychiatry' });
const PSYCHOLOGY = specialty({ code: 'psychology', name: 'Psychology' });
const SLEEP = concern({ code: 'sleep', name: 'Sleep problems', matchPhrases: ['cannot sleep', 'neend nahi aati'] });
const ANXIETY = concern({ code: 'anxiety', name: 'Anxiety and stress', matchPhrases: ['panic at night', 'ghabrahat'] });
const CHILD = concern({ code: 'child_adolescent', name: 'Child concerns', specialtyId: PSYCHOLOGY.id, matchPhrases: ['my child'] });

const TAXONOMY: DiscoveryTaxonomy = { specialties: [PSYCHIATRY, PSYCHOLOGY], concerns: [SLEEP, ANXIETY, CHILD] };

const CONFIG: DiscoveryRuntimeConfig = {
  maxResults: 20,
  availabilityLookaheadDays: 14,
  candidatePoolLimit: 60,
  crisisGuidance: {
    message: 'Please reach out to one of these services right now.',
    helplines: [{ name: 'Tele-MANAS', phone: '14416', availability: '24x7' }],
  },
  popularSearches: [{ label: 'Trouble sleeping', query: 'i cannot sleep' }],
};

function doctorFixture(overrides: Partial<ListedDoctorSummary> & { id: string }): ListedDoctorSummary {
  return {
    fullName: `Dr ${overrides.id}`,
    languages: ['English', 'Hindi'],
    qualification: 'MD',
    registrationNumber: 'REG-1',
    yearsOfExperience: 8,
    consultationFeeInr: '1000.00',
    consultationDurationMinutes: 30,
    specialties: [{ id: PSYCHIATRY.id, code: PSYCHIATRY.code, name: PSYCHIATRY.name, isPrimary: true }],
    ...overrides,
  };
}

const AI_OUTPUT = {
  concernCodes: ['sleep', 'anxiety'],
  professionalTypes: ['psychiatry'],
  guidance: 'You can talk to a {{specialty:psychiatry}} about {{concern:sleep}}.',
};

/** Hand-rolled fakes for every port, with jest.fn() spies so "was this ever called" is assertable. */
function createPorts(overrides: Partial<DiscoveryPorts> = {}) {
  const screen = jest.fn().mockResolvedValue({ fired: false, matchedKeyword: null });
  const isAiEnabled = jest.fn().mockResolvedValue(false);
  const interpret = jest.fn().mockResolvedValue({ source: 'deterministic', reason: 'unavailable' });
  const listListedDoctors = jest.fn().mockResolvedValue([doctorFixture({ id: 'doctor-a' })]);
  const getEarliestBookableSlots = jest
    .fn()
    .mockResolvedValue([{ doctorId: 'doctor-a', earliestStartsAt: new Date(NOW.getTime() + 3600_000) }]);
  const consumeAiBudget = jest.fn().mockResolvedValue(undefined);

  const ports: DiscoveryPorts = {
    crisis: { screen },
    interpreter: { isAiEnabled, interpret },
    matcher: new ConcernMatcherService(),
    doctors: { listListedDoctors },
    availability: { getEarliestBookableSlots },
    ranker: new DoctorRankerService(),
    validator: new ResponseValidatorService(),
    rateLimiter: { consumeAiBudget },
    ...overrides,
  };

  return { ports, screen, isAiEnabled, interpret, listListedDoctors, getEarliestBookableSlots, consumeAiBudget };
}

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return { patientId: 'patient-1', source: 'app', queryText: 'i cannot sleep', ...overrides };
}

function run(ports: DiscoveryPorts, req: DiscoveryRequest = request()) {
  return runDiscoveryPipeline(req, ports, CONFIG, TAXONOMY, NOW);
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — crisis gate                                                       */
/* -------------------------------------------------------------------------- */

describe('stage 1 — the crisis gate short-circuit', () => {
  function crisisPorts() {
    const created = createPorts();
    created.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });
    return created;
  }

  it('runs the gate FIRST, before anything else', async () => {
    const { ports, screen } = createPorts();
    const state = await stageCrisisGate(createInitialState(request(), CONFIG, TAXONOMY, NOW), ports);
    expect(screen).toHaveBeenCalledWith('i cannot sleep');
    expect(state.crisis.fired).toBe(false);
  });

  it('NEVER CALLS THE AI PORT when the guardrail fires', async () => {
    const { ports, isAiEnabled, interpret } = crisisPorts();

    await run(ports, request({ queryText: 'i want to die' }));

    expect(isAiEnabled).not.toHaveBeenCalled();
    expect(interpret).not.toHaveBeenCalled();
  });

  it('NEVER CONSUMES AI BUDGET when the guardrail fires — a throttle must not be able to swallow a safety response', async () => {
    const { ports, consumeAiBudget } = crisisPorts();
    await run(ports, request({ queryText: 'i want to die' }));
    expect(consumeAiBudget).not.toHaveBeenCalled();
  });

  it('NEVER READS DOCTORS OR AVAILABILITY when the guardrail fires', async () => {
    const { ports, listListedDoctors, getEarliestBookableSlots } = crisisPorts();

    await run(ports, request({ queryText: 'i want to die' }));

    expect(listListedDoctors).not.toHaveBeenCalled();
    expect(getEarliestBookableSlots).not.toHaveBeenCalled();
  });

  it('returns ZERO doctor results and the emergency guidance INSTEAD of them', async () => {
    const { ports } = crisisPorts();

    const { response } = await run(ports, request({ queryText: 'i want to die' }));

    expect(response.results).toEqual([]);
    expect(response.meta.resultCount).toBe(0);
    expect(response.crisis).toEqual({ message: CONFIG.crisisGuidance.message, helplines: CONFIG.crisisGuidance.helplines });
    expect(response.matchedConcerns).toEqual([]);
    expect(response.matchedSpecialties).toEqual([]);
  });

  it('reports crisisGuardrailFired: true, which is what gets logged to search_queries', async () => {
    const { ports } = crisisPorts();
    const { state, response } = await run(ports, request({ queryText: 'i want to die' }));

    expect(response.meta.crisisGuardrailFired).toBe(true);
    expect(state.crisis).toEqual({ fired: true, matchedKeyword: 'want to die' });
  });

  it('puts the crisis message in guidance.text too, so a UI that renders only guidance still shows it', async () => {
    const { ports } = crisisPorts();
    const { response } = await run(ports, request({ queryText: 'i want to die' }));

    expect(response.guidance.text).toBe(CONFIG.crisisGuidance.message);
    expect(response.guidance.source).toBe('template');
  });

  it('still carries the disclaimer and browse suggestions', async () => {
    const { ports } = crisisPorts();
    const { response } = await run(ports, request({ queryText: 'i want to die' }));

    expect(response.disclaimer).toBe(SEARCH_DISCLAIMER);
    expect(response.suggestions.concerns.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 2 — kill switch and AI failure                                        */
/* -------------------------------------------------------------------------- */

describe('stage 2 — the kill switch', () => {
  it('NEVER CALLS THE AI when search.ai_enabled is off, and still returns sensible matches', async () => {
    const { ports, interpret, consumeAiBudget } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(false);

    const { response } = await run(ports);

    expect(interpret).not.toHaveBeenCalled();
    expect(consumeAiBudget).not.toHaveBeenCalled();
    expect(response.meta.interpretation).toBe('deterministic');
    expect(response.meta.aiEnabled).toBe(false);
    expect(response.matchedConcerns.map((c) => c.code)).toEqual(['sleep']);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it('consumes AI budget ONLY when the interpreter says it is about to call the model', async () => {
    const { ports, consumeAiBudget } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    // A real interpreter invokes the callback only after the kill switch and
    // the availability probe have both passed.
    (ports.interpreter.interpret as jest.Mock).mockImplementation(async (_q, _s, _c, beforeModelCall) => {
      await beforeModelCall?.();
      return { source: 'ai', value: AI_OUTPUT, model: 'm', latencyMs: 1 };
    });

    await stageInterpret(createInitialState(request(), CONFIG, TAXONOMY, NOW), ports);

    expect(consumeAiBudget).toHaveBeenCalledWith('patient-1', 'app');
  });

  it('does NOT consume AI budget when the interpreter never reaches the model (outage)', async () => {
    const { ports, consumeAiBudget } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    // An unavailable port never invokes the callback.
    (ports.interpreter.interpret as jest.Mock).mockResolvedValue({ source: 'deterministic', reason: 'unavailable' });

    await stageInterpret(createInitialState(request(), CONFIG, TAXONOMY, NOW), ports);

    expect(consumeAiBudget).not.toHaveBeenCalled();
  });

  it('propagates a rate-limit throw from the budget port (429 reaches the caller, never a silent fallback)', async () => {
    const { ports } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (ports.interpreter.interpret as jest.Mock).mockImplementation(async (_q, _s, _c, beforeModelCall) => {
      await beforeModelCall?.();
      return { source: 'ai', value: AI_OUTPUT, model: 'm', latencyMs: 1 };
    });
    (ports.rateLimiter.consumeAiBudget as jest.Mock).mockRejectedValue(new Error('SEARCH_RATE_LIMITED'));

    await expect(run(ports)).rejects.toThrow('SEARCH_RATE_LIMITED');
  });
});

describe('stage 2/3 — AI failure falls back with nothing surfaced to the patient', () => {
  it.each([['unavailable'], ['call_failed'], ['invalid_output']])('falls back on reason %p', async (reason) => {
    const { ports } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (ports.interpreter.interpret as jest.Mock).mockResolvedValue({ source: 'deterministic', reason });

    const { response } = await run(ports);

    expect(response.meta.interpretation).toBe('deterministic');
    expect(response.matchedConcerns.map((c) => c.code)).toEqual(['sleep']);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.guidance.source).toBe('template');
  });

  it('falls back to the matcher when EVERY model-supplied code is unresolvable', async () => {
    const { ports } = createPorts();
    (ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (ports.interpreter.interpret as jest.Mock).mockResolvedValue({
      source: 'ai',
      value: { concernCodes: ['invented_one', 'invented_two'], professionalTypes: [], guidance: 'Talk to someone.' },
      model: 'm',
      latencyMs: 1,
    });

    const { response } = await run(ports);

    // The matcher rescued the query from the model's invented codes.
    expect(response.matchedConcerns.map((c) => c.code)).toEqual(['sleep']);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 3 — token validation                                                  */
/* -------------------------------------------------------------------------- */

describe('stage 3 — reference tokens, the hallucination guard', () => {
  function aiPorts(guidance: string, concernCodes = ['sleep']) {
    const created = createPorts();
    (created.ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (created.ports.interpreter.interpret as jest.Mock).mockResolvedValue({
      source: 'ai',
      value: { concernCodes, professionalTypes: ['psychiatry'], guidance },
      model: 'm',
      latencyMs: 1,
    });
    return created;
  }

  it('accepts model prose whose every token resolves, and returns BOTH the tokenised text and resolved references', async () => {
    const { ports } = aiPorts(AI_OUTPUT.guidance);

    const { response } = await run(ports);

    expect(response.guidance.source).toBe('model');
    expect(response.guidance.text).toBe(AI_OUTPUT.guidance);
    expect(response.guidance.references.map((r) => r.token)).toEqual(['{{specialty:psychiatry}}', '{{concern:sleep}}']);
    expect(response.guidance.references[0]).toMatchObject({
      type: 'specialty',
      id: PSYCHIATRY.id,
      code: 'psychiatry',
      label: 'Psychiatry',
      deepLink: `/search/doctors?specialtyId=${PSYCHIATRY.id}`,
    });
  });

  it('DISCARDS the whole prose and uses the template when a token is unresolvable', async () => {
    jest.spyOn(ResponseValidatorService.prototype, 'validate');
    const { ports } = aiPorts('Try a {{specialty:neurosurgery}} for this.');

    const { response } = await run(ports);

    expect(response.guidance.source).toBe('template');
    expect(response.guidance.text).not.toContain('neurosurgery');
    expect(response.guidance.text).toContain(SEARCH_TEMPLATE_GUIDANCE.withMatches);
    jest.restoreAllMocks();
  });

  it('treats a token naming an INACTIVE concern as unresolvable', async () => {
    const retiredTaxonomy: DiscoveryTaxonomy = {
      specialties: TAXONOMY.specialties,
      concerns: [SLEEP, { ...ANXIETY, isActive: false }],
    };
    const { ports } = aiPorts('About {{concern:anxiety}} you can see a {{specialty:psychiatry}}.');

    const { response } = await runDiscoveryPipeline(request(), ports, CONFIG, retiredTaxonomy, NOW);

    expect(response.guidance.source).toBe('template');
    expect(response.guidance.text).not.toContain('{{concern:anxiety}}');
  });

  it('DISCARDS prose containing diagnostic language even when every token resolves', async () => {
    const { ports } = aiPorts('You may have a problem — see a {{specialty:psychiatry}}.');

    const { response } = await run(ports);

    expect(response.guidance.source).toBe('template');
  });

  it('keeps the concern mapping even when the prose is rejected — only the words are discarded', async () => {
    const { ports } = aiPorts('You may have insomnia.', ['sleep']);

    const { response } = await run(ports);

    expect(response.guidance.source).toBe('template');
    expect(response.matchedConcerns.map((c) => c.code)).toEqual(['sleep']);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it('de-duplicates repeated tokens in the references array', async () => {
    const { ports } = aiPorts('{{concern:sleep}} and again {{concern:sleep}}.');
    const { response } = await run(ports);
    expect(response.guidance.references).toHaveLength(1);
  });
});

describe('buildResolvableReferences', () => {
  it('includes only ACTIVE specialties and concerns', () => {
    const references = buildResolvableReferences({
      specialties: [PSYCHIATRY, { ...PSYCHOLOGY, isActive: false }],
      concerns: [SLEEP, { ...ANXIETY, isActive: false }],
    });

    expect([...references.keys()].sort()).toEqual(['{{concern:sleep}}', '{{specialty:psychiatry}}']);
  });

  it('gives a concern a deep link to its own specialty, so every chip lands somewhere real', () => {
    const references = buildResolvableReferences(TAXONOMY);
    expect(references.get('{{concern:child_adolescent}}')?.deepLink).toBe(`/search/doctors?specialtyId=${PSYCHOLOGY.id}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 4 — mapping                                                           */
/* -------------------------------------------------------------------------- */

describe('stage 4 — concerns map to specialties', () => {
  const matcher = new ConcernMatcherService();

  it('SUMS concern scores onto their specialty', () => {
    const matches = matcher.match('cannot sleep, panic at night', TAXONOMY.concerns);
    const mapped = stageMapConcernsToSpecialties(matches, TAXONOMY);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.specialtyCode).toBe('psychiatry');
    expect(mapped[0]?.concernNames.sort()).toEqual(['Anxiety and stress', 'Sleep problems']);
    expect(mapped[0]?.score).toBeCloseTo(matches[0]!.score + matches[1]!.score);
  });

  it('orders specialties by score desc, then code asc — total and stable', () => {
    const matches = matcher.match('my child cannot sleep', TAXONOMY.concerns);
    const mapped = stageMapConcernsToSpecialties(matches, TAXONOMY);
    expect(mapped.map((m) => m.specialtyCode)).toEqual(['psychiatry', 'psychology']);
  });

  it('DROPS a concern whose specialty has been deactivated', () => {
    const matches = matcher.match('my child needs help', TAXONOMY.concerns);
    const mapped = stageMapConcernsToSpecialties(matches, {
      specialties: [PSYCHIATRY, { ...PSYCHOLOGY, isActive: false }],
      concerns: TAXONOMY.concerns,
    });
    expect(mapped).toEqual([]);
  });

  it('returns an empty list for no concern matches', () => {
    expect(stageMapConcernsToSpecialties([], TAXONOMY)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 5 — ranking                                                           */
/* -------------------------------------------------------------------------- */

describe('stage 5 — ranking', () => {
  it('fetches candidates for the MATCHED specialties only, and batches availability in one call', async () => {
    const { ports, listListedDoctors, getEarliestBookableSlots } = createPorts();
    listListedDoctors.mockResolvedValue([doctorFixture({ id: 'doctor-a' }), doctorFixture({ id: 'doctor-b' })]);
    getEarliestBookableSlots.mockResolvedValue([
      { doctorId: 'doctor-a', earliestStartsAt: new Date(NOW.getTime() + 3600_000) },
      { doctorId: 'doctor-b', earliestStartsAt: null },
    ]);

    await run(ports);

    expect(listListedDoctors).toHaveBeenCalledWith(expect.objectContaining({ specialtyIds: [PSYCHIATRY.id] }));
    // ONE availability call for the whole candidate set, not one per doctor.
    expect(getEarliestBookableSlots).toHaveBeenCalledTimes(1);
    expect(getEarliestBookableSlots.mock.calls[0][0]).toEqual(['doctor-a', 'doctor-b']);
  });

  it('returns NO doctors when nothing mapped — every result must carry a reason', async () => {
    const { ports, listListedDoctors } = createPorts();

    const ranked = await stageRank(
      { ...createInitialState(request(), CONFIG, TAXONOMY, NOW), specialtyMatches: [] },
      ports,
    );

    expect(ranked).toEqual([]);
    expect(listListedDoctors).not.toHaveBeenCalled();
  });

  it('passes the request filters through to the ranker', async () => {
    const { ports, listListedDoctors } = createPorts();

    await run(ports, request({ languages: ['Hindi'], maxFeeInr: '1500' }));

    expect(listListedDoctors).toHaveBeenCalledWith(expect.objectContaining({ languages: ['Hindi'], maxFeeInr: '1500' }));
  });

  it('returns an empty result set (not an error) when the candidate pool is empty', async () => {
    const { ports, listListedDoctors, getEarliestBookableSlots } = createPorts();
    listListedDoctors.mockResolvedValue([]);

    const { response } = await run(ports);

    expect(response.results).toEqual([]);
    expect(getEarliestBookableSlots).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 6 — assembly                                                          */
/* -------------------------------------------------------------------------- */

describe('stage 6 — the single payload all three UI concepts render from', () => {
  it('carries every top-level key, so no UI concept needs a backend change', async () => {
    const { ports } = createPorts();
    const { response } = await run(ports);

    expect(Object.keys(response).sort()).toEqual([
      'crisis',
      'disclaimer',
      'guidance',
      'matchedConcerns',
      'matchedSpecialties',
      'meta',
      'results',
      'suggestions',
    ]);
  });

  it('shows the FR-5.8 disclaimer on every response', async () => {
    const { ports } = createPorts();
    const { response } = await run(ports);
    expect(response.disclaimer).toBe(SEARCH_DISCLAIMER);
  });

  it('renders each result with the FR-4.2 listing fields and the FR-5.4 reason', async () => {
    const { ports } = createPorts();
    const { response } = await run(ports);

    expect(response.results[0]).toMatchObject({
      doctorId: 'doctor-a',
      fullName: 'Dr doctor-a',
      qualification: 'MD',
      registrationNumber: 'REG-1',
      yearsOfExperience: 8,
      languages: ['English', 'Hindi'],
      consultationFeeInr: '1000.00',
      reason: 'Matched to: Sleep problems',
    });
    expect(response.results[0]?.earliestSlotAt).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
  });

  it('always populates browse suggestions (FR-5.3), including popular searches', async () => {
    const { ports } = createPorts();
    const { response } = await run(ports);

    expect(response.suggestions.concerns.map((c) => c.code).sort()).toEqual(['anxiety', 'child_adolescent', 'sleep']);
    expect(response.suggestions.specialties.map((s) => s.code).sort()).toEqual(['psychiatry', 'psychology']);
    expect(response.suggestions.popular).toEqual(CONFIG.popularSearches);
  });

  it('handles a zero-match query as a 200 with somewhere to go, never an error', async () => {
    const { ports } = createPorts();

    const { response } = await run(ports, request({ queryText: 'where do i park my car' }));

    expect(response.results).toEqual([]);
    expect(response.matchedConcerns).toEqual([]);
    expect(response.guidance.text).toBe(SEARCH_TEMPLATE_GUIDANCE.noMatches);
    expect(response.suggestions.concerns.length).toBeGreaterThan(0);
    expect(response.crisis).toBeNull();
  });

  it('excludes an inactive concern/specialty from browse suggestions', () => {
    const response = stageAssemble({
      ...createInitialState(request(), CONFIG, { specialties: [PSYCHIATRY, { ...PSYCHOLOGY, isActive: false }], concerns: [SLEEP, { ...ANXIETY, isActive: false }] }, NOW),
    });

    expect(response.suggestions.concerns.map((c) => c.code)).toEqual(['sleep']);
    expect(response.suggestions.specialties.map((s) => s.code)).toEqual(['psychiatry']);
  });

  it('builds template guidance whose tokens always resolve', async () => {
    const { ports } = createPorts();
    const { response } = await run(ports);

    expect(response.guidance.source).toBe('template');
    expect(response.guidance.text).toContain('{{specialty:psychiatry}}');
    expect(response.guidance.references).toHaveLength(1);
    expect(response.guidance.references[0]?.label).toBe('Psychiatry');
  });
});

/* -------------------------------------------------------------------------- */
/* Shape equivalence across paths                                              */
/* -------------------------------------------------------------------------- */

describe('every path produces the SAME response shape', () => {
  it('AI path, deterministic path and crisis path all share the same top-level keys', async () => {
    const keysOf = (value: object) => Object.keys(value).sort();

    const deterministic = await run(createPorts().ports);

    const ai = createPorts();
    (ai.ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (ai.ports.interpreter.interpret as jest.Mock).mockResolvedValue({ source: 'ai', value: AI_OUTPUT, model: 'm', latencyMs: 1 });
    const aiRun = await run(ai.ports);

    const crisis = createPorts();
    crisis.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });
    const crisisRun = await run(crisis.ports);

    expect(keysOf(aiRun.response)).toEqual(keysOf(deterministic.response));
    expect(keysOf(crisisRun.response)).toEqual(keysOf(deterministic.response));
    expect(keysOf(aiRun.response.meta)).toEqual(keysOf(crisisRun.response.meta));
  });

  it('reports honestly which path ran', async () => {
    const ai = createPorts();
    (ai.ports.interpreter.isAiEnabled as jest.Mock).mockResolvedValue(true);
    (ai.ports.interpreter.interpret as jest.Mock).mockResolvedValue({ source: 'ai', value: AI_OUTPUT, model: 'm', latencyMs: 1 });

    await expect(run(ai.ports).then((r) => r.response.meta.interpretation)).resolves.toBe('ai');
    await expect(run(createPorts().ports).then((r) => r.response.meta.interpretation)).resolves.toBe('deterministic');
  });
});

/* -------------------------------------------------------------------------- */
/* stageValidate directly                                                      */
/* -------------------------------------------------------------------------- */

describe('stageValidate (called directly, no pipeline)', () => {
  it('runs the matcher on the deterministic path', () => {
    const { ports } = createPorts();
    const state = { ...createInitialState(request(), CONFIG, TAXONOMY, NOW), interpretation: { source: 'deterministic' as const, reason: 'kill_switch' as const } };

    const result = stageValidate(state, ports);

    expect(result.concernMatches.map((m) => m.concern.code)).toEqual(['sleep']);
    expect(result.guidance).toBeNull();
  });

  it('honours preselected concerns on the AI path too (FR-5.5, both paths identical)', () => {
    const { ports } = createPorts();
    const state = {
      ...createInitialState(request({ preselectedConcernIds: [CHILD.id] }), CONFIG, TAXONOMY, NOW),
      interpretation: { source: 'ai' as const, value: { concernCodes: ['sleep'], professionalTypes: [], guidance: 'ok' }, model: 'm', latencyMs: 1 },
    };

    const result = stageValidate(state, ports);

    expect(result.concernMatches.map((m) => m.concern.code).sort()).toEqual(['child_adolescent', 'sleep']);
  });
});
