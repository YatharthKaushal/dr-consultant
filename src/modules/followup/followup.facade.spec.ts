import { FollowupFacade } from './followup.facade';
import type { FollowupAlertService } from './followup-alert.service';
import type { FollowupService } from './followup.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';

function createFacade() {
  const followup = {
    countDataRightsRowsForConsultations: jest
      .fn()
      .mockResolvedValue({ checkinResponses: 0, safetyAlerts: 0, followupAssignments: 0 }),
  };
  const alerts = {};
  return {
    facade: new FollowupFacade(followup as unknown as FollowupService, alerts as unknown as FollowupAlertService),
    followup,
  };
}

describe('FollowupFacade — M-21 data rights addition', () => {
  it('delegates the data-rights row count to the service, unchanged', async () => {
    const { facade, followup } = createFacade();

    await facade.countDataRightsRowsForConsultations([CONSULTATION_ID]);

    expect(followup.countDataRightsRowsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
  });

  it('passes an empty array straight through — the empty-array guard lives in the service, not here', async () => {
    const { facade, followup } = createFacade();

    await facade.countDataRightsRowsForConsultations([]);

    expect(followup.countDataRightsRowsForConsultations).toHaveBeenCalledWith([]);
  });
});
