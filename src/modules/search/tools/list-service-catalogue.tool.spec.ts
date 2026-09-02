import { ListServiceCatalogueTool } from './list-service-catalogue.tool';
import { mockCataloguePort, specialty } from './search-tool.test-fixtures';

describe('ListServiceCatalogueTool', () => {
  it('returns id, code, name, description and canPrescribe for each active specialty', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([
      specialty({ id: 'spec-1', code: 'psychiatry', name: 'Psychiatry', canPrescribe: true }),
      specialty({ id: 'spec-2', code: 'counselling', name: 'Counselling', canPrescribe: false, description: null }),
    ]);

    const result = await new ListServiceCatalogueTool(catalogue).execute({});

    expect(result.specialties).toEqual([
      { id: 'spec-1', code: 'psychiatry', name: 'Psychiatry', description: 'Medical treatment of mental health conditions.', canPrescribe: true },
      { id: 'spec-2', code: 'counselling', name: 'Counselling', description: null, canPrescribe: false },
    ]);
  });

  it('returns an empty list (not an error) when no specialties are active', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([]);

    await expect(new ListServiceCatalogueTool(catalogue).execute({})).resolves.toEqual({ specialties: [] });
  });

  it('does not expose booking-flow internals (intakeForm, requiredDocuments) to an agent', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ intakeForm: [{ field: 'secret' }], requiredDocuments: ['degree'] })]);

    const result = await new ListServiceCatalogueTool(catalogue).execute({});

    expect(Object.keys(result.specialties[0]!).sort()).toEqual(['canPrescribe', 'code', 'description', 'id', 'name']);
  });

  it('accepts an empty object as input', () => {
    const tool = new ListServiceCatalogueTool(mockCataloguePort());
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });
});
