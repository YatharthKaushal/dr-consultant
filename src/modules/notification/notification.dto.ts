import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { NOTIFICATION_LIST_MAX_LIMIT } from './notification.constants';

/** `GET /notifications`. Identity is never a parameter — it comes from the bearer token (`@CurrentUser()`). */
export class ListNotificationsQueryDto {
  /** The inbox's "unread" tab. `read_at IS NULL` is what unread means — there is no read value in `notification_status`. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

/**
 * `POST /notifications/device`.
 *
 * `pushToken` is `patients.push_token` / `doctors.push_token`, both `text`,
 * so the ceiling here is a sanity bound rather than a column limit — an FCM
 * registration token is around 160 characters today and Google has grown it
 * before, so the bound is generous on purpose.
 *
 * `deviceId` matches its column exactly (`varchar(120)`), and is the field
 * FR-1.8 names.
 */
export class RegisterDeviceDto {
  @IsString()
  @Length(16, 1024)
  pushToken!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  deviceId?: string;
}
