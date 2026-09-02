import { DiscoverCareTool } from './discover-care.tool';
import type { CrisisGuidance, DiscoveryPort } from './search-tool.contract';
import { concern, doctor, mockCataloguePort, mockDoctorPort, specialty } from './search-tool.test-fixtures';

const SPECIALTY_A = '11111111-1111-4111-8111-111111111111';
const SPECIALTY_B = '44444444-4444-4444-8444-444444444444';

const CRISIS_GUIDANCE: CrisisGuidance = {
  message: 'If you are thinking about harming yourself, please contact emergency services now.',
  helplines: [{ name: 'Tele-MANAS', phone: '14416', availability: '24x7' }],
};

function mockDiscovery(): jest.Mocked<DiscoveryPort> {
  return { discover: jest.fn() };
}

describe('DiscoverCareTool', () => {
  /* ---------------------------------------------------------------------- */
  /* THE CRISIS RULE — SRS FR-5.6 / §6.3                                     */
  /* ---------------------------------------------------------------------- */

  describe('crisis result', () => {
    function crisisSetup() {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      const doctors = mockDoctorPort();
      discovery.discover.mockResolvedValue({ outcome: 'crisis', guidance: CRISIS_GUIDANCE });
      // Deliberately stocked: if any of these were consulted, the assertions
      // below would see real data rather than an empty result.
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A })]);
      catalogue.getConcernsByIds.mockResolvedValue([concern()]);
      doctors.listListedDoctors.mockResolvedValue([doctor(), doctor({ id: 'd-2' })]);
      return { tool: new DiscoverCareTool(discovery, catalogue, doctors), catalogue, doctors };
    }

    it('returns ZERO doctor results', async () => {
      const { tool } = crisisSetup();

      const result = await tool.execute({ text: 'I want to end it all' });

      expect(result.outcome).toBe('crisis');
      expect(result.doctors).toHaveLength(0);
    });

    it('never queries the doctor directory at all on a crisis path', async () => {
      const { tool, doctors } = crisisSetup();

      await tool.execute({ text: 'I want to end it all' });

      expect(doctors.listListedDoctors).not.toHaveBeenCalled();
    });

    it('never queries the catalogue either — there is nothing to route', async () => {
      const { tool, catalogue } = crisisSetup();

      await tool.execute({ text: 'I want to end it all' });

      expect(catalogue.getConcernsByIds).not.toHaveBeenCalled();
      expect(catalogue.listActiveSpecialties).not.toHaveBeenCalled();
    });

    it('carries the emergency guidance through verbatim', async () => {
      const { tool } = crisisSetup();

      const result = await tool.execute({ text: 'I want to end it all' });

      expect(result).toMatchObject({ outcome: 'crisis', guidance: CRISIS_GUIDANCE });
    });

    it('carries no concerns or recommended specialties — structurally nothing else to render', async () => {
      const { tool } = crisisSetup();

      const result = await tool.execute({ text: 'I want to end it all' });

      expect(result).not.toHaveProperty('concerns');
      expect(result).not.toHaveProperty('recommendedSpecialties');
      expect(Object.keys(result).sort()).toEqual(['doctors', 'guidance', 'outcome']);
    });

    it('mentions no doctor anywhere in the serialized response', async () => {
      const { tool } = crisisSetup();

      const serialized = JSON.stringify(await tool.execute({ text: 'I want to end it all' }));

      expect(serialized).not.toContain('Dr Asha Rao');
      expect(serialized).toContain('Tele-MANAS');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Routed result                                                           */
  /* ---------------------------------------------------------------------- */

  describe('routed result', () => {
    it('returns interpreted concerns, recommended specialties and a doctor list', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      const doctors = mockDoctorPort();
      discovery.discover.mockResolvedValue({
        outcome: 'routed',
        interpretedConcernIds: ['c-1'],
        recommendedSpecialtyIds: [SPECIALTY_A],
        matchReason: 'matched to: sleep',
      });
      catalogue.getConcernsByIds.mockResolvedValue([concern({ id: 'c-1', code: 'sleep', name: 'Sleep' })]);
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A })]);
      doctors.listListedDoctors.mockResolvedValue([doctor({ id: 'd-1' })]);

      const result = await new DiscoverCareTool(discovery, catalogue, doctors).execute({ text: 'I cannot sleep' });

      expect(result).toMatchObject({
        outcome: 'routed',
        concerns: [{ id: 'c-1', code: 'sleep', name: 'Sleep' }],
        recommendedSpecialties: [{ id: SPECIALTY_A, code: 'psychiatry', name: 'Psychiatry', canPrescribe: true }],
        matchReason: 'matched to: sleep',
      });
      expect(result.outcome === 'routed' && result.doctors.map((entry) => entry.id)).toEqual(['d-1']);
    });

    it('passes the patient text through unchanged, tagged source "mcp"', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([]);

      await new DiscoverCareTool(discovery, catalogue, mockDoctorPort()).execute({ text: '  neend nahi aati  ', locale: 'hi-IN' });

      expect(discovery.discover).toHaveBeenCalledWith({ text: '  neend nahi aati  ', source: 'mcp', locale: 'hi-IN' });
    });

    it('omits locale entirely when not supplied', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([]);

      await new DiscoverCareTool(discovery, catalogue, mockDoctorPort()).execute({ text: 'hello' });

      expect(discovery.discover).toHaveBeenCalledWith({ text: 'hello', source: 'mcp' });
    });

    it("preserves the pipeline's concern order regardless of the lookup's order", async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: ['c-2', 'c-1'], recommendedSpecialtyIds: [] });
      // Returned in the opposite order, as a set lookup is entitled to.
      catalogue.getConcernsByIds.mockResolvedValue([concern({ id: 'c-1' }), concern({ id: 'c-2' })]);
      catalogue.listActiveSpecialties.mockResolvedValue([]);

      const result = await new DiscoverCareTool(discovery, catalogue, mockDoctorPort()).execute({ text: 'x' });

      expect(result.outcome === 'routed' && result.concerns.map((entry) => entry.id)).toEqual(['c-2', 'c-1']);
    });

    it('drops a recommended specialty that is no longer active', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [SPECIALTY_A, SPECIALTY_B] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A })]);
      const doctors = mockDoctorPort();
      doctors.listListedDoctors.mockResolvedValue([]);

      const result = await new DiscoverCareTool(discovery, catalogue, doctors).execute({ text: 'x' });

      expect(result.outcome === 'routed' && result.recommendedSpecialties.map((entry) => entry.id)).toEqual([SPECIALTY_A]);
    });

    it('deduplicates a doctor who holds two recommended specialties, keeping the higher-recommended position', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [SPECIALTY_A, SPECIALTY_B] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A }), specialty({ id: SPECIALTY_B, code: 'counselling' })]);
      const doctors = mockDoctorPort();
      doctors.listListedDoctors
        .mockResolvedValueOnce([doctor({ id: 'shared' })])
        .mockResolvedValueOnce([doctor({ id: 'shared' }), doctor({ id: 'only-b' })]);

      const result = await new DiscoverCareTool(discovery, catalogue, doctors).execute({ text: 'x' });

      expect(result.outcome === 'routed' && result.doctors.map((entry) => entry.id)).toEqual(['shared', 'only-b']);
    });

    it('caps the doctor list at the requested limit', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [SPECIALTY_A] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A })]);
      const doctors = mockDoctorPort();
      doctors.listListedDoctors.mockResolvedValue([doctor({ id: 'a' }), doctor({ id: 'b' }), doctor({ id: 'c' })]);

      const result = await new DiscoverCareTool(discovery, catalogue, doctors).execute({ text: 'x', limit: 2 });

      expect(result.outcome === 'routed' && result.doctors).toHaveLength(2);
    });

    it('returns an empty doctor list, not an error, when nothing matches', async () => {
      const discovery = mockDiscovery();
      const catalogue = mockCataloguePort();
      discovery.discover.mockResolvedValue({ outcome: 'routed', interpretedConcernIds: [], recommendedSpecialtyIds: [SPECIALTY_A] });
      catalogue.getConcernsByIds.mockResolvedValue([]);
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_A })]);
      const doctors = mockDoctorPort();
      doctors.listListedDoctors.mockResolvedValue([]);

      const result = await new DiscoverCareTool(discovery, catalogue, doctors).execute({ text: 'x' });

      expect(result.outcome === 'routed' && result.doctors).toEqual([]);
    });
  });

  describe('input schema', () => {
    const tool = new DiscoverCareTool(mockDiscovery(), mockCataloguePort(), mockDoctorPort());

    it('requires text', () => {
      expect(tool.inputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects empty text', () => {
      expect(tool.inputSchema.safeParse({ text: '' }).success).toBe(false);
    });

    it('rejects text beyond the length cap', () => {
      expect(tool.inputSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
    });

    it('accepts text with an optional locale and limit', () => {
      expect(tool.inputSchema.safeParse({ text: 'I feel low', locale: 'hi-IN', limit: 3 }).success).toBe(true);
    });
  });
});
