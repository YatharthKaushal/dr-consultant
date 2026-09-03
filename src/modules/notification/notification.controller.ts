import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { ListNotificationsQueryDto, RegisterDeviceDto } from './notification.dto';
import { toNotificationViews } from './notification.mapper';
import { NotificationService } from './notification.service';
import { NOTIFICATION_LIST_DEFAULT_LIMIT } from './notification.constants';

/**
 * The in-app inbox — FR-16.1's "in-app reminders" — plus device-token
 * registration.
 *
 * *** EVERY ROUTE IS SCOPED TO THE CALLER BY `@CurrentUser()`, NEVER BY A
 * PARAMETER. *** There is no `?patientId=` and no `/patients/:id/
 * notifications`; the audience is derived from the bearer token and pushed
 * into the WHERE clause (`notification.repository.ts`). FR-1.4: "a patient
 * can read only their own records."
 *
 * No class-level `@AccountType`: all three account types have an inbox. A
 * patient and a doctor read theirs in the app, and an admin reads theirs in
 * the panel — which is exactly what `notifications.admin_id`'s schema comment
 * means by "read in the panel". The two device routes narrow to
 * patient/doctor, because an admin has no push token to register.
 *
 * No logic here — parse, delegate. Every rule lives in
 * `notification.service.ts`.
 */
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** The caller's own notifications, newest first. `?unreadOnly=true` is the inbox's unread tab. */
  @Get()
  async listOwn(@CurrentUser() auth: AuthContext, @Query() query: ListNotificationsQueryDto) {
    const rows = await this.notifications.listOwn(auth, {
      unreadOnly: query.unreadOnly,
      limit: query.limit ?? NOTIFICATION_LIST_DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    });
    return toNotificationViews(rows);
  }

  /** The badge count. Its own endpoint so the app does not have to page the whole inbox to draw a number. */
  @Get('unread-count')
  countUnread(@CurrentUser() auth: AuthContext) {
    return this.notifications.countUnread(auth);
  }

  /**
   * `notifications.id` is `bigserial`, so the path parameter is an integer,
   * not a uuid — `createUuidValidationPipe` would be wrong here.
   * `ParseIntPipe` answers 400 on anything else before the service is
   * reached.
   */
  @Post(':id/read')
  markRead(@CurrentUser() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.notifications.markRead(auth, id);
  }

  /** "Mark all read" on the inbox screen. Reports how many rows actually moved. */
  @Post('read-all')
  markAllRead(@CurrentUser() auth: AuthContext) {
    return this.notifications.markAllRead(auth);
  }

  /**
   * Stores the FCM registration token the app obtained at start-up.
   *
   * Patients and doctors only: `notifications.admin_id`'s schema comment says
   * admins "have no push token", and the panel has no store listing and no
   * Firebase project. The service refuses an admin explicitly rather than
   * relying on this decorator alone — services hold the rules.
   */
  @Post('device')
  @AccountType('patient', 'doctor')
  registerDevice(@CurrentUser() auth: AuthContext, @Body() dto: RegisterDeviceDto) {
    return this.notifications.registerDevice(auth, { pushToken: dto.pushToken, deviceId: dto.deviceId });
  }

  /** Sign-out, or "stop sending me push". Clears the token and the device id together. */
  @Delete('device')
  @AccountType('patient', 'doctor')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregisterDevice(@CurrentUser() auth: AuthContext): Promise<void> {
    await this.notifications.unregisterDevice(auth);
  }
}
