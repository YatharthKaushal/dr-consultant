import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { AssignExpertDto, ListClarificationCasesQueryDto } from './clarification.dto';
import { ClarificationService } from './clarification.service';

/**
 * *** THIS IS WHAT `governance.read_clarifications` AND
 * `governance.manage_clarifications` GATE. *** Both permissions have existed
 * in `permission.catalog.ts` since M-01 — bundled to `super_admin` and
 * `clinical_governance`, described as "View the case-clarification tracker"
 * and "Assign an expert to a clarification case" — and until now no
 * controller used either. `clinical-admin.controller.ts` states the same
 * finding for `clinical.read_records`: "a permission nothing checks is a
 * promise nobody keeps." These three routes are what turn both on.
 *
 * `docs/MODULES.md` gives M-20 (Governance and Quality, unbuilt) the "case
 * clarification tracker" working queue and lists it as depending on M-17.
 * Until M-20 exists, these routes ARE that tracker — served directly against
 * `ClarificationService`, never `ClarificationFacade`, the same way
 * `clinical-admin.controller.ts` already serves what will become part of
 * M-20's dashboard ahead of M-20 itself. When M-20 is built, its own working
 * -queue read can compose across modules through `ClarificationContract
 * .getCaseSummary`; these routes do not need to move for that to work.
 *
 * `getOne`/`list` are governance READS of the full case, including
 * `sourceConsultationId` — an admin holding `governance.read_clarifications`
 * is a clinical-governance operator overseeing the same case an expert
 * reviews de-identified, not a stand-in for the expert, so the narrower
 * de-identified view is not the right one here.
 */
@Controller('admin/clarification-cases')
@AccountType('admin')
export class ClarificationAdminController {
  constructor(private readonly clarification: ClarificationService) {}

  /** The tracker's list. */
  @Get()
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS)
  list(@Query() query: ListClarificationCasesQueryDto) {
    return this.clarification.listForAdmin(query);
  }

  /** The tracker's detail read. */
  @Get(':id')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS)
  getOne(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.getForAdmin(id);
  }

  /**
   * *** CHECK #1 FROM `clarification-cases.schema.ts`: "WHO MAY BE ASKED".
   * *** `posted` -> `awaiting_response`. `clarification.service.ts
   * #assignExpert` is what actually asserts `seniorityLevel === 'expert'`;
   * this route only wires the admin's identity and permission to it.
   *
   * `@HttpCode(OK)`: transitions a case that already exists rather than
   * creating one.
   */
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.GOVERNANCE_MANAGE_CLARIFICATIONS)
  assign(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AssignExpertDto,
  ) {
    return this.clarification.assignExpert(id, dto.expertDoctorId, auth.accountId);
  }
}
