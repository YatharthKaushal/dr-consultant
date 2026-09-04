import { randomUUID } from 'node:crypto';
import { UnavailableConsentProvider } from './unavailable-consent.provider';
import { VideoFacade } from './video.facade';

/**
 * The public surface, and the null object that guards the M-03 seam.
 *
 * Both are short, and both are load-bearing: the facade is the only way another
 * module reaches M-14, and the null object decides what happens to every join
 * attempt until M-03 merges.
 */
describe('VideoFacade', () => {
  it('passes a consultation id straight through to the service, with no ownership check', async () => {
    // The TRUSTED module-to-module form — the CALLER authorizes, the same rule
    // `BookingContract#findById` and `InstantContract#getInstantConsult` state.
    const consultationId = randomUUID();
    const session = { consultationId, connections: [], noShowParties: ['patient', 'doctor'] };
    const service = { getSession: jest.fn().mockResolvedValue(session), countParticipantRowsForConsultations: jest.fn() };

    const facade = new VideoFacade(service as never);

    await expect(facade.getSession(consultationId)).resolves.toBe(session);
    expect(service.getSession).toHaveBeenCalledWith(consultationId);
  });

  /** *** M-21 CALLS THIS. *** A pure row count for a patient data-deletion preview — see `video.contract.ts#VideoContract.countParticipantRowsForConsultations`. Nothing here writes. */
  it('delegates the M-21 data-rights participant-row count', async () => {
    const consultationId = randomUUID();
    const service = { getSession: jest.fn(), countParticipantRowsForConsultations: jest.fn().mockResolvedValue(2) };

    const facade = new VideoFacade(service as never);

    await expect(facade.countParticipantRowsForConsultations([consultationId])).resolves.toBe(2);
    expect(service.countParticipantRowsForConsultations).toHaveBeenCalledWith([consultationId]);
  });

  it('*** EXPOSES NOTHING THAT MINTS A TOKEN ***', () => {
    // FR-8.5's gate is defined in terms of the CALLER — "only the assigned
    // patient and doctor" — so a trusted module-to-module mint would be a way
    // to get into a clinical conversation without being either of them. If
    // somebody adds one, this fails. The one addition since is M-21's
    // read-only row count, which cannot open a call — see the test above.
    const methods = Object.getOwnPropertyNames(VideoFacade.prototype).filter((name) => name !== 'constructor');

    expect(methods.sort()).toEqual(['countParticipantRowsForConsultations', 'getSession']);
  });
});

describe('UnavailableConsentProvider', () => {
  const patientId = randomUUID();

  it('*** REFUSES — this is a GATE, and a missing consent module means "cannot join" ***', async () => {
    const provider = new UnavailableConsentProvider();

    await expect(
      provider.checkPatientConsent({ patientId, documentType: 'teleconsultation_consent' }),
    ).resolves.toEqual({
      hasCurrentConsent: false,
      acceptedVersion: null,
      acceptedAt: null,
      currentVersion: null,
    });
  });

  it('does NOT throw — the port is documented as always answering', async () => {
    // The opposite half of the decision from `UnavailableBookingPaymentProvider`,
    // which raises a 503. Here the caller turns the closed answer into a clean
    // `VIDEO_CONSENT_REQUIRED`, which is a better answer for a patient than a
    // 503 whether the cause is "you have not consented" or "M-03 is not wired
    // up yet".
    const provider = new UnavailableConsentProvider();

    await expect(
      provider.checkPatientConsent({ patientId, documentType: 'privacy_policy' }),
    ).resolves.toMatchObject({ hasCurrentConsent: false });
  });

  it('refuses every document type, not just teleconsultation consent', async () => {
    const provider = new UnavailableConsentProvider();

    for (const documentType of ['teleconsultation_consent', 'privacy_policy', 'terms_of_use'] as const) {
      await expect(provider.checkPatientConsent({ patientId, documentType })).resolves.toMatchObject({
        hasCurrentConsent: false,
      });
    }
  });
});
