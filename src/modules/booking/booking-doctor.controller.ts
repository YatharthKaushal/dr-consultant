import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DEFAULT_BOOKING_PAGE_SIZE } from './booking.constants';
import { CancelBookingDto, ListBookingsQueryDto } from './booking.dto';
import { toBookingView } from './booking.mapper';
import { BookingService } from './booking.service';

/**
 * The doctor's own appointment list and the two actions they may take on a
 * consultation of theirs.
 *
 * Prefix is `doctors/me/bookings`, mirroring `availability.controller.ts`'s
 * `@Controller('doctors/me')` self-service convention — the doctor id is
 * never a path param, always `@CurrentUser()`. That also keeps this well
 * clear of `document`'s `@Controller('consultations')`, which is the OTHER
 * doctor-facing surface on a consultation (report requests and the patient's
 * document history); the two do not share a prefix segment.
 *
 * A doctor acting on a consultation that is not theirs gets 404, not 403 —
 * `booking.service.ts#canAct` requires `doctorId === auth.accountId`, and the
 * failure collapses into the same not-found every non-owner sees.
 */
@Controller('doctors/me/bookings')
@AccountType('doctor')
export class BookingDoctorController {
  constructor(private readonly bookings: BookingService) {}

  /** FR-9.1/FR-9.2 — the doctor's day: upcoming first, or the past list. */
  @Get()
  async list(@CurrentUser() auth: AuthContext, @Query() query: ListBookingsQueryDto) {
    const rows = await this.bookings.listForParty({
      party: 'doctor',
      accountId: auth.accountId,
      scope: query.scope ?? 'upcoming',
      limit: query.limit ?? DEFAULT_BOOKING_PAGE_SIZE,
      offset: query.offset ?? 0,
    });
    return rows.map(toBookingView);
  }

  @Get(':id')
  async getOne(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    const row = await this.bookings.getOwnBooking(id, { party: 'doctor', accountId: auth.accountId });
    return toBookingView(row);
  }

  /** A doctor cancelling their own consultation. The refund is NOT priced automatically for this case — see `booking-policy.engine.ts`'s `'not_cancelled_by_patient'`. `@HttpCode(OK)` because nothing is created; see `booking.controller.ts#cancel`. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    const row = await this.bookings.cancel(id, { party: 'doctor', accountId: auth.accountId }, dto.reason ?? null);
    return toBookingView(row);
  }

  /** M-11's "No-show marking". Frees the slot, since `no_show` is not an occupying status. */
  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  async markNoShow(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    const row = await this.bookings.markNoShow(id, { party: 'doctor', accountId: auth.accountId });
    return toBookingView(row);
  }
}
