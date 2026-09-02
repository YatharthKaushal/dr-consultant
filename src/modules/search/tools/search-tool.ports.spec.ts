import { ServiceUnavailableException } from '@nestjs/common';
import type { CatalogueFacade } from '../../catalogue/catalogue.facade';
import type { DoctorFacade } from '../../doctor/doctor.facade';
import { CatalogueToolAdapter } from './catalogue-tool.adapter';
import { DoctorToolAdapter } from './doctor-tool.adapter';
import { TOOL_ERROR_CODES } from './search-tool.constants';
import { concern, doctor, specialty } from './search-tool.test-fixtures';
import { UnavailableDiscoveryProvider } from './unavailable-discovery.provider';

/**
 * The three placeholder/port bindings that stand in for work owned by the
 * parallel M-09 search worktree. These tests pin down BOTH sides of each:
 * what happens today (a clean, documented refusal) and what happens the
 * moment the real method appears (straight delegation, no code change).
 */

function bodyOf(error: unknown): { code: string; message: string } {
  return (error as ServiceUnavailableException).getResponse() as { code: string; message: string };
}

describe('CatalogueToolAdapter', () => {
  it('delegates listActiveSpecialties, which exists on CatalogueFacade today', async () => {
    const facade = { listActiveSpecialties: jest.fn().mockResolvedValue([specialty()]) } as unknown as CatalogueFacade;

    await expect(new CatalogueToolAdapter(facade).listActiveSpecialties()).resolves.toHaveLength(1);
  });

  describe('while the search worktree has not landed its methods', () => {
    const bare = { listActiveSpecialties: jest.fn() } as unknown as CatalogueFacade;

    it('refuses listActiveConcerns with CATALOGUE_CAPABILITY_UNAVAILABLE', async () => {
      await expect(new CatalogueToolAdapter(bare).listActiveConcerns()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('names the missing method in the message so the cause is obvious', async () => {
      try {
        await new CatalogueToolAdapter(bare).listActiveConcerns();
        fail('expected a refusal');
      } catch (error) {
        expect(bodyOf(error).code).toBe(TOOL_ERROR_CODES.CATALOGUE_CAPABILITY_UNAVAILABLE);
        expect(bodyOf(error).message).toContain('listActiveConcerns');
      }
    });

    it('refuses getConcernsByIds too', async () => {
      await expect(new CatalogueToolAdapter(bare).getConcernsByIds(['c-1'])).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('short-circuits an empty id list without needing the method at all', async () => {
      await expect(new CatalogueToolAdapter(bare).getConcernsByIds([])).resolves.toEqual([]);
    });
  });

  describe('once the search worktree has landed its methods', () => {
    it('delegates listActiveConcerns with no arguments', async () => {
      const listActiveConcerns = jest.fn().mockResolvedValue([concern()]);
      const facade = { listActiveSpecialties: jest.fn(), listActiveConcerns } as unknown as CatalogueFacade;

      await expect(new CatalogueToolAdapter(facade).listActiveConcerns()).resolves.toHaveLength(1);
      expect(listActiveConcerns).toHaveBeenCalledWith();
    });

    it('delegates getConcernsByIds with the id list', async () => {
      const getConcernsByIds = jest.fn().mockResolvedValue([concern()]);
      const facade = { listActiveSpecialties: jest.fn(), getConcernsByIds } as unknown as CatalogueFacade;

      await new CatalogueToolAdapter(facade).getConcernsByIds(['c-1', 'c-2']);

      expect(getConcernsByIds).toHaveBeenCalledWith(['c-1', 'c-2']);
    });
  });
});

/**
 * `DoctorFacade.listListedDoctors` landed with the M-09 merge, so this
 * adapter no longer guards against a missing method — it TRANSLATES. The
 * agent-facing filter is singular (`specialtyId`/`language`), because a model
 * filling a tool call reasons about "a psychiatrist who speaks Hindi", while
 * the facade takes arrays plus an explicit page window. These tests pin that
 * translation, which is the only place the two shapes meet.
 */
describe('DoctorToolAdapter', () => {
  function facadeWith(listListedDoctors: jest.Mock): DoctorFacade {
    return { getPublicProfile: jest.fn(), listListedDoctors } as unknown as DoctorFacade;
  }

  it('reports the directory available — the facade read is now statically guaranteed', () => {
    expect(new DoctorToolAdapter(facadeWith(jest.fn())).isAvailable()).toBe(true);
  });

  it('lifts a singular specialtyId/language into the arrays the facade expects', async () => {
    const listListedDoctors = jest.fn().mockResolvedValue([doctor()]);

    await new DoctorToolAdapter(facadeWith(listListedDoctors)).listListedDoctors({
      specialtyId: 'spec-1',
      language: 'Hindi',
      limit: 5,
    });

    expect(listListedDoctors).toHaveBeenCalledWith(
      expect.objectContaining({ specialtyIds: ['spec-1'], languages: ['Hindi'], limit: 5, offset: 0 }),
    );
  });

  it('leaves absent filters undefined rather than sending empty arrays, which would filter everything out', async () => {
    const listListedDoctors = jest.fn().mockResolvedValue([]);

    await new DoctorToolAdapter(facadeWith(listListedDoctors)).listListedDoctors({});

    expect(listListedDoctors).toHaveBeenCalledWith(
      expect.objectContaining({ specialtyIds: undefined, languages: undefined, maxFeeInr: undefined }),
    );
  });

  it('sends maxFeeInr as a 2dp decimal string — the column is numeric, and a float would round a fee', async () => {
    const listListedDoctors = jest.fn().mockResolvedValue([]);

    await new DoctorToolAdapter(facadeWith(listListedDoctors)).listListedDoctors({ maxFeeInr: 1500 });

    expect(listListedDoctors).toHaveBeenCalledWith(expect.objectContaining({ maxFeeInr: '1500.00' }));
  });

  it('always requests the first page — this surface pages by narrowing filters, not by offset', async () => {
    const listListedDoctors = jest.fn().mockResolvedValue([]);

    await new DoctorToolAdapter(facadeWith(listListedDoctors)).listListedDoctors({ limit: 3 });

    expect(listListedDoctors).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });
});

describe('UnavailableDiscoveryProvider', () => {
  it('refuses every call with DISCOVERY_UNAVAILABLE rather than returning an empty result', async () => {
    try {
      await new UnavailableDiscoveryProvider().discover({ text: 'I feel low', source: 'mcp' });
      fail('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(bodyOf(error).code).toBe(TOOL_ERROR_CODES.DISCOVERY_UNAVAILABLE);
    }
  });

  it('never resolves — a silent empty result would read as "nothing fits your symptoms"', async () => {
    await expect(new UnavailableDiscoveryProvider().discover({ text: 'anything', source: 'mcp' })).rejects.toBeDefined();
  });
});
