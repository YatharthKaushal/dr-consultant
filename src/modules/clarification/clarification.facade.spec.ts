import { ClarificationFacade } from './clarification.facade';
import type { ClarificationService } from './clarification.service';

const CASE_ID = '11111111-1111-4111-8111-111111111111';

function createFacade() {
  const clarification = { getCaseSummary: jest.fn().mockResolvedValue(null) };
  return { facade: new ClarificationFacade(clarification as unknown as ClarificationService), clarification };
}

describe('ClarificationFacade', () => {
  it('delegates the governance summary read', async () => {
    const { facade, clarification } = createFacade();

    await facade.getCaseSummary(CASE_ID);

    expect(clarification.getCaseSummary).toHaveBeenCalledWith(CASE_ID);
  });

  /**
   * *** THE ABSENCE IS THE CONTRACT. *** Posting a case, assigning an
   * expert and every message exchange are this module's own acts, reached
   * through its own controllers with the caller's own credentials. A write
   * appearing here would let another module post or respond on a doctor's
   * behalf, which is exactly what FR-12.7's "the treating doctor decides all
   * patient communication" forbids one hop removed.
   */
  it('exposes exactly one method — the narrowest possible cross-module surface', () => {
    const { facade } = createFacade();

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(facade)).filter((name) => name !== 'constructor');

    expect(surface.sort()).toEqual(['getCaseSummary']);
  });
});
