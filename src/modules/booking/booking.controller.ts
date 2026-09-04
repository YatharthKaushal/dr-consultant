import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import {
  AttachDocumentDto,
  BookingQuoteQueryDto,
  CancelBookingDto,
  CreateBookingDto,
  CreateInstantBookingDto,
  ListBookingsQueryDto,
  RescheduleBookingDto,
  SaveIntakeAnswersDto,
} from './booking.dto';
import { toBookingView } from './booking.mapper';
import { BookingService } from './booking.service';
import { DEFAULT_BOOKING_PAGE_SIZE } from './booking.constants';

/**
 * *** ROUTE PREFIX: `/bookings`, NOT `/consultations`. READ THIS BEFORE
 * ADDING A ROUTE. ***
 *
 * `modules/document`'s `DocumentConsultationController` already owns
 * `@Controller('consultations')` — specifically `POST/GET :id/report-requests`,
 * `PATCH :id/report-requests/:reqId/cancel` and `GET :id/documents` — and its
 * header comment anticipates M-11 eventually taking routes under the same
 * prefix. This module deliberately does NOT do that. It takes `/bookings`
 * instead, so there is ZERO overlap: not one path, not one prefix segment,
 * shared with that controller.
 *
 * Why, when a literal collision was avoidable anyway (its routes all have a
 * literal third segment):
 *   1. `DocumentConsultationController` is class-level `@AccountType('doctor')`.
 *      A patient-facing `@Controller('consultations')` alongside it would put
 *      two controllers with DIFFERENT account-type guards on one prefix —
 *      which resolves correctly today but is a genuinely confusing thing to
 *      hand the next person, and a real trap the first time somebody adds
 *      `GET :id/documents` on the patient side.
 *   2. `docs/MODULES.md` names M-11's data "bookings"; `backend/README.md`
 *      §4 uses `booking.*` for every one of its own naming examples.
 *   3. It leaves `/consultations` free to mean exactly one thing — the
 *      doctor's clinical view of a consult — which is what M-15 will want.
 *
 * The consultation ID is unchanged and remains the spine (`consultations.id`,
 * SRS §5.2); only the URL under which booking exposes it differs.
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or body
 * param, and ownership failures return 404 rather than 403 so a patient
 * cannot probe for another patient's bookings.
 */
@Controller('bookings')
@AccountType('patient')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  /** FR-6.1 — Book Appointment on a scheduled slot. Returns the booking plus the checkout handles M-12 minted for it. */
  @Post()
  async create(@CurrentUser() auth: AuthContext, @Body() dto: CreateBookingDto) {
    const result = await this.bookings.createBooking(
      {
        patientId: auth.accountId,
        doctorId: dto.doctorId,
        specialtyId: dto.specialtyId,
        concernId: dto.concernId ?? null,
        scheduledStartAt: new Date(dto.scheduledStartAt),
        intakeAnswers: dto.intakeAnswers,
        discountCode: dto.discountCode ?? null,
      },
      { party: 'patient', accountId: auth.accountId },
    );

    return {
      booking: toBookingView(result.booking),
      payment: result.payment,
      isFirstConsultation: result.isFirstConsultation,
    };
  }

  /**
   * FR-6.1 — Consult Now. Creates the consultation row only; M-13 owns the
   * routing, acceptance window, timeout and re-routing that follow.
   */
  @Post('instant')
  async createInstant(@CurrentUser() auth: AuthContext, @Body() dto: CreateInstantBookingDto) {
    const row = await this.bookings.createInstantBooking(
      {
        patientId: auth.accountId,
        specialtyId: dto.specialtyId,
        concernId: dto.concernId ?? null,
        intakeAnswers: dto.intakeAnswers,
      },
      { party: 'patient', accountId: auth.accountId },
    );
    return toBookingView(row);
  }

  /** FR-6.5 — the Appointments screen. `scope` defaults to `upcoming`, which is what the home screen's next-appointment card reads (FR-3.2). */
  @Get()
  async list(@CurrentUser() auth: AuthContext, @Query() query: ListBookingsQueryDto) {
    const rows = await this.bookings.listForParty({
      party: 'patient',
      accountId: auth.accountId,
      scope: query.scope ?? 'upcoming',
      limit: query.limit ?? DEFAULT_BOOKING_PAGE_SIZE,
      offset: query.offset ?? 0,
    });
    return rows.map(toBookingView);
  }

  /**
   * The bill BEFORE committing to a slot, so a patient sees the total first.
   * `?code=` previews a discount/coupon code against this doctor's fee — this
   * NEVER reserves anything, only `POST /bookings` does. `patientId` always
   * comes from `@CurrentUser()`: this whole controller requires patient auth
   * (`@AccountType('patient')`, and every route needs a bearer token by
   * default), so there is no anonymous-browsing case where it would be absent.
   */
  @Get('quote/:doctorId')
  quote(
    @CurrentUser() auth: AuthContext,
    @Param('doctorId', createUuidValidationPipe('doctorId')) doctorId: string,
    @Query() query: BookingQuoteQueryDto,
  ) {
    return this.bookings.quoteForDoctor({ doctorId, patientId: auth.accountId, discountCode: query.code ?? null });
  }

  @Get(':id')
  async getOne(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    const row = await this.bookings.getOwnBooking(id, { party: 'patient', accountId: auth.accountId });
    return toBookingView(row);
  }

  /**
   * FR-6.4 — cancel within policy. The refund decision is made in the
   * service; see its deliberate FR-7.7 deviation note.
   *
   * `@HttpCode(OK)` because Nest answers POST with 201 by default, and
   * cancelling CREATES nothing — it transitions a booking that already
   * exists. Same for `no-show` and `attachments` below. `POST /bookings` and
   * `POST /bookings/:id/reschedule` keep the default 201, because those two
   * genuinely do create a new consultation row.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    const row = await this.bookings.cancel(id, { party: 'patient', accountId: auth.accountId }, dto.reason ?? null);
    return toBookingView(row);
  }

  /** FR-6.4 — reschedule. Returns the NEW booking; the old one is cancelled and carries `rescheduledFromConsultationId` on its replacement. */
  @Post(':id/reschedule')
  async reschedule(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: RescheduleBookingDto,
  ) {
    const row = await this.bookings.reschedule(id, { party: 'patient', accountId: auth.accountId }, new Date(dto.scheduledStartAt));
    return toBookingView(row);
  }

  /** FR-19.2 — the specialty's own intake form, answered. */
  @Patch(':id/intake')
  async saveIntake(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: SaveIntakeAnswersDto,
  ) {
    const row = await this.bookings.saveIntakeAnswers(id, { party: 'patient', accountId: auth.accountId }, dto.answers);
    return toBookingView(row);
  }

  /** FR-6.3 — the booking-side gate for attaching a report or photo. See `booking.service.ts#attachDocument` for who writes the durable link. */
  @Post(':id/attachments')
  @HttpCode(HttpStatus.OK)
  attachDocument(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AttachDocumentDto,
  ) {
    return this.bookings.attachDocument(id, { party: 'patient', accountId: auth.accountId }, dto.fileId);
  }
}
