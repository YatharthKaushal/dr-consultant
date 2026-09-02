import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { UpdatePatientStatusDto } from './patient.dto';
import { PatientService } from './patient.service';

/**
 * Admin patient screens. "Doctor can read an assigned patient" is a
 * consultation-scoped ownership rule that cannot be implemented correctly
 * yet — deferred until M-11 (consultations) lands.
 */
@Controller('admin/patients')
@AccountType('admin')
export class PatientAdminController {
  constructor(private readonly patients: PatientService) {}

  /** Plain list, no pagination — first admin patient screen; add pagination when the panel needs it. */
  @Get()
  @RequirePermission(PERMISSIONS.PATIENTS_READ)
  list() {
    return this.patients.listForAdmin();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PATIENTS_READ)
  getById(@Param('id') id: string) {
    return this.patients.getForAdmin(id);
  }

  @Patch(':id/status')
  @RequirePermission(PERMISSIONS.PATIENTS_MANAGE_STATUS)
  updateStatus(@CurrentUser() auth: AuthContext, @Param('id') id: string, @Body() dto: UpdatePatientStatusDto) {
    return this.patients.updateStatus(auth.accountId, id, dto.status);
  }
}
