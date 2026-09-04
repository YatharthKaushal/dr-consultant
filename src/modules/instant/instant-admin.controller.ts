import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { InstantConfigService } from './instant-config.service';
import { InstantExpiryService } from './instant-expiry.service';
import { InstantPresenceService } from './instant-presence.service';
import { DEFAULT_INSTANT_PAGE_SIZE } from './instant.constants';
import { AdminSetPresenceDto, InstantMetricsQueryDto, ListInstantRequestsQueryDto, UpdateInstantConfigDto } from './instant.dto';
import { toInstantRequestView } from './instant.mapper';
import { InstantRepository } from './instant.repository';
import { InstantService } from './instant.service';

/**
 * Admin oversight of instant consults (FR-18.3: "scheduled and instant
 * consults, cancellations, no-shows and rescheduling").
 *
 * *** THIS MODULE ADDS NO PERMISSION. *** It uses only four that already exist
 * and are already role-bundled, which is the same call
 * `booking-admin.controller.ts` makes and documents:
 *
 *   `appointments.read`      "View scheduled and instant consultations" — the
 *                            catalog's own description names instant consults
 *                            explicitly, so the routing history and the
 *                            configured windows are exactly what it covers.
 *   `appointments.manage`    "Cancel, reschedule or mark a consultation
 *                            no-show" — the state-changing half: forcing a
 *                            sweep pass, and editing the two windows, which is
 *                            a change to how every live consultation behaves.
 *   `doctors.manage_listing` "Toggle whether a doctor is listed/bookable and
 *                            allows instant consult" — presence is the live
 *                            form of exactly that fact, so an operator
 *                            forcing a doctor offline or out of the routing
 *                            pool is doing the same job with a shorter half
 *                            life.
 *   `governance.read_quality` "View the quality dashboard and doctor
 *                            reliability metrics" — FR-18.6's acceptance rate
 *                            is computed off `instant_consultancy` (`docs/erd
 *                            .sql`: "Also the source for the FR-18.6
 *                            acceptance-rate metric"), so the routing-health
 *                            figures belong to the same permission that reads
 *                            the rest of it.
 *
 * A new permission would have to be seeded, bundled into roles and explained;
 * these four already carry the exact semantics, and `permission.catalog.ts`'s
 * granularity rule ("not one per API endpoint") is explicit that this is the
 * right trade.
 *
 * Prefix `admin/instant-consults`, matching `admin/bookings`, `admin/doctors`
 * and `admin/concerns`.
 */
@Controller('admin/instant-consults')
@AccountType('admin')
export class InstantAdminController {
  constructor(
    private readonly instant: InstantService,
    private readonly repo: InstantRepository,
    private readonly presence: InstantPresenceService,
    private readonly expiry: InstantExpiryService,
    private readonly config: InstantConfigService,
  ) {}

  /**
   * DECLARED BEFORE `:consultationId`. Nest matches routes in declaration
   * order, so every literal segment that could also parse as a path param has
   * to come first — otherwise `GET /admin/instant-consults/config` is
   * swallowed by `GET /admin/instant-consults/:consultationId` and fails its
   * UUID pipe. The same trap `booking-admin.controller.ts` documents for its
   * `resolution-queue` route.
   */
  @Get('config')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  getConfig() {
    return this.config.getResolved();
  }

  /** FR-10.6's acceptance window and FR-10.2's payment window, both editable with no release (SRS 6.6). */
  @Put('config')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdateInstantConfigDto) {
    return this.config.update(auth.accountId, {
      acceptanceWindowSeconds: dto.acceptanceWindowSeconds,
      paymentWindowSeconds: dto.paymentWindowSeconds,
    });
  }

  /** FR-18.6's routing health: how many offers were made, accepted, declined and timed out in the window. */
  @Get('metrics')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUALITY)
  async metrics(@Query() query: InstantMetricsQueryDto) {
    const sinceHours = query.sinceHours ?? 24;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1_000);
    const counts = await this.repo.getRoutingMetrics(since);
    return {
      sinceHours,
      ...counts,
      // `null` rather than 0 when nothing was offered — "no data yet" is a
      // different fact from "nobody accepted", the same choice
      // `doctor-reliability.service.ts` makes for its three rates.
      acceptanceRate: counts.offered === 0 ? null : counts.accepted / counts.offered,
    };
  }

  /**
   * Runs both sweep passes on demand. The timers already do this
   * (`instant-expiry.service.ts`); this exists so an operator can force a pass
   * after an incident without waiting, and so both sweeps are exercisable in
   * live E2E without sleeping through an interval — the same reasoning
   * `POST /admin/bookings/sweep` gives.
   */
  @Post('sweep')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  async sweep() {
    return {
      acceptanceWindow: await this.expiry.sweepExpiredOffers(),
      strandedRequests: await this.expiry.sweepStrandedRequests(),
      paymentWindow: await this.expiry.sweepUnpaidAcceptedRequests(),
    };
  }

  /** The recent routing log across every consultation, newest first. */
  @Get()
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  async list(@Query() query: ListInstantRequestsQueryDto) {
    const rows = await this.repo.listRecentAttempts({
      outcome: query.outcome,
      limit: query.limit ?? DEFAULT_INSTANT_PAGE_SIZE,
      offset: query.offset ?? 0,
    });
    return rows.map(toInstantRequestView);
  }

  /** One doctor's live presence — "why is this doctor not getting requests", answered in one read. */
  @Get('doctors/:doctorId/presence')
  @RequirePermission(PERMISSIONS.DOCTORS_MANAGE_LISTING)
  getDoctorPresence(@Param('doctorId', createUuidValidationPipe('doctorId')) doctorId: string) {
    return this.presence.getOwnPresence(doctorId);
  }

  /**
   * THE OPERATOR OVERRIDE: force a doctor offline, paused or scheduled-only.
   *
   * Restricted to the same `SELF_SETTABLE_PRESENCE` set a doctor gets — an
   * admin does not get to assert work in flight either, and in particular
   * cannot put a doctor into or out of `completing_notes`, because that would
   * be an admin signing off clinical documentation. *** IT CANNOT CLEAR THE
   * COMPLETION GATE EITHER: *** `requireNotGated` applies to this path exactly
   * as it does to the doctor's own, so an admin forcing a gated doctor to
   * `available_now` is refused with `COMPLETION_GATE_ACTIVE`.
   */
  @Put('doctors/:doctorId/presence')
  @RequirePermission(PERMISSIONS.DOCTORS_MANAGE_LISTING)
  async setDoctorPresence(
    @CurrentUser() auth: AuthContext,
    @Param('doctorId', createUuidValidationPipe('doctorId')) doctorId: string,
    @Body() dto: AdminSetPresenceDto,
  ) {
    const result = await this.presence.transition({
      doctorId,
      to: dto.presence,
      actor: { actorType: 'admin', actorId: auth.accountId },
      reason: 'admin_override',
    });
    this.presence.throwForRefusal(result);
    return this.presence.getOwnPresence(doctorId);
  }

  /** One request's full routing history — every doctor tried, in order, with each outcome. */
  @Get(':consultationId')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  getOne(@Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string) {
    return this.instant.getInstantConsult(consultationId);
  }
}
