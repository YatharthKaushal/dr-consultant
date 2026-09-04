import { Controller, Get, Param } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ClinicalService } from './clinical.service';

/**
 * *** THIS IS WHAT `clinical.read_records` GATES. ***
 *
 * The permission has existed in `permission.catalog.ts` since M-01, bundled to
 * `super_admin` and `clinical_governance`, described as "Read a consultation's
 * clinical notes and prescription" — and until now NO CONTROLLER USED IT. A
 * permission nothing checks is a promise nobody keeps. These two routes are
 * what turn it on. No permission is added, renamed or re-bundled.
 *
 * `care_coordinator` deliberately does NOT hold it (`permission.catalog.ts`:
 * "Deliberately NO clinical.read_records: a coordinator acts on the alert"),
 * and SRS §6.2's minimum-necessary rule is why. Nothing here widens that, and a
 * route that quietly returned a case summary to a coordinator would.
 *
 * READ-ONLY, and that is structural. `RequirePermission` implies
 * `@AccountType('admin')`, so no doctor or patient reaches these; and there is
 * no admin write anywhere in this module. An operator cannot author, edit or
 * finalise a clinical record, because FR-11.5's "enforced by the system, not by
 * convention" means the doctor who did the clinical work is the only one who
 * may assert that it was done.
 *
 * Both reads are themselves written to `audit_log` (`action: 'read'`) — the
 * most sensitive read in the panel leaves a trace of who looked.
 */
@Controller('admin/clinical-records')
@AccountType('admin')
export class ClinicalAdminController {
  constructor(private readonly clinical: ClinicalService) {}

  /**
   * *** "THE FULL RECORD REBUILDS FROM THE CONSULTATION ID" (`docs/MODULES.md`
   * M-15's done-when). *** One id in, the whole clinical record out — notes,
   * diagnosis, risk category, referral, every medicine line, the whole advice
   * and therapy plan, the case summary, and whether it is final.
   *
   * Addressed by CONSULTATION id, not by the record's own primary key, because
   * the consultation id is the identifier FR-11.6 makes the spine of the case
   * and the only one a caller coming from booking, payments or an alert
   * actually holds.
   */
  @Get(':consultationId')
  @RequirePermission(PERMISSIONS.CLINICAL_READ_RECORDS)
  getRecord(
    @CurrentUser() auth: AuthContext,
    @Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string,
  ) {
    return this.clinical.getRecordForAdmin(consultationId, auth.accountId);
  }

  /** FR-11.6's cross-module trail for one consultation — see `ClinicalService#getConsultationTrailForAdmin`. */
  @Get(':consultationId/audit-trail')
  @RequirePermission(PERMISSIONS.CLINICAL_READ_RECORDS)
  getAuditTrail(
    @CurrentUser() auth: AuthContext,
    @Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string,
  ) {
    return this.clinical.getConsultationTrailForAdmin(consultationId, auth.accountId);
  }
}
