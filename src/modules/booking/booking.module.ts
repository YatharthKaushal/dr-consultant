import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { DoctorModule } from '../doctor/doctor.module';
import { DocumentModule } from '../document/document.module';
import { PatientModule } from '../patient/patient.module';
import { PaymentFacade } from '../payment/payment.facade';
import { PaymentModule } from '../payment/payment.module';
import { BOOKING_PAYMENT_PORT } from './booking.constants';
import { BookingAdminController } from './booking-admin.controller';
import { BookingController } from './booking.controller';
import { BookingDoctorController } from './booking-doctor.controller';
import { BookingFacade } from './booking.facade';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingSlotHoldService } from './booking-slot-hold.service';

/**
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; other modules consume `BookingFacade`
 * via normal constructor injection after importing `BookingModule`.
 *
 * `PatientModule`, `DoctorModule`, `CatalogueModule`, `AvailabilityModule`
 * and `DocumentModule` are real (non-global) imports: M-11 reads patients,
 * doctors, specialties/concerns, slots and documents ONLY through their
 * facades, never their tables. `DATABASE`, `AuditService` and
 * `AppConfigService` are all `@Global()`, so they need no `imports` entry.
 *
 * ---------------------------------------------------------------------------
 * *** `BOOKING_PAYMENT_PORT` IS THE M-12 SEAM. ***
 *
 * Bound to the real `PaymentFacade` (M-11/M-12 merge). `PaymentFacade`
 * satisfies `BookingPaymentPort` structurally (see
 * `booking-payment.contract.ts`) — no adapter, no cast — so a signature drift
 * on either side surfaces HERE as a `tsc` error rather than a runtime
 * surprise. This module was built in a parallel worktree against a local
 * mirror of that interface and the rebind was a one-line change, which is the
 * whole point of the pattern.
 *
 * NOTE the dependency direction: booking calls payments, not the reverse.
 * `docs/MODULES.md` lists M-12 as depending on M-05/M-11, but at the code
 * level `createOrderForConsultation` takes the consultation id and fee as
 * arguments rather than looking either up, so `PaymentModule` imports no
 * feature module and there is no cycle.
 *
 * `UnavailableBookingPaymentProvider` stays in the tree afterwards, unbound:
 * it is the null object this module was built and tested against, and
 * rebinding it is the hard kill-switch that takes payment out of the booking
 * path at the DI level.
 *
 * ---------------------------------------------------------------------------
 * *** TWO TOKENS THIS MODULE DELIBERATELY DOES NOT REBIND. ***
 *
 * `availability`'s `BUSY_INTERVAL_PROVIDER` and `document`'s
 * `CONSULTATION_LOOKUP_PROVIDER` are both still bound to their own in-module
 * placeholders, which read `consultations` directly. `BookingFacade` is
 * structurally ready to replace both (see its doc comment for exactly which
 * methods), but the rebinding is the COORDINATOR's to do post-merge: this
 * module imports `AvailabilityModule` and `DocumentModule`, so binding
 * `BookingFacade` from inside either of those closes an import cycle, and
 * landing that across three parallel worktrees at once is asking for trouble.
 * Nothing is broken meanwhile — the placeholders read the same table this
 * module writes.
 */
@Module({
  imports: [PatientModule, DoctorModule, CatalogueModule, AvailabilityModule, DocumentModule, PaymentModule],
  controllers: [BookingController, BookingDoctorController, BookingAdminController],
  providers: [
    BookingRepository,
    { provide: BOOKING_PAYMENT_PORT, useExisting: PaymentFacade },
    BookingService,
    BookingSlotHoldService,
    BookingFacade,
  ],
  exports: [BookingFacade],
})
export class BookingModule {}
