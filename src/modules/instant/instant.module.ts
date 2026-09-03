import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { DoctorModule } from '../doctor/doctor.module';
import { PaymentModule } from '../payment/payment.module';
import { InstantAdminController } from './instant-admin.controller';
import { InstantConfigService } from './instant-config.service';
import { InstantDoctorController } from './instant-doctor.controller';
import { InstantEventBus } from './instant-event.bus';
import { InstantExpiryService } from './instant-expiry.service';
import { InstantPresenceService } from './instant-presence.service';
import { NotificationFacade } from '../notification/notification.facade';
import { NotificationModule } from '../notification/notification.module';
import { NOTIFICATION_PORT } from './instant.constants';
import { InstantController } from './instant.controller';
import { InstantFacade } from './instant.facade';
import { InstantRepository } from './instant.repository';
import { InstantService } from './instant.service';
import { UnavailableNotificationProvider } from './unavailable-notification.provider';

/**
 * M-13: Presence and Instant Consult.
 *
 * Not `@Global()` — like every other feature module here, nothing outside
 * resolves a DI token from this one; M-14 and M-15 will consume
 * `InstantFacade` via normal constructor injection after importing
 * `InstantModule`.
 *
 * `BookingModule`, `DoctorModule` and `PaymentModule` are real (non-global)
 * imports, and this module reads and writes NOTHING of theirs directly: it
 * owns exactly one table, `instant_consultancy`. `consultations` goes through
 * `BookingFacade`, `doctors` through `DoctorFacade`, and the accept-then-pay
 * order through `PaymentFacade`. `DATABASE`, `AuditService` and
 * `AppConfigService` are all `@Global()`, so they need no `imports` entry.
 *
 * ---------------------------------------------------------------------------
 * *** THE TWO FACADE METHODS THIS MODULE ADDED, AND WHY THEY ARE NOT DRIFT ***
 *
 * FR-10.2's flow writes two columns this module does not own:
 * `consultations.status` and `doctors.presence`/`blocked_by_consultation_id`.
 * Rather than reach into either table — the drift `booking.repository.ts`
 * documents in the other direction when it reads `payments` — both owners were
 * extended with a method that takes the LEGAL FROM-STATES as an argument:
 *
 *   `BookingFacade.transitionInstantConsultation`  M-13 owns the instant state
 *                                                  machine, M-11 owns the row
 *                                                  and the `FOR UPDATE`.
 *   `DoctorFacade.transitionPresence`              M-13 owns FR-10.4's seven
 *                                                  states, M-05 owns the row
 *                                                  and the `FOR UPDATE`.
 *
 * The rule lives with the module that owns the requirement; the lock lives
 * with the module that owns the table. Neither can be driven illegally from
 * the other side, and `tsc` checks the seam.
 *
 * ---------------------------------------------------------------------------
 * *** `NOTIFICATION_PORT` IS THE M-08 SEAM. ***
 *
 * *** REBOUND. *** Now bound to `NotificationFacade` (M-08 merged), which
 * satisfies `NotificationPort` structurally — no adapter, no cast — because
 * this module's local mirror in `instant-notification.contract.ts` and M-08's
 * own `NotificationContract` were frozen to the same shape before either was
 * written. The handover was the one line it was designed to be.
 *
 * `UnavailableNotificationProvider` stays in the tree, unbound: it is the null
 * object this module was built and tested against, and rebinding it here is
 * the hard kill-switch that takes push out of the instant path at the DI
 * level. It returns `{ queued: false, reason: 'provider_unavailable' }` and —
 * unlike every other null object in this codebase — NEVER THROWS, because
 * *** M-13 IS FULLY FUNCTIONAL WITHOUT M-08: *** SSE is the primary channel
 * for a doctor with the app open, which is the whole population Available Now
 * describes, and push is only the fallback for a backgrounded one.
 *
 * ---------------------------------------------------------------------------
 * *** SINGLE INSTANCE. THIS IS A DECISION, NOT AN OVERSIGHT. ***
 *
 * `InstantEventBus` fans SSE events out through an in-process RxJS `Subject`,
 * so a doctor connected to process A does not receive an event published by
 * process B. At launch scale the backend is one process (`docs/SRS.md` §6.4:
 * "handles launch-scale traffic on the client's cloud account and can scale by
 * adding resources"), so this is correct rather than merely convenient, and it
 * costs no broker, no reconnection protocol and no extra infrastructure to run.
 *
 * *** BEFORE A SECOND INSTANCE IS ADDED, `InstantEventBus` MUST BE REPLACED
 * WITH A POSTGRES `LISTEN`/`NOTIFY` IMPLEMENTATION. *** Postgres is already a
 * hard dependency, so that needs no new service, and it is the only file that
 * changes: everything else in this module publishes through
 * `InstantEventPublisher`, a one-method interface, and knows nothing about how
 * an event travels.
 *
 * It is written down here — rather than left implicit — because the failure
 * mode is silent. A doctor on the wrong instance simply never sees the request
 * appear; the acceptance window runs out and the sweep re-routes it to
 * somebody else. Nothing errors, no log line says "wrong process", and the
 * only visible symptom is an acceptance rate that quietly halves. The two
 * sweeps and every state transition ARE already multi-instance safe (`SELECT
 * ... FOR UPDATE` plus a guarded UPDATE inside every transaction), so the bus
 * is the single thing standing between this module and horizontal scaling.
 */
@Module({
  imports: [BookingModule, DoctorModule, PaymentModule, NotificationModule],
  controllers: [InstantController, InstantDoctorController, InstantAdminController],
  providers: [
    InstantRepository,
    InstantEventBus,
    { provide: NOTIFICATION_PORT, useExisting: NotificationFacade },
    InstantConfigService,
    InstantPresenceService,
    InstantService,
    InstantExpiryService,
    InstantFacade,
  ],
  exports: [InstantFacade],
})
export class InstantModule {}
