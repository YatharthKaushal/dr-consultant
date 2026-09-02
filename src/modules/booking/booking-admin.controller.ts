import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DEFAULT_BOOKING_PAGE_SIZE } from './booking.constants';
import { CancelBookingDto, ListAdminBookingsQueryDto } from './booking.dto';
import { toBookingView } from './booking.mapper';
import { BookingService } from './booking.service';
import { BookingSlotHoldService } from './booking-slot-hold.service';

/**
 * Admin appointment oversight (FR-18.3: "scheduled and instant consults,
 * cancellations, no-shows and rescheduling").
 *
 * Uses ONLY the two permissions that already exist and are already
 * role-bundled — `appointments.read` and `appointments.manage` ("Cancel,
 * reschedule or mark a consultation no-show"). No permission is added by this
 * module.
 *
 * Prefix `admin/bookings`, matching `doctor-admin.controller.ts`'s
 * `admin/doctors` and `concern-admin.controller.ts`'s `admin/concerns`.
 */
@Controller('admin/bookings')
@AccountType('admin')
export class BookingAdminController {
  constructor(
    private readonly bookings: BookingService,
    private readonly holds: BookingSlotHoldService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  async list(@Query() query: ListAdminBookingsQueryDto) {
    const rows = await this.bookings.listForAdmin({
      status: query.status,
      limit: query.limit ?? DEFAULT_BOOKING_PAGE_SIZE,
      offset: query.offset ?? 0,
    });
    return rows.map(toBookingView);
  }

  /**
   * THE ADMIN RESOLUTION QUEUE — the cases this module refused to decide on
   * its own, with the money still held: a late capture whose slot had been
   * taken, and a cancellation the refund policy could not price. See
   * `booking.constants.ts` for why it is backed by `audit_log` rather than a
   * table of its own.
   *
   * DECLARED BEFORE `:id`. Nest matches routes in declaration order, so a
   * literal segment that could also parse as a path param has to come first
   * or `GET /admin/bookings/resolution-queue` would be swallowed by
   * `GET /admin/bookings/:id` and fail its UUID pipe.
   */
  @Get('resolution-queue')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  listResolutionQueue(@Query() query: ListAdminBookingsQueryDto) {
    return this.bookings.listAdminResolutionQueue(query.limit ?? DEFAULT_BOOKING_PAGE_SIZE, query.offset ?? 0);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  async getOne(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    const row = await this.bookings.getOwnBooking(id, { party: 'admin', accountId: auth.accountId });
    return toBookingView(row);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  async cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    const row = await this.bookings.cancel(id, { party: 'admin', accountId: auth.accountId }, dto.reason ?? null);
    return toBookingView(row);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  async markNoShow(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    const row = await this.bookings.markNoShow(id, { party: 'admin', accountId: auth.accountId });
    return toBookingView(row);
  }

  /**
   * Runs one sweep pass on demand. The timer already does this every minute
   * (`booking-slot-hold.service.ts`); this exists so an operator can force a
   * pass after a gateway incident without waiting, and so the sweep is
   * exercisable in live E2E without sleeping through an interval.
   */
  @Post('sweep')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  sweep() {
    return this.holds.sweepExpiredHolds();
  }
}
