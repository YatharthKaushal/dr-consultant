import { Module } from '@nestjs/common';
import { DoctorModule } from '../doctor/doctor.module';
import { BUSY_INTERVAL_PROVIDER } from './availability.constants';
import { AvailabilityAdminController } from './availability-admin.controller';
import { AvailabilityPublicController } from './availability-public.controller';
import { AvailabilityController } from './availability.controller';
import { AvailabilityFacade } from './availability.facade';
import { AvailabilityRuleRepository } from './availability-rule.repository';
import { AvailabilityRuleService } from './availability-rule.service';
import { AvailabilitySettingsRepository } from './availability-settings.repository';
import { AvailabilitySettingsService } from './availability-settings.service';
import { AvailabilitySlotService } from './availability-slot.service';
import { ConsultationBusyIntervalProvider } from './consultation-busy-interval.provider';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`, nothing outside
 * this module resolves a DI token from here; other modules consume
 * `AvailabilityFacade` via normal constructor injection after importing
 * `AvailabilityModule`.
 *
 * `DoctorModule` is a real (non-global) import — `AvailabilitySlotService`
 * resolves `DoctorFacade` from it for scheduling parameters/booking
 * eligibility. `DATABASE`, `AuditService` and `AppConfigService` are all
 * `@Global()` (`DatabaseModule`, `AuditModule`, `AppConfigModule`), so no
 * `imports` are needed here for those — same as `DoctorModule`/
 * `CatalogueModule` need none for `DATABASE`/`AuditService`.
 *
 * `BUSY_INTERVAL_PROVIDER` is bound to `ConsultationBusyIntervalProvider`
 * here (a placeholder — M-11/Booking doesn't exist yet). Swapping it for a
 * `BookingFacade`-backed implementation later is a one-line change to this
 * `providers` array; nothing else in this module needs to change.
 */
@Module({
  imports: [DoctorModule],
  controllers: [AvailabilityController, AvailabilityPublicController, AvailabilityAdminController],
  providers: [
    AvailabilityRuleRepository,
    AvailabilitySettingsRepository,
    AvailabilityRuleService,
    AvailabilitySettingsService,
    AvailabilitySlotService,
    { provide: BUSY_INTERVAL_PROVIDER, useClass: ConsultationBusyIntervalProvider },
    AvailabilityFacade,
  ],
  exports: [AvailabilityFacade],
})
export class AvailabilityModule {}
