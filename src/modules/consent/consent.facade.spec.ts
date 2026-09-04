/**
 * `ConsentFacade` — the ONE guarantee M-14 binds its `CONSENT_PORT` to: this
 * never throws, and every failure answers `hasCurrentConsent: false`.
 *
 * `new ConsentFacade(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 */

import { Logger } from '@nestjs/common';
import type { ConsentCheck } from './consent.contract';
import { ConsentFacade } from './consent.facade';
import type { ConsentService } from './consent.service';

const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';

const REFUSED: ConsentCheck = {
  hasCurrentConsent: false,
  acceptedVersion: null,
  acceptedAt: null,
  currentVersion: null,
};

describe('ConsentFacade', () => {
  let consents: jest.Mocked<ConsentService>;
  let facade: ConsentFacade;

  beforeEach(() => {
    // The facade logs every swallowed failure at error level. Silenced here so
    // a passing suite is not full of red text; the assertions below are what
    // prove the logging still happens.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    consents = {
      checkPatientConsent: jest.fn().mockResolvedValue({
        hasCurrentConsent: true,
        acceptedVersion: 'v2',
        acceptedAt: new Date('2026-03-01T10:00:00.000Z'),
        currentVersion: 'v2',
      }),
    } as unknown as jest.Mocked<ConsentService>;

    facade = new ConsentFacade(consents);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes a real answer straight through', async () => {
    const check = await facade.checkPatientConsent({
      patientId: PATIENT_ID,
      documentType: 'teleconsultation_consent',
    });

    expect(check).toEqual({
      hasCurrentConsent: true,
      acceptedVersion: 'v2',
      acceptedAt: new Date('2026-03-01T10:00:00.000Z'),
      currentVersion: 'v2',
    });
    expect(consents.checkPatientConsent).toHaveBeenCalledWith(PATIENT_ID, 'teleconsultation_consent');
  });

  /**
   * *** FAILS CLOSED. *** Allowing a consultation that should have been refused
   * is a compliance breach (SRS §6.2); refusing one that should have been
   * allowed is a support ticket. So a dead database answers "no consent".
   */
  it.each([
    ['a database failure', new Error('connection terminated unexpectedly')],
    ['a thrown non-Error', 'boom'],
    ['a null rejection', null],
  ])('answers false rather than throwing on %s', async (_label, thrown) => {
    consents.checkPatientConsent.mockRejectedValue(thrown);

    await expect(
      facade.checkPatientConsent({ patientId: PATIENT_ID, documentType: 'teleconsultation_consent' }),
    ).resolves.toEqual(REFUSED);
  });

  it('logs the swallowed failure at error level — a silent close is indistinguishable from a real refusal', async () => {
    consents.checkPatientConsent.mockRejectedValue(new Error('database is down'));

    await facade.checkPatientConsent({ patientId: PATIENT_ID, documentType: 'teleconsultation_consent' });

    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('database is down'));
  });

  /** Nothing validates an in-process call from another module, so a missing id refuses instead of querying for `undefined`. */
  it.each([
    ['no patient id', { patientId: '', documentType: 'teleconsultation_consent' as const }],
    ['no document type', { patientId: PATIENT_ID, documentType: undefined as never }],
    ['no input at all', undefined as never],
  ])('refuses on %s without reaching the service', async (_label, input) => {
    await expect(facade.checkPatientConsent(input)).resolves.toEqual(REFUSED);
    expect(consents.checkPatientConsent).not.toHaveBeenCalled();
  });

  /** A shared frozen refusal object would be handed to callers who may mutate it. */
  it('returns a fresh refusal object each time', async () => {
    consents.checkPatientConsent.mockRejectedValue(new Error('down'));

    const first = await facade.checkPatientConsent({ patientId: PATIENT_ID, documentType: 'privacy_policy' });
    const second = await facade.checkPatientConsent({ patientId: PATIENT_ID, documentType: 'privacy_policy' });

    expect(first).not.toBe(second);
  });
});
