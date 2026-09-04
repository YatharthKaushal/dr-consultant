/**
 * *** THE FROZEN PORT, PINNED BY A COMPILING TEST. ***
 *
 * M-14 (video) declares its OWN copy of `ConsentContract` and binds
 * `ConsentFacade` to `CONSENT_PORT` against it. It cannot import this module's
 * contract, so the two agree STRUCTURALLY or not at all — and a rename here
 * would otherwise fail in M-14's module file, days later, in someone else's
 * worktree.
 *
 * The mirror below is a verbatim copy of what M-14 declares. The assignment at
 * the bottom is the assertion: if `ConsentFacade` stops satisfying it —
 * a renamed field, a widened return, a new required argument — `tsc` fails
 * here, in the module that broke it.
 */

import type { LegalDocumentType } from '../../schema/enums.schema';
import { ConsentFacade } from './consent.facade';
import type { ConsentService } from './consent.service';

/* ---- M-14's local mirror, copied verbatim -------------------------------- */

interface MirroredConsentCheck {
  hasCurrentConsent: boolean;
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  currentVersion: string | null;
}

interface MirroredConsentContract {
  checkPatientConsent(input: {
    patientId: string;
    documentType: LegalDocumentType;
  }): Promise<MirroredConsentCheck>;
}

/* ------------------------------------------------------------------------- */

describe('ConsentFacade / CONSENT_PORT conformance', () => {
  it('satisfies M-14’s local mirror structurally — no adapter, no cast', async () => {
    const service = {
      checkPatientConsent: jest.fn().mockResolvedValue({
        hasCurrentConsent: false,
        acceptedVersion: null,
        acceptedAt: null,
        currentVersion: null,
      }),
    } as unknown as ConsentService;

    // The compile-time assertion: a plain assignment, no `as`.
    const port: MirroredConsentContract = new ConsentFacade(service);

    await expect(
      port.checkPatientConsent({ patientId: 'p1', documentType: 'teleconsultation_consent' }),
    ).resolves.toEqual({
      hasCurrentConsent: false,
      acceptedVersion: null,
      acceptedAt: null,
      currentVersion: null,
    });
  });
});
