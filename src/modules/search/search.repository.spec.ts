import type { Database } from '../../config/db/database.config';
import { searchQueriesTable } from '../../schema/search-queries.schema';
import { SearchRepository } from './search.repository';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * ADDITIVE (M-21/data rights execution). Covers `countDataRightsRows` and
 * `deleteAllForPatient` — the two methods this track adds to
 * `search.repository.ts`. Every other method on this repository is
 * untouched (see `search.contract.ts` / `search.facade.ts` diffs), so no
 * existing test here needs to change.
 */
describe('SearchRepository (M-21 data rights)', () => {
  describe('countDataRightsRows', () => {
    function stubDb(counts: { searchQueries: string; searchRateLimits: string }) {
      const from = jest.fn((table: unknown) => ({
        where: jest.fn().mockResolvedValue([{ total: table === searchQueriesTable ? counts.searchQueries : counts.searchRateLimits }]),
      }));
      const select = jest.fn(() => ({ from }));
      const db = { select } as unknown as Database;
      return { db, select, from };
    }

    it('returns both counts correctly, one per table', async () => {
      const { db } = stubDb({ searchQueries: '4', searchRateLimits: '9' });
      const repo = new SearchRepository(db);

      const result = await repo.countDataRightsRows(PATIENT_ID);

      expect(result).toEqual({ searchQueries: 4, searchRateLimits: 9 });
    });

    it('returns zero for both when neither table has a matching row', async () => {
      const { db } = stubDb({ searchQueries: '0', searchRateLimits: '0' });
      const repo = new SearchRepository(db);

      const result = await repo.countDataRightsRows(PATIENT_ID);

      expect(result).toEqual({ searchQueries: 0, searchRateLimits: 0 });
    });
  });

  describe('deleteAllForPatient', () => {
    function stubDb(deletedIds: number[]) {
      const returning = jest.fn().mockResolvedValue(deletedIds.map((id) => ({ id })));
      const where = jest.fn(() => ({ returning }));
      const del = jest.fn(() => ({ where }));
      const db = { delete: del } as unknown as Database;
      return { db, delete: del, where, returning };
    }

    it('returns the exact deleted count, taken from .returning() rather than a separate count', async () => {
      const { db, delete: del } = stubDb([1, 2, 3]);
      const repo = new SearchRepository(db);

      const result = await repo.deleteAllForPatient(PATIENT_ID);

      expect(del).toHaveBeenCalledWith(searchQueriesTable);
      expect(result).toEqual({ deletedCount: 3 });
    });

    /** Idempotent per the contract doc comment: an already-empty set is a no-op, never a throw. */
    it('is a no-op — { deletedCount: 0 } — when there are no matching rows', async () => {
      const { db } = stubDb([]);
      const repo = new SearchRepository(db);

      const result = await repo.deleteAllForPatient(PATIENT_ID);

      expect(result).toEqual({ deletedCount: 0 });
    });
  });
});
