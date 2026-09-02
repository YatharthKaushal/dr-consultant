import { Injectable } from '@nestjs/common';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import type {
  DoctorContract,
  DoctorSchedulingParameters,
  DoctorSchedulingParametersById,
  ListedDoctorFilter,
  ListedDoctorSummary,
  PublicDoctorProfile,
} from './doctor.contract';
import { DoctorService } from './doctor.service';

@Injectable()
export class DoctorFacade implements DoctorContract {
  constructor(
    private readonly doctorService: DoctorService,
    private readonly specialtyService: DoctorSpecialtyService,
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
}
