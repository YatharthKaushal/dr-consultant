import { Module } from '@nestjs/common';
import { PatientAdminController } from './patient-admin.controller';
import { PatientController } from './patient.controller';
import { PatientFacade } from './patient.facade';
import { PatientRepository } from './patient.repository';
import { PatientService } from './patient.service';

/** Not `@Global()` — nothing depends on Patient yet; `IdentityModule` is global, so `IdentityFacade` is injectable here without importing it. */
@Module({
  controllers: [PatientController, PatientAdminController],
  providers: [PatientRepository, PatientService, PatientFacade],
  exports: [PatientFacade],
})
export class PatientModule {}
