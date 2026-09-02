import { ListConcernTaxonomyTool } from './list-concern-taxonomy.tool';
import { concern, mockCataloguePort } from './search-tool.test-fixtures';

const SPECIALTY_A = '11111111-1111-4111-8111-111111111111';
const SPECIALTY_B = '44444444-4444-4444-8444-444444444444';

describe('ListConcernTaxonomyTool', () => {
  it('returns id, specialtyId, code and name for every active concern', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveConcerns.mockResolvedValue([
      concern({ id: 'c-1', code: 'sleep', name: 'Sleep' }),
      concern({ id: 'c-2', code: 'anxiety', name: 'Anxiety' }),
    ]);

    const result = await new ListConcernTaxonomyTool(catalogue).execute({});

    expect(result.concerns).toEqual([
      { id: 'c-1', specialtyId: SPECIALTY_A, code: 'sleep', name: 'Sleep' },
      { id: 'c-2', specialtyId: SPECIALTY_A, code: 'anxiety', name: 'Anxiety' },
    ]);
  });

  it('returns an empty list when the taxonomy has no active concerns', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveConcerns.mockResolvedValue([]);

    await expect(new ListConcernTaxonomyTool(catalogue).execute({})).resolves.toEqual({ concerns: [] });
  });

  it('filters to one specialty when specialtyId is given', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveConcerns.mockResolvedValue([
      concern({ id: 'c-1', specialtyId: SPECIALTY_A }),
      concern({ id: 'c-2', specialtyId: SPECIALTY_B }),
    ]);

    const result = await new ListConcernTaxonomyTool(catalogue).execute({ specialtyId: SPECIALTY_B });

    expect(result.concerns.map((entry) => entry.id)).toEqual(['c-2']);
  });

  it('returns an empty list when the specialty filter matches nothing', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveConcerns.mockResolvedValue([concern({ specialtyId: SPECIALTY_A })]);

    const result = await new ListConcernTaxonomyTool(catalogue).execute({ specialtyId: SPECIALTY_B });

    expect(result.concerns).toEqual([]);
  });

  it('calls listActiveConcerns with NO arguments — the signature the parallel worktree named', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveConcerns.mockResolvedValue([]);

    await new ListConcernTaxonomyTool(catalogue).execute({ specialtyId: SPECIALTY_A });

    expect(catalogue.listActiveConcerns).toHaveBeenCalledWith();
  });

  /* ---------------------------------------------------------------------- */
  /* The reason this tool exists in this shape                               */
  /* ---------------------------------------------------------------------- */

  describe('never leaks the internal routing corpus', () => {
    it('omits matchPhrases from every returned concern', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveConcerns.mockResolvedValue([
        concern({ id: 'c-1', matchPhrases: ['cannot sleep', 'neend nahi aati'] }),
        concern({ id: 'c-2', matchPhrases: ['panic', 'ghabrahat'] }),
      ]);

      const result = await new ListConcernTaxonomyTool(catalogue).execute({});

      for (const entry of result.concerns) {
        expect(entry).not.toHaveProperty('matchPhrases');
      }
    });

    it('omits matchWeight — the ranking tie-breaker — as well', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveConcerns.mockResolvedValue([concern({ matchWeight: 9 })]);

      const result = await new ListConcernTaxonomyTool(catalogue).execute({});

      expect(result.concerns[0]).not.toHaveProperty('matchWeight');
    });

    it('returns exactly four fields per concern and nothing else, however the source row grows', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveConcerns.mockResolvedValue([
        // A row carrying a field that does not exist on `PublicConcern` today
        // — a spread-based mapper would pass it straight through.
        { ...concern(), futureInternalField: 'must not escape' } as never,
      ]);

      const result = await new ListConcernTaxonomyTool(catalogue).execute({});

      expect(Object.keys(result.concerns[0]!).sort()).toEqual(['code', 'id', 'name', 'specialtyId']);
    });

    it('leaves no trigger phrase anywhere in the serialized response', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveConcerns.mockResolvedValue([concern({ matchPhrases: ['neend nahi aati', 'insomnia'] })]);

      const serialized = JSON.stringify(await new ListConcernTaxonomyTool(catalogue).execute({}));

      expect(serialized).not.toContain('neend nahi aati');
      expect(serialized).not.toContain('insomnia');
    });
  });

  it('rejects a non-UUID specialtyId at the schema', () => {
    const tool = new ListConcernTaxonomyTool(mockCataloguePort());
    expect(tool.inputSchema.safeParse({ specialtyId: 'not-a-uuid' }).success).toBe(false);
  });
});
