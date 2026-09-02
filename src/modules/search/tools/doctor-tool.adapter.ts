import { Injectable } from '@nestjs/common';
import type { ListedDoctorSummary } from '../../doctor/doctor.contract';
import { DoctorFacade } from '../../doctor/doctor.facade';
import { DEFAULT_TOOL_RESULT_LIMIT } from './search-tool.constants';
import type { DoctorToolPort, ListListedDoctorsFilter } from './search-tool.contract';

/**
 * Binds `DOCTOR_TOOL_PORT` to the real `DoctorFacade`, translating the
 * agent-facing singular filter into the facade's plural `ListedDoctorFilter`
 * (see the note in `search-tool.contract.ts`). This one method is the only
 * place the two shapes meet.
 *
 * `maxFeeInr` crosses as a DECIMAL STRING, not a number: the column is
 * `numeric(10,2)` and the facade compares against it as text, so formatting
 * here — rather than letting a float reach SQL — is what stops a fee being
 * silently rounded at the boundary.
 */
@Injectable()
export class DoctorToolAdapter implements DoctorToolPort {
  constructor(private readonly doctor: DoctorFacade) {}

  /**
   * Retained so `get-service-details.tool.ts` keeps its honest-degradation
   * branch (a null `directory` block rather than a fabricated
   * `doctorCount: 0`, which an agent would relay to a patient as "there are
   * no psychiatrists"). The facade now always provides the read, so this is
   * `true` — but the branch stays, because the day it can fail again is the
   * day we want it back, not the day we rediscover why it existed.
   */
  isAvailable(): boolean {
    return true;
  }

  async listListedDoctors(filter: ListListedDoctorsFilter): Promise<ListedDoctorSummary[]> {
    return this.doctor.listListedDoctors({
      specialtyIds: filter.specialtyId ? [filter.specialtyId] : undefined,
      languages: filter.language ? [filter.language] : undefined,
      maxFeeInr: filter.maxFeeInr === undefined ? undefined : filter.maxFeeInr.toFixed(2),
      limit: filter.limit ?? DEFAULT_TOOL_RESULT_LIMIT,
      offset: 0,
    });
  }
}
