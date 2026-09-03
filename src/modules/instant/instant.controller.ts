import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreateInstantConsultDto } from './instant.dto';
import { InstantService } from './instant.service';

/**
 * The patient's side of Available Now (FR-10.2).
 *
 * *** ROUTE PREFIX: `/instant-consults`, NOT `/bookings/instant`. ***
 * `booking.controller.ts` already owns `POST /bookings/instant`, which creates
 * the consultation row and nothing else — it is M-11's surface and its own
 * header is explicit that "M-13 owns the routing, acceptance window, timeout
 * and re-routing that follow". This controller is the one that actually runs
 * FR-10.2 end to end, so it takes a prefix of its own rather than shadowing a
 * route that already means something else. Zero overlap: not one path, not one
 * prefix segment, shared with `BookingController`.
 *
 * There are only three routes, and there is deliberately no cancel here:
 * cancelling a consultation is M-11's `POST /bookings/:id/cancel`, which
 * already accepts `awaiting_doctor` (`CANCELLABLE_STATUSES`) and already owns
 * the refund policy. A second cancel path in this module would be a second
 * place that decides what money comes back. The router notices on its next
 * pass — `routeNext` refuses any consultation that has left `awaiting_doctor`.
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or body
 * param, and ownership failures return 404 rather than 403 so a patient cannot
 * probe for another patient's consultation.
 */
@Controller('instant-consults')
@AccountType('patient')
export class InstantController {
  constructor(private readonly instant: InstantService) {}

  /**
   * FR-6.1's "Consult Now" / FR-10.2's request. Returns as soon as the first
   * doctor has been offered the request — the patient then watches
   * `GET :id` while the acceptance window runs.
   *
   * 201, the Nest default, and correctly so: this genuinely creates a
   * consultation row.
   */
  @Post()
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateInstantConsultDto) {
    return this.instant.requestInstantConsult({
      patientId: auth.accountId,
      specialtyId: dto.specialtyId,
      concernId: dto.concernId ?? null,
      intakeAnswers: dto.intakeAnswers,
    });
  }

  /**
   * The status poll: is anyone answering yet, and how long is left.
   *
   * A poll rather than a stream on this side on purpose. The doctor's channel
   * is long-lived and carries many events over a shift; a patient's request is
   * a single question with an answer inside a minute or two, and holding an
   * SSE connection open per waiting patient to say "not yet" four times buys
   * nothing that a poll does not.
   */
  @Get(':id')
  getStatus(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.instant.getStatus(id, auth.accountId);
  }
}
