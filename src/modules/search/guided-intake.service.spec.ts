import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicConcern } from '../catalogue/catalogue.contract';
import { GuidedIntakeService, buildGuidedQueryText, type GuidedIntakeFacets } from './guided-intake.service';
import type { SearchService } from './search.service';

function concern(overrides: Partial<PublicConcern> & { code: string; name: string }): PublicConcern {
  return {
    id: `c-${overrides.code}`,
    specialtyId: 'sp-psychiatry',
    matchPhrases: [],
    matchWeight: 5,
    isActive: true,
    ...overrides,
  };
}

const SLEEP = concern({ code: 'sleep', name: 'Sleep problems' });
const ANXIETY = concern({ code: 'anxiety', name: 'Anxiety and stress' });
const RETIRED = concern({ code: 'retired', name: 'Retired concern', isActive: false });

function createService(resolvedConcerns: PublicConcern[] = []) {
  const search = { discover: jest.fn().mockResolvedValue({ results: [], meta: {} }) } as unknown as jest.Mocked<SearchService>;
  const catalogue = {
    getConcernsByIds: jest.fn().mockResolvedValue(resolvedConcerns),
  } as unknown as jest.Mocked<CatalogueFacade>;
  return { service: new GuidedIntakeService(search, catalogue), search, catalogue };
}

function facets(overrides: Partial<GuidedIntakeFacets> = {}): GuidedIntakeFacets {
  return { forSelf: true, ...overrides };
}

describe('buildGuidedQueryText (pure synthesis)', () => {
  it('uses the selected concerns’ curated names', () => {
    expect(buildGuidedQueryText([SLEEP, ANXIETY], facets())).toBe('Sleep problems, Anxiety and stress');
  });

  it('adds "for someone I care about" when the guide is not for the patient themselves', () => {
    expect(buildGuidedQueryText([SLEEP], facets({ forSelf: false }))).toBe('Sleep problems for someone I care about');
  });

  it.each([
    ['child', 'for a child'],
    ['teen', 'for a teenager adolescent'],
    ['senior', 'for an elderly older person'],
  ] as const)('turns the %p age band into matchable WORDS, so the ordinary matcher picks it up', (band, expected) => {
    expect(buildGuidedQueryText([], facets({ ageBand: band }))).toContain(expected);
  });

  it('contributes nothing for the neutral "adult" band', () => {
    expect(buildGuidedQueryText([SLEEP], facets({ ageBand: 'adult' }))).toBe('Sleep problems');
  });

  it.each([
    ['talking', 'counselling talking therapy'],
    ['medical', 'medical help from a doctor'],
  ] as const)('turns the %p support preference into words, never a hard clinical filter', (preference, expected) => {
    expect(buildGuidedQueryText([], facets({ supportPreference: preference }))).toContain(expected);
  });

  it('contributes nothing for "not_sure"', () => {
    expect(buildGuidedQueryText([SLEEP], facets({ supportPreference: 'not_sure' }))).toBe('Sleep problems');
  });

  it('combines every facet into one ordinary-looking query', () => {
    const text = buildGuidedQueryText([SLEEP], facets({ forSelf: false, ageBand: 'child', supportPreference: 'talking' }));
    expect(text).toBe('Sleep problems for someone I care about for a child counselling talking therapy');
  });

  it('NEVER produces an empty query, even when nothing was chosen', () => {
    expect(buildGuidedQueryText([], facets())).toBe('not sure whom to consult');
  });
});

describe('GuidedIntakeService.discover', () => {
  it('runs THE SAME pipeline — it calls SearchService.discover, not a parallel scoring path', async () => {
    const { service, search } = createService([SLEEP]);

    await service.discover('patient-1', 'app', facets({ concernIds: [SLEEP.id] }));

    expect(search.discover).toHaveBeenCalledTimes(1);
  });

  it('passes the chosen concerns as preselectedConcernIds, the matcher’s existing input', async () => {
    const { service, search } = createService([SLEEP, ANXIETY]);

    await service.discover('patient-1', 'app', facets({ concernIds: [SLEEP.id, ANXIETY.id] }));

    expect(search.discover).toHaveBeenCalledWith(
      expect.objectContaining({ preselectedConcernIds: ['c-sleep', 'c-anxiety'], queryText: 'Sleep problems, Anxiety and stress' }),
    );
  });

  it('DROPS a concern id naming a deactivated concern — a retired entry cannot be resurrected by holding its id', async () => {
    const { service, search } = createService([SLEEP, RETIRED]);

    await service.discover('patient-1', 'app', facets({ concernIds: [SLEEP.id, RETIRED.id] }));

    expect(search.discover).toHaveBeenCalledWith(expect.objectContaining({ preselectedConcernIds: ['c-sleep'] }));
  });

  it('does not call the catalogue at all when no concern was chosen', async () => {
    const { service, catalogue, search } = createService();

    await service.discover('patient-1', 'app', facets({ ageBand: 'senior' }));

    expect(catalogue.getConcernsByIds).not.toHaveBeenCalled();
    expect(search.discover).toHaveBeenCalledWith(expect.objectContaining({ preselectedConcernIds: [] }));
  });

  it('forwards the same FR-4.4 filters the free-text path takes', async () => {
    const { service, search } = createService([SLEEP]);

    await service.discover('patient-1', 'app', facets({
      concernIds: [SLEEP.id],
      languages: ['Hindi'],
      maxFeeInr: '1500',
      availableWithinDays: 7,
      limit: 5,
    }));

    expect(search.discover).toHaveBeenCalledWith(
      expect.objectContaining({ languages: ['Hindi'], maxFeeInr: '1500', availableWithinDays: 7, limit: 5 }),
    );
  });

  it('marks guided queries as non-voice and carries patient id and source through', async () => {
    const { service, search } = createService();

    await service.discover(null, 'mcp', facets());

    expect(search.discover).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: null, source: 'mcp', isVoiceInput: false }),
    );
  });

  it('returns EXACTLY what the pipeline returned — the same response shape as free text', async () => {
    const { service, search } = createService([SLEEP]);
    const pipelineResponse = { crisis: null, results: [], meta: { interpretation: 'deterministic' } };
    (search.discover as jest.Mock).mockResolvedValue(pipelineResponse);

    await expect(service.discover('patient-1', 'app', facets({ concernIds: [SLEEP.id] }))).resolves.toBe(pipelineResponse);
  });

  it('sends the SYNTHESISED text as the query, so FR-5.7’s admin log sees the guide’s real queries', async () => {
    const { service, search } = createService([SLEEP]);

    await service.discover('patient-1', 'app', facets({ concernIds: [SLEEP.id], forSelf: false, ageBand: 'child' }));

    expect((search.discover as jest.Mock).mock.calls[0][0].queryText).toBe(
      'Sleep problems for someone I care about for a child',
    );
  });
});
