import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { VideoConfigService } from './video-config.service';
import { UpdateVideoConfigDto } from './video.dto';
import { VideoService } from './video.service';

/**
 * Admin oversight of video consultations.
 *
 * *** THIS MODULE ADDS NO PERMISSION. *** It uses two that already exist and
 * are already role-bundled — the same call `booking-admin.controller.ts` and
 * `instant-admin.controller.ts` both make and document:
 *
 *   `appointments.read`    "View scheduled and instant consultations". Session
 *                          metadata IS the consultation, after the fact: who
 *                          joined, when, for how long, and why the connection
 *                          ended. `docs/erd.sql` names the read explicitly on
 *                          `disconnect_reason` — "read when adjudicating a
 *                          technical_issue complaint or a refund - it is the
 *                          only thing separating a hang-up from a dropped
 *                          network" — which is the same operator doing the same
 *                          job as FR-18.3's appointment management.
 *   `appointments.manage`  "Cancel, reschedule or mark a consultation
 *                          no-show". The state-changing half, and here that is
 *                          the two `video.*` config values, which change how
 *                          every consultation on the platform behaves. Exactly
 *                          the parallel `instant-admin.controller.ts` draws for
 *                          its own two windows.
 *
 * A new permission would have to be seeded, bundled into roles and explained;
 * these two already carry the exact semantics, and `permission.catalog.ts`'s
 * granularity rule ("not one per API endpoint") is explicit that this is the
 * right trade.
 *
 * *** THERE IS NO ADMIN JOIN TOKEN, AND THERE WILL NOT BE ONE. *** FR-8.5 says
 * tokens go "only to the assigned patient and doctor", and SRS 6.2 says a
 * doctor sees only assigned patients. An operator who could mint themselves
 * into a live consultation would be a silent third party to a clinical
 * conversation, which is precisely what "no routine video recording in this
 * release" is protecting against. Admins read what happened; they do not
 * attend.
 *
 * Prefix `admin/video`, matching `admin/bookings`, `admin/instant-consults`
 * and `admin/doctors`.
 */
@Controller('admin/video')
@AccountType('admin')
export class VideoAdminController {
  constructor(
    private readonly config: VideoConfigService,
    private readonly video: VideoService,
  ) {}

  /**
   * DECLARED BEFORE any `:param` route on this controller. Nest matches routes
   * in declaration order, so every literal segment that could also parse as a
   * path param has to come first — the trap `instant-admin.controller.ts` and
   * `booking-admin.controller.ts` both document. Nothing on this controller
   * currently collides, and the ordering is kept so that adding one later
   * cannot.
   */
  @Get('config')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  getConfig() {
    return this.config.getResolved();
  }

  /**
   * FR-8.5's token lifetime and the join window, both editable with no release
   * (SRS 6.6) — which is what `docs/erd.sql` says about these two keys in as
   * many words.
   *
   * Every change writes an `audit_log` row with the actor and the before/after
   * value. Widening the TTL widens the window in which a leaked token admits
   * somebody to a consultation, so this is access-control configuration and the
   * audit is not optional; see `video-config.service.ts`.
   */
  @Put('config')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_MANAGE)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdateVideoConfigDto) {
    return this.config.update(auth.accountId, dto);
  }

  /**
   * FR-8.6's session metadata for any consultation — the adjudication read.
   *
   * No ownership check, because an admin has no relationship to a consultation
   * to check; the permission IS the authorisation, and the read is the one
   * `docs/erd.sql` describes on `disconnect_reason`. It carries join and leave
   * times, connection counts, the derived duration and the no-show fact, and
   * NO clinical content whatsoever — this module holds none.
   */
  @Get('consultations/:id/session')
  @RequirePermission(PERMISSIONS.APPOINTMENTS_READ)
  getSession(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.video.getSession(id);
  }
}
