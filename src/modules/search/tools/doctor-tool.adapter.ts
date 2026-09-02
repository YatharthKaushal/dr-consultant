import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PublicDoctorProfile } from '../../doctor/doctor.contract';
import { DoctorFacade } from '../../doctor/doctor.facade';
import { TOOL_ERROR_CODES } from './search-tool.constants';
import type { DoctorToolPort, ListListedDoctorsFilter } from './search-tool.contract';

/** See `catalogue-tool.adapter.ts` — same reasoning, same post-merge story. */
type PendingDoctorMethods = Partial<Pick<DoctorToolPort, 'listListedDoctors'>>;

/**
 * Binds `DOCTOR_TOOL_PORT` to the real `DoctorFacade`.
 *
 * `DoctorFacade` has NO multi-doctor read at all in this worktree's checkout
 * — the parallel search worktree (M-09) is adding `listListedDoctors`. Until
 * it lands, every call is refused with `DOCTOR_DIRECTORY_UNAVAILABLE`.
 *
 * `isAvailable()` exists so `get-service-details.tool.ts` can answer with the
 * specialty facts it CAN prove (name, description, canPrescribe — all real,
 * straight from `CatalogueFacade`) and an explicitly null `directory` block,
 * instead of either failing the whole call or, far worse, reporting a
 * fabricated `doctorCount: 0` / `feeRange: null` that an agent would happily
 * relay to a patient as "there are no psychiatrists".
 */
@Injectable()
export class DoctorToolAdapter implements DoctorToolPort {
  constructor(private readonly doctor: DoctorFacade) {}

  /** Whether the underlying facade can actually list doctors in this build. */
  isAvailable(): boolean {
    return typeof this.pending().listListedDoctors === 'function';
  }

  async listListedDoctors(filter: ListListedDoctorsFilter): Promise<PublicDoctorProfile[]> {
    const method = this.pending().listListedDoctors;
    if (typeof method !== 'function') {
      throw new ServiceUnavailableException({
        code: TOOL_ERROR_CODES.DOCTOR_DIRECTORY_UNAVAILABLE,
        message: 'The doctor directory is not available in this deployment (DoctorFacade.listListedDoctors is not bound yet).',
      });
    }
    return method.call(this.doctor, filter);
  }

  private pending(): PendingDoctorMethods {
    return this.doctor as DoctorFacade & PendingDoctorMethods;
  }
}
