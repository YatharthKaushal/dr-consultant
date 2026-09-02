import { Injectable } from '@nestjs/common';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import type { DoctorContract, PublicDoctorProfile } from './doctor.contract';
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
}
