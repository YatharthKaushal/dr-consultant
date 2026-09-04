import { Module } from '@nestjs/common';
import { ClinicalModule } from '../clinical/clinical.module';
import { DoctorModule } from '../doctor/doctor.module';
import { ClarificationAdminController } from './clarification-admin.controller';
import { ClarificationController } from './clarification.controller';
import { ClarificationFacade } from './clarification.facade';
import { ClarificationRepository } from './clarification.repository';
import { ClarificationService } from './clarification.service';

/**
 * M-17: Case Clarification.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; a future M-20 will consume
 * `ClarificationFacade` via normal constructor injection after importing
 * `ClarificationModule`.
 *
 * ---------------------------------------------------------------------------
 * *** THIS MODULE OWNS ONE TABLE AND READS NOBODY ELSE'S. ***
 *
 * `clarification_cases`, and nothing else. Every other fact it needs arrives
 * through a facade:
 *
 *   `doctors`   `DoctorFacade.isExpertDoctor` — CHECK #1, "who may be asked"
 *               (`clarification-cases.schema.ts`). `treatingDoctorId` and
 *               `expertDoctorId` themselves are never read back FROM
 *               `doctors` here; they are `@CurrentUser().accountId` (the
 *               doctor account IS the doctor row's id, the same identity
 *               `clinical.controller.ts` relies on) and an admin-supplied id
 *               respectively.
 *   `clinical_records`
 *               `ClinicalFacade.getRecordByConsultationId` — the one
 *               existence check `assertSourceConsultationExists` performs
 *               for an optional `sourceConsultationId`. See that method's
 *               doc comment in `clarification.service.ts` for exactly what
 *               it does and does not verify.
 *
 * *** NO `BookingModule`, NO `IdentityModule` IMPORT. *** `docs/MODULES.md`
 * lists M-17 depending on M-02/M-05/M-15 only. M-02 (identity) is already
 * satisfied by `@AccountType`/`@RequirePermission`/`@CurrentUser()` from
 * `shared/auth`, which every module gets without importing `IdentityModule`
 * (see `doctor.module.ts`'s own header for the same point about `@Global()`
 * providers). M-11 (booking) is deliberately NOT a dependency, which is why
 * `sourceConsultationId` cannot be ownership-verified here — see
 * `clarification.service.ts#assertSourceConsultationExists`.
 * ---------------------------------------------------------------------------
 */
@Module({
  imports: [DoctorModule, ClinicalModule],
  controllers: [ClarificationController, ClarificationAdminController],
  providers: [ClarificationRepository, ClarificationService, ClarificationFacade],
  exports: [ClarificationFacade],
})
export class ClarificationModule {}
