import { ClinicalFacade } from './clinical.facade';
import type { ClinicalService } from './clinical.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';

function createFacade() {
  const clinical = {
    getRecordByConsultationId: jest.fn().mockResolvedValue(null),
    getCarePlanInputs: jest.fn().mockResolvedValue(null),
    listPendingCaseSummaries: jest.fn().mockResolvedValue([]),
    countPendingCaseSummaries: jest.fn().mockResolvedValue(0),
  };
  return { facade: new ClinicalFacade(clinical as unknown as ClinicalService), clinical };
}

describe('ClinicalFacade', () => {
  it('delegates the M-17 record read', async () => {
    const { facade, clinical } = createFacade();

    await facade.getRecordByConsultationId(CONSULTATION_ID);

    expect(clinical.getRecordByConsultationId).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('delegates the M-16 Care Plan read', async () => {
    const { facade, clinical } = createFacade();

    await facade.getCarePlanInputs(CONSULTATION_ID);

    expect(clinical.getCarePlanInputs).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('delegates the M-20/governance pending-case-summaries queue read', async () => {
    const { facade, clinical } = createFacade();

    await facade.listPendingCaseSummaries(20, 0);

    expect(clinical.listPendingCaseSummaries).toHaveBeenCalledWith(20, 0);
  });

  it('delegates the M-20/governance pending-case-summaries dashboard count', async () => {
    const { facade, clinical } = createFacade();

    await facade.countPendingCaseSummaries();

    expect(clinical.countPendingCaseSummaries).toHaveBeenCalled();
  });

  /**
   * *** THE ABSENCE IS THE CONTRACT. *** Finalising asserts that a clinician
   * did the clinical work, so it is the treating doctor's act through this
   * module's own controller — never something another module can do on their
   * behalf. A write appearing here would make FR-11.5's "enforced by the
   * system, not by convention" mean nothing, because the convention would just
   * move one module along.
   */
  it('exposes NO write — the public surface is read-only', () => {
    const { facade } = createFacade();

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(facade)).filter((name) => name !== 'constructor');

    expect(surface.sort()).toEqual([
      'countPendingCaseSummaries',
      'getCarePlanInputs',
      'getRecordByConsultationId',
      'listPendingCaseSummaries',
    ]);
  });
});
