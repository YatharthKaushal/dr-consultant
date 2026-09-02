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

describe('DoctorToolAdapter', () => {
  it('reports the directory unavailable while DoctorFacade has no listListedDoctors', () => {
    const facade = { getPublicProfile: jest.fn() } as unknown as DoctorFacade;
    expect(new DoctorToolAdapter(facade).isAvailable()).toBe(false);
  });

  it('refuses listListedDoctors with DOCTOR_DIRECTORY_UNAVAILABLE', async () => {
    const facade = { getPublicProfile: jest.fn() } as unknown as DoctorFacade;

    try {
      await new DoctorToolAdapter(facade).listListedDoctors({});
      fail('expected a refusal');
    } catch (error) {
      expect(bodyOf(error).code).toBe(TOOL_ERROR_CODES.DOCTOR_DIRECTORY_UNAVAILABLE);
    }
  });

  it('reports available, and delegates, once the method lands', async () => {
    const listListedDoctors = jest.fn().mockResolvedValue([doctor()]);
    const facade = { getPublicProfile: jest.fn(), listListedDoctors } as unknown as DoctorFacade;
    const adapter = new DoctorToolAdapter(facade);

    expect(adapter.isAvailable()).toBe(true);
    await adapter.listListedDoctors({ specialtyId: 'spec-1', limit: 5 });
    expect(listListedDoctors).toHaveBeenCalledWith({ specialtyId: 'spec-1', limit: 5 });
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
