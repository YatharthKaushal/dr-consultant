import { CareHubFacade } from './carehub.facade';
import type { CarehubService } from './carehub.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';

function createFacade() {
  const carehub = {
    getRecommendedForConsultation: jest.fn().mockResolvedValue([]),
    countRecommendationsForConsultations: jest.fn().mockResolvedValue(0),
  };
  return { facade: new CareHubFacade(carehub as unknown as CarehubService), carehub };
}

describe('CareHubFacade', () => {
  it('delegates the CareHubPort read', async () => {
    const { facade, carehub } = createFacade();

    await facade.getRecommendedForConsultation(CONSULTATION_ID);

    expect(carehub.getRecommendedForConsultation).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  /** *** M-21 CALLS THIS. *** A pure row count for a patient data-deletion preview — see `carehub.contract.ts#CareHubContract.countRecommendationsForConsultations`. Nothing here writes. */
  it('delegates the M-21 data-rights recommendation count', async () => {
    const { facade, carehub } = createFacade();
    carehub.countRecommendationsForConsultations.mockResolvedValue(4);

    await expect(facade.countRecommendationsForConsultations([CONSULTATION_ID])).resolves.toBe(4);
    expect(carehub.countRecommendationsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
  });

  /**
   * *** THE ABSENCE IS THE CONTRACT. *** Recording a recommendation is the
   * treating doctor's act through this module's own controller — a write
   * here would let another module recommend on a doctor's behalf. See
   * `carehub.contract.ts#CareHubContract`'s class doc comment.
   */
  it('exposes NO write — the public surface is read-only', () => {
    const { facade } = createFacade();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(facade)).filter((name) => name !== 'constructor');
    expect(surface.sort()).toEqual(['countRecommendationsForConsultations', 'getRecommendedForConsultation']);
  });

  /**
   * *** STRUCTURAL PORT SATISFACTION. *** `followup-care-hub.contract.ts`'s
   * `CareHubPort` is not imported here (this module never imports
   * `modules/followup`), but this compiles ONLY if `CareHubFacade`'s method
   * shape is assignable to it — the same guarantee the coordinator's
   * one-line rebind relies on.
   */
  it('is structurally assignable to the followup module’s CareHubPort shape', async () => {
    const { facade } = createFacade();

    interface LocalCareHubPortMirror {
      getRecommendedForConsultation(consultationId: string): Promise<{ contentId: string; title: string; kind: string }[]>;
    }
    const asPort: LocalCareHubPortMirror = facade;

    expect(typeof asPort.getRecommendedForConsultation).toBe('function');
  });
});
