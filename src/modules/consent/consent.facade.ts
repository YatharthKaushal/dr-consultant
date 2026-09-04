import { Injectable, Logger } from '@nestjs/common';
import type { LegalDocumentType } from '../../schema/enums.schema';
import type { ConsentCheck, ConsentContract } from './consent.contract';
import { ConsentService } from './consent.service';

/**
 * The answer every failure produces. A fresh object per call — a shared frozen
 * constant would be handed to callers who may (reasonably) spread or mutate it.
 */
function refused(): ConsentCheck {
  return { hasCurrentConsent: false, acceptedVersion: null, acceptedAt: null, currentVersion: null };
}

/**
 * M-03's public surface (`backend/README.md` §2). M-14 binds THIS class to its
 * own `CONSENT_PORT`, typed by a local mirror of `consent.contract.ts` — the
 * structural match is the contract, so no method here may be renamed or gain a
 * required argument without breaking a module that cannot see this file.
 */
@Injectable()
export class ConsentFacade implements ConsentContract {
  private readonly logger = new Logger(ConsentFacade.name);

  constructor(private readonly consents: ConsentService) {}

  /**
   * *** NEVER THROWS, AND FAILS CLOSED. ***
   *
   * The caller is a gate on entry to a medical consultation. Refusing a join
   * that should have been allowed is a support ticket; allowing one that should
   * have been refused is a compliance breach (SRS §6.2) — so every failure
   * mode, including a database that is simply down, answers
   * `hasCurrentConsent: false` rather than propagating.
   *
   * The failure is logged at error level precisely BECAUSE it is swallowed: a
   * silent closed answer is indistinguishable from a patient who never
   * consented, and an operator needs to be able to tell those apart.
   */
  async checkPatientConsent(input: { patientId: string; documentType: LegalDocumentType }): Promise<ConsentCheck> {
    try {
      // Defensive rather than decorative: this is an in-process call from
      // another module, so nothing has validated the argument, and a missing
      // patient id must refuse rather than query for `undefined`.
      if (!input || !input.patientId || !input.documentType) {
        this.logger.error('checkPatientConsent called without a patientId/documentType — refusing.');
        return refused();
      }

      return await this.consents.checkPatientConsent(input.patientId, input.documentType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `checkPatientConsent failed for patient ${input?.patientId ?? 'unknown'} / ${input?.documentType ?? 'unknown'} — failing closed: ${message}`,
      );
      return refused();
    }
  }
}
