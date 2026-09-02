import type { DiscoveryResponse } from '../search.contract';
import type { SearchFacade } from '../search.facade';
import { SearchDiscoveryProvider } from './search-discovery.provider';

function baseResponse(overrides: Partial<DiscoveryResponse> = {}): DiscoveryResponse {
  return {
    crisis: null,
    guidance: { text: 'Try {{specialty:psychiatry}}.', references: [], source: 'template' },
    matchedConcerns: [],
    matchedSpecialties: [],
    results: [],
    suggestions: { concerns: [], specialties: [], popular: [] },
    meta: { interpretation: 'deterministic', aiEnabled: false, crisisGuardrailFired: false, resultCount: 0 },
    disclaimer: 'This helps you choose whom to consult. It is not a diagnosis.',
    ...overrides,
  } as DiscoveryResponse;
}

function facadeReturning(response: DiscoveryResponse) {
  const discover = jest.fn().mockResolvedValue(response);
  return { facade: { discover } as unknown as SearchFacade, discover };
}

describe('SearchDiscoveryProvider', () => {
  describe('the call into the pipeline', () => {
    it('passes patientId null — an MCP caller is a machine, so the query is logged unattributed', async () => {
      const { facade, discover } = facadeReturning(baseResponse());

      await new SearchDiscoveryProvider(facade).discover({ text: 'cannot sleep', source: 'mcp' });

      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: null, source: 'mcp', queryText: 'cannot sleep' }),
      );
    });
  });

  describe('crisis narrowing (SRS FR-5.6 / §6.3)', () => {
    const crisisResponse = baseResponse({
      crisis: { message: 'We are here for you.', helplines: [{ name: 'Tele-MANAS', phone: '14416' }] },
      // Even if the pipeline were ever to populate routing data alongside a
      // crisis, the agent-facing union has nowhere to put it.
      matchedConcerns: [{ id: 'c-1', code: 'depression', name: 'Depression', specialtyId: 's-1' }],
      matchedSpecialties: [{ id: 's-1', code: 'psychiatry', name: 'Psychiatry', concernNames: ['Depression'] }],
    });

    it('returns the crisis outcome with the guidance verbatim', async () => {
      const { facade } = facadeReturning(crisisResponse);

      const result = await new SearchDiscoveryProvider(facade).discover({ text: 'i want to die', source: 'mcp' });

      expect(result).toEqual({
        outcome: 'crisis',
        guidance: { message: 'We are here for you.', helplines: [{ name: 'Tele-MANAS', phone: '14416' }] },
      });
    });

    it('carries NO concern or specialty ids out of a crisis, even when the pipeline had them', async () => {
      const { facade } = facadeReturning(crisisResponse);

      const result = await new SearchDiscoveryProvider(facade).discover({ text: 'i want to die', source: 'mcp' });

      expect(result).not.toHaveProperty('interpretedConcernIds');
      expect(result).not.toHaveProperty('recommendedSpecialtyIds');
      expect(JSON.stringify(result)).not.toContain('psychiatry');
    });
  });

  describe('routed narrowing', () => {
    it('forwards ids only, and builds the FR-5.4 reason from curated concern names', async () => {
      const { facade } = facadeReturning(
        baseResponse({
          matchedConcerns: [
            { id: 'c-1', code: 'sleep', name: 'Sleep problems', specialtyId: 's-1' },
            { id: 'c-2', code: 'anxiety', name: 'Anxiety and stress', specialtyId: 's-1' },
          ],
          matchedSpecialties: [{ id: 's-1', code: 'psychiatry', name: 'Psychiatry', concernNames: ['Sleep problems'] }],
        }),
      );

      const result = await new SearchDiscoveryProvider(facade).discover({ text: 'cannot sleep', source: 'mcp' });

      expect(result).toEqual({
        outcome: 'routed',
        interpretedConcernIds: ['c-1', 'c-2'],
        recommendedSpecialtyIds: ['s-1'],
        matchReason: 'Matched to: Sleep problems, Anxiety and stress',
      });
    });

    it('omits matchReason entirely when nothing matched, rather than asserting an empty match', async () => {
      const { facade } = facadeReturning(baseResponse());

      const result = await new SearchDiscoveryProvider(facade).discover({ text: 'asdfgh', source: 'mcp' });

      expect(result).toMatchObject({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [] });
      expect((result as { matchReason?: string }).matchReason).toBeUndefined();
    });

    it('never forwards guidance prose — its {{...}} tokens mean nothing outside our own frontend', async () => {
      const { facade } = facadeReturning(baseResponse());

      const result = await new SearchDiscoveryProvider(facade).discover({ text: 'hello', source: 'mcp' });

      expect(JSON.stringify(result)).not.toContain('{{');
    });
  });
});
