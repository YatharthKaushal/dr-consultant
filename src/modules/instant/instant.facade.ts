import { Injectable } from '@nestjs/common';
import { InstantPresenceService } from './instant-presence.service';
import type {
  CompletionGateView,
  ConsultEndView,
  ConsultStartView,
  InstantConsultView,
  InstantContract,
  InstantPresenceView,
} from './instant.contract';
import { InstantService } from './instant.service';

/**
 * M-13's single public surface (`backend/README.md` §2).
 *
 * Deliberately narrow. Nothing outside this module starts, answers, times out
 * or re-routes an instant request — those all run from this module's own
 * controllers and sweeps — so the contract carries only what the two modules
 * that depend on M-13 actually need:
 *
 *   M-15 (Clinical Records)  `clearCompletionGate`. THE reason this facade
 *                            exists. `docs/erd.sql` puts clearing
 *                            `doctors.blocked_by_consultation_id` in the same
 *                            transaction that sets `clinical_records
 *                            .finalised_at`; M-15 holds the consultation, not
 *                            a `doctors` UPDATE, and this is how it reaches
 *                            one. See `instant.contract.ts` for what "the same
 *                            transaction" can honestly mean across a module
 *                            boundary, and why the method is idempotent.
 *
 *   M-14 (Video)             `markConsultInProgress` when the call starts, so
 *                            the doctor leaves the routing pool for its
 *                            duration; `markInstantConsultEnded` when it ends,
 *                            so they are gated and moved to
 *                            `completing_notes`.
 *
 *   M-09 / M-04              `getPresence`. FR-4.2's "live availability" on a
 *                            listing card is the same fact as FR-10.2's
 *                            Available Now badge.
 *
 *   Admin / M-21             `getInstantConsult`. One request's routing
 *                            history.
 *
 * `markInstantConsultEnded` here is the TRUSTED module-to-module form and
 * applies no ownership check — the caller authorizes, the same rule
 * `BookingContract.findById` states. The doctor-facing route goes through
 * `InstantService#markOwnInstantConsultEnded` instead, which does.
 */
@Injectable()
export class InstantFacade implements InstantContract {
  constructor(
    private readonly instant: InstantService,
    private readonly presence: InstantPresenceService,
  ) {}

  /** See `InstantContract#markInstantConsultEnded`. */
  async markInstantConsultEnded(consultationId: string): Promise<CompletionGateView> {
    return this.instant.markInstantConsultEnded(consultationId);
  }

  /** *** M-14 CALLS THIS. *** The call started — take the doctor out of the routing pool. See `InstantContract#markConsultInProgress`. */
  async markConsultInProgress(consultationId: string): Promise<ConsultStartView> {
    return this.instant.markConsultInProgress(consultationId);
  }

  /** *** M-14 CALLS THIS. *** The call ended — put the doctor back. The inverse of the method above; see `InstantContract#markConsultEnded`. */
  async markConsultEnded(consultationId: string): Promise<ConsultEndView> {
    return this.instant.markConsultEnded(consultationId);
  }

  /** *** M-15 CALLS THIS. *** See `InstantContract#clearCompletionGate`. */
  async clearCompletionGate(consultationId: string): Promise<CompletionGateView> {
    return this.instant.clearCompletionGate(consultationId);
  }

  async getInstantConsult(consultationId: string): Promise<InstantConsultView | null> {
    return this.instant.getInstantConsult(consultationId);
  }

  async getPresence(doctorId: string): Promise<InstantPresenceView | null> {
    return this.presence.getPresence(doctorId);
  }

  /** *** M-21 CALLS THIS. *** See `InstantContract#countOffersForConsultations` — a pure, read-only count, nothing here is anonymized or deleted. */
  async countOffersForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.instant.countOffersForConsultations(consultationIds);
  }
}
