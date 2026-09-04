import { SearchFacade } from './search.facade';
import type { SearchRepository } from './search.repository';
import type { SearchService } from './search.service';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';

function createFacade() {
  const search = {
    discover: jest.fn(),
    screenForCrisis: jest.fn(),
  };
  const repo = {
    countDataRightsRows: jest.fn().mockResolvedValue({ searchQueries: 0, searchRateLimits: 0 }),
    deleteAllForPatient: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
  return {
    facade: new SearchFacade(search as unknown as SearchService, repo as unknown as SearchRepository),
    search,
    repo,
  };
}

describe('SearchFacade', () => {
  /**
   * ADDITIVE (M-21/data rights execution). `countDataRightsRowsForPatient`
   * is a thin, read-only pass-through onto `SearchRepository.countData
   * RightsRows` — see that method's doc comment for why BOTH tables are
   * counted here (`search_rate_limits` for visibility only, never written).
   */
  it('countDataRightsRowsForPatient returns both counts, delegated verbatim', async () => {
    const { facade, repo } = createFacade();
    repo.countDataRightsRows.mockResolvedValue({ searchQueries: 7, searchRateLimits: 3 });

    const result = await facade.countDataRightsRowsForPatient(PATIENT_ID);

    expect(repo.countDataRightsRows).toHaveBeenCalledWith(PATIENT_ID);
    expect(result).toEqual({ searchQueries: 7, searchRateLimits: 3 });
  });

  /**
   * ADDITIVE (M-21/data rights execution). `deleteSearchQueriesForPatient`
   * is the ONLY write M-21 makes against this module — see
   * `SearchContract`'s doc comment for why `search_queries` alone is
   * hard-deleted and `search_rate_limits` is never touched by this surface.
   */
  it('deleteSearchQueriesForPatient returns the deleted count, delegated verbatim', async () => {
    const { facade, repo } = createFacade();
    repo.deleteAllForPatient.mockResolvedValue({ deletedCount: 5 });

    const result = await facade.deleteSearchQueriesForPatient(PATIENT_ID);

    expect(repo.deleteAllForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(result).toEqual({ deletedCount: 5 });
  });

  /** Idempotent per the contract doc comment: an already-empty set is a no-op, never a throw. */
  it('deleteSearchQueriesForPatient is a no-op when there is nothing to delete', async () => {
    const { facade, repo } = createFacade();
    repo.deleteAllForPatient.mockResolvedValue({ deletedCount: 0 });

    const result = await facade.deleteSearchQueriesForPatient(PATIENT_ID);

    expect(result).toEqual({ deletedCount: 0 });
  });
});
