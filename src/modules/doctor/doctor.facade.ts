import { Injectable } from '@nestjs/common';
import { DoctorPresenceService } from './doctor-presence.service';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import type {
  CompletionGateResult,
  DoctorContract,
  DoctorPresenceState,
  DoctorSchedulingParameters,
  DoctorSchedulingParametersById,
  InstantRoutingCandidate,
  ListedDoctorFilter,
  ListedDoctorSummary,
  ListInstantRoutingCandidatesFilter,
  PresenceActor,
  PresenceTransitionInput,
  PresenceTransitionResult,
  PublicDoctorProfile,
  ResetPresenceInput,
} from './doctor.contract';
import { DoctorService } from './doctor.service';

@Injectable()
export class DoctorFacade implements DoctorContract {
  constructor(
    private readonly doctorService: DoctorService,
    private readonly specialtyService: DoctorSpecialtyService,
    private readonly presenceService: DoctorPresenceService,
  ) {}

  async getPublicProfile(doctorId: string): Promise<PublicDoctorProfile | null> {
    return this.doctorService.getPublicProfile(doctorId);
  }

  async isVerifiedAndListed(doctorId: string): Promise<boolean> {
    return this.doctorService.isVerifiedAndListed(doctorId);
  }

  async getPrescribingEligibility(doctorId: string): Promise<boolean> {
    return this.specialtyService.getPrescribingEligibility(doctorId);
  }

  /** ADDITIVE (M-07/availability) — see `doctor.contract.ts`. */
  async getSchedulingParameters(doctorId: string): Promise<DoctorSchedulingParameters | null> {
    return this.doctorService.getSchedulingParameters(doctorId);
  }

  /** ADDITIVE (M-07/availability, forced by M-09) — see `doctor.contract.ts`. */
  async getSchedulingParametersForMany(doctorIds: readonly string[]): Promise<DoctorSchedulingParametersById[]> {
    return this.doctorService.getSchedulingParametersForMany(doctorIds);
  }

  /** ADDITIVE (M-09/search) — see `doctor.contract.ts`. */
  async listListedDoctors(filter: ListedDoctorFilter): Promise<ListedDoctorSummary[]> {
    return this.doctorService.listListedDoctors(filter);
  }

  /* ── ADDITIVE (M-13/presence and instant consult) ──────────────────────── */
  /* See `doctor-presence.service.ts`'s header for the whole boundary argument. */

  async getPresenceState(doctorId: string): Promise<DoctorPresenceState | null> {
    return this.presenceService.getPresenceState(doctorId);
  }

  async transitionPresence(input: PresenceTransitionInput): Promise<PresenceTransitionResult> {
    return this.presenceService.transitionPresence(input);
  }

  async setCompletionGate(input: {
    doctorId: string;
    consultationId: string;
    actor: PresenceActor;
  }): Promise<CompletionGateResult> {
    return this.presenceService.setCompletionGate(input);
  }

  async clearCompletionGate(input: { consultationId: string; actor: PresenceActor }): Promise<CompletionGateResult> {
    return this.presenceService.clearCompletionGate(input);
  }

  async listInstantRoutingCandidates(filter: ListInstantRoutingCandidatesFilter): Promise<InstantRoutingCandidate[]> {
    return this.presenceService.listInstantRoutingCandidates(filter);
  }

  async resetPresence(input: ResetPresenceInput): Promise<{ doctorIds: string[] }> {
    return this.presenceService.resetPresence(input);
  }
}
