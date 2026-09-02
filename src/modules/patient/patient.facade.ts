import { Injectable } from '@nestjs/common';
import type { PatientContract, PatientProfileSummary } from './patient.contract';
import { PatientRepository } from './patient.repository';

@Injectable()
export class PatientFacade implements PatientContract {
  constructor(private readonly repo: PatientRepository) {}

  async getProfileSummary(patientId: string): Promise<PatientProfileSummary | null> {
    const row = await this.repo.findById(patientId);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth,
      gender: row.gender,
      preferredLanguage: row.preferredLanguage,
    };
  }
}
