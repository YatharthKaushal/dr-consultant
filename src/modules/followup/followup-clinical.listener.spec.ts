import type { BookingFacade } from '../booking/booking.facade';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import { FollowupClinicalListener } from './followup-clinical.listener';
import type { FollowupService } from './followup.service';

/**
 * Hand-rolled deps, `new FollowupClinicalListener(...)` — this codebase's
 * convention (`booking.service.spec.ts` etc.), never `Test.createTestingModule`.
 *
 * Proves the seam `followup.service.ts#assignPathway` had no caller for
 * (`FollowupModule`'s own header, before this listener existed) is now
 * genuinely reachable, and proves the concern -> pathway mapping this
 * listener owns.
 */
function createDeps() {
  const followup = { assignPathway: jest.fn().mockResolvedValue({ id: 'assignment-1' }) };
  const booking = { getBooking: jest.fn() };
  const catalogue = { getConcernById: jest.fn() };

  const listener = new FollowupClinicalListener(
    followup as unknown as FollowupService,
    booking as unknown as BookingFacade,
    catalogue as unknown as CatalogueFacade,
  );

  return { listener, followup, booking, catalogue };
}

describe('FollowupClinicalListener', () => {
  it('assigns depression_anxiety for a depression concern', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: 'concern-1' });
    catalogue.getConcernById.mockResolvedValue({ code: 'depression' });

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'depression_anxiety' });
  });

  it('assigns depression_anxiety for an anxiety concern', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: 'concern-1' });
    catalogue.getConcernById.mockResolvedValue({ code: 'anxiety' });

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'depression_anxiety' });
  });

  it('assigns bipolar_psychosis for a psychosis concern', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: 'concern-1' });
    catalogue.getConcernById.mockResolvedValue({ code: 'psychosis' });

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'bipolar_psychosis' });
  });

  it.each(['ocd', 'child_adolescent', 'womens_mental_health', 'elderly_care', 'something_unmapped'])(
    'defaults to general for an unmapped concern code (%s)',
    async (code) => {
      const { listener, followup, booking, catalogue } = createDeps();
      booking.getBooking.mockResolvedValue({ concernId: 'concern-1' });
      catalogue.getConcernById.mockResolvedValue({ code });

      await listener.onRecordFinalised({ consultationId: 'c-1' });

      expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'general' });
    },
  );

  it('defaults to general when the booking has no concernId', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: null });

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(catalogue.getConcernById).not.toHaveBeenCalled();
    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'general' });
  });

  it('defaults to general when the booking cannot be found at all', async () => {
    const { listener, followup, booking } = createDeps();
    booking.getBooking.mockResolvedValue(null);

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'general' });
  });

  it('defaults to general when the concern id on the booking no longer resolves', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: 'concern-stale' });
    catalogue.getConcernById.mockResolvedValue(null);

    await listener.onRecordFinalised({ consultationId: 'c-1' });

    expect(followup.assignPathway).toHaveBeenCalledWith({ consultationId: 'c-1', pathwayCode: 'general' });
  });

  it('swallows a failure from assignPathway rather than throwing, so a bad delivery cannot look like a finalise failure', async () => {
    const { listener, followup, booking, catalogue } = createDeps();
    booking.getBooking.mockResolvedValue({ concernId: 'concern-1' });
    catalogue.getConcernById.mockResolvedValue({ code: 'sleep' });
    followup.assignPathway.mockRejectedValue(new Error('PATHWAY_NOT_FOUND: no current version for code sleep'));

    await expect(listener.onRecordFinalised({ consultationId: 'c-1' })).resolves.toBeUndefined();
  });

  it('swallows a failure from the booking read too', async () => {
    const { listener, followup, booking } = createDeps();
    booking.getBooking.mockRejectedValue(new Error('boom'));

    await expect(listener.onRecordFinalised({ consultationId: 'c-1' })).resolves.toBeUndefined();
    expect(followup.assignPathway).not.toHaveBeenCalled();
  });
});
