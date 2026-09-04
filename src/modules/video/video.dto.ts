import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_CONFIG_BOUNDS, VIDEO_CONFIG_KEYS } from './video.constants';

/**
 * `PUT /admin/video/config`. Every field optional; only the present ones are
 * written. Bounds mirror `VIDEO_CONFIG_BOUNDS` exactly, and the service
 * re-checks them — the DTO is the first line, not the rule
 * (`backend/README.md`: services hold the rules, not just the HTTP layer).
 *
 * There is deliberately no free-form `key`/`value` pair here. `app_config` is
 * one shared table across every module, and a generic writer on this endpoint
 * would let an admin holding `appointments.manage` reach
 * `search.crisis_keywords` or `payments.gst_pct` — the exact failure
 * `search-config.service.ts` names and every config service since has guarded
 * against. Two named fields make that unreachable before the service's own
 * ownership check even runs.
 */
export class UpdateVideoConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'joinTokenTtlSeconds must be a whole number of seconds.' })
  @Min(VIDEO_CONFIG_BOUNDS[VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS].min)
  @Max(VIDEO_CONFIG_BOUNDS[VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS].max)
  joinTokenTtlSeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'joinWindowMinutes must be a whole number of minutes.' })
  @Min(VIDEO_CONFIG_BOUNDS[VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES].min)
  @Max(VIDEO_CONFIG_BOUNDS[VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES].max)
  joinWindowMinutes?: number;
}
