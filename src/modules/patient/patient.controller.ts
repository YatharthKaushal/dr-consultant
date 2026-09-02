import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { UpdatePatientProfileDto } from './patient.dto';
import { PatientService } from './patient.service';

/** No logic here — parse, delegate. */
@Controller('patients')
export class PatientController {
  constructor(private readonly patients: PatientService) {}

  @Get('me')
  @AccountType('patient')
  getMe(@CurrentUser() auth: AuthContext) {
    return this.patients.getOwnProfile(auth.accountId);
  }

  @Patch('me')
  @AccountType('patient')
  updateMe(@CurrentUser() auth: AuthContext, @Body() dto: UpdatePatientProfileDto) {
    return this.patients.updateOwnProfile(auth.accountId, dto);
  }
}
