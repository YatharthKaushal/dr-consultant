import { Injectable } from '@nestjs/common';
import { ClinicalService } from './clinical.service';
import type { ClinicalCarePlanView, ClinicalContract, ClinicalRecordView } from './clinical.contract';

/**
 * M-15's single public surface (`backend/README.md` §2).
 *
 * Deliberately narrow, and deliberately READ-ONLY. The two modules that
 * `docs/MODULES.md` lists as depending on M-15 each need exactly one read:
 *
 *   M-16 (Follow-Up)      `getCarePlanInputs`. FR-14.1's Care Plan is composed
 *                         "in one place: prescription and warning signs from
 *                         M-15", and that module "stores nothing of its own; it
 *                         reads through each owning module".
 *
 *   M-17 (Clarification)  `getRecordByConsultationId`. A treating doctor's
 *                         de-identified case starts from the record they wrote.
 *
 * *** NO WRITE IS EXPOSED, AND THAT IS THE POINT. *** Finalising a clinical
 * record asserts that a clinician did the clinical work; it is the treating
 * doctor's act, reached through this module's own controller with their own
 * credentials. A facade method that let another module finalise on a doctor's
 * behalf would make FR-11.5's "enforced by the system, not by convention" mean
 * nothing, because the convention would just move one module along.
 */
@Injectable()
export class ClinicalFacade implements ClinicalContract {
  constructor(private readonly clinical: ClinicalService) {}

  /** See `ClinicalContract#getRecordByConsultationId`. No ownership check — the caller authorizes. */
  async getRecordByConsultationId(consultationId: string): Promise<ClinicalRecordView | null> {
    return this.clinical.getRecordByConsultationId(consultationId);
  }

  /** *** M-16 CALLS THIS. *** See `ClinicalContract#getCarePlanInputs`. */
  async getCarePlanInputs(consultationId: string): Promise<ClinicalCarePlanView | null> {
    return this.clinical.getCarePlanInputs(consultationId);
  }

  /** ADDITIVE (M-20/governance and quality) — see `ClinicalContract#listPendingCaseSummaries`. */
  async listPendingCaseSummaries(limit: number, offset: number): Promise<ClinicalRecordView[]> {
    return this.clinical.listPendingCaseSummaries(limit, offset);
  }

  /** ADDITIVE (M-20/governance and quality) — see `ClinicalContract#countPendingCaseSummaries`. */
  async countPendingCaseSummaries(): Promise<number> {
    return this.clinical.countPendingCaseSummaries();
  }

  /** ADDITIVE (M-21/data rights execution) — see `ClinicalContract#countRecordsForConsultations`. */
  async countRecordsForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.clinical.countRecordsForConsultations(consultationIds);
  }
}
