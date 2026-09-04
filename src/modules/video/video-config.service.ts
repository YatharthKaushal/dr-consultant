import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  VIDEO_AUDIT_ENTITY_TYPES,
  VIDEO_CONFIG_BOUNDS,
  VIDEO_CONFIG_FALLBACKS,
  VIDEO_CONFIG_KEYS,
  VIDEO_CONFIG_KEY_LIST,
  VIDEO_ERROR_CODES,
  type VideoConfigKey,
} from './video.constants';
import { VideoRepository } from './video.repository';

/** The resolved `video.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedVideoConfig {
  /** FR-8.5's "short-lived" join token, in seconds. */
  joinTokenTtlSeconds: number;
  /** How early before `scheduled_start_at` a token may be minted at all. */
  joinWindowMinutes: number;
}

/** A `PUT /admin/video/config` body: every field optional, only the present ones are written. */
export interface VideoConfigUpdate {
  joinTokenTtlSeconds?: number;
  joinWindowMinutes?: number;
}

/**
 * The READ AND WRITE path for M-14's own `app_config` keys.
 *
 * Modelled line-for-line on `payment-config.service.ts` and
 * `instant-config.service.ts`, which carry the same three responsibilities a
 * bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `VIDEO_CONFIG_KEY_LIST`.
 *      `app_config` is one shared table, and one shared table must not become
 *      one shared permission — `search-config.service.ts` states the rule first
 *      and both later modules mirror it. An admin holding `appointments.manage`
 *      must not be able to reach `search.crisis_keywords` and switch off the
 *      safety guardrail, or `payments.gst_pct` and change what every patient is
 *      billed.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write is
 *      not caught by the database. A TTL of `"five minutes"`, `-5` or `1e9`
 *      would not fail here — it would fail at the next join, or worse, not fail
 *      at all: `1e9` seconds is a token valid for thirty years, which turns
 *      FR-8.5's "short-lived" into a standing key to a clinical conversation.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, then calls `AppConfigService.invalidate(key)`.
 *      Without that last call the 30s memo keeps minting on the previous TTL,
 *      and an operator shortening it during an incident would watch nothing
 *      happen.
 *
 * *** THE TTL IS AN ACCESS-CONTROL PARAMETER, SO THE AUDIT IS NOT OPTIONAL. ***
 * `docs/erd.sql` on `app_config`: "Every change is an audit_log row carrying the
 * actor and the before/after value, so a config change is reversible without a
 * versions table." Widening the token TTL widens the window in which a leaked
 * token admits somebody to a consultation, and "who widened it, when, and from
 * what" is the first question after an incident.
 *
 * The hot path — every token mint — reads through `AppConfigService` (memoized
 * 30s) rather than `getResolved` here. This service's own reads are for the
 * admin screen and the write path.
 */
@Injectable()
export class VideoConfigService {
  constructor(
    private readonly repo: VideoRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** FR-8.5's token lifetime, in seconds. The hot-path read — memoized 30s by `AppConfigService`, with the compiled-in fallback on a missing or malformed row. */
  async getJoinTokenTtlSeconds(): Promise<number> {
    return this.readBoundedNumber(
      VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS,
      VIDEO_CONFIG_FALLBACKS.JOIN_TOKEN_TTL_SECONDS,
    );
  }

  /** How early before `scheduled_start_at` a token may be minted. Same read discipline. */
  async getJoinWindowMinutes(): Promise<number> {
    return this.readBoundedNumber(
      VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES,
      VIDEO_CONFIG_FALLBACKS.JOIN_WINDOW_MINUTES,
    );
  }

  /** Both values, resolved. One query for the set, not one per key — for the admin screen. */
  async getResolved(): Promise<ResolvedVideoConfig> {
    const stored = await this.repo.findConfigByKeys(VIDEO_CONFIG_KEY_LIST);
    return {
      joinTokenTtlSeconds: this.coerce(
        VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS,
        stored.get(VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS),
        VIDEO_CONFIG_FALLBACKS.JOIN_TOKEN_TTL_SECONDS,
      ),
      joinWindowMinutes: this.coerce(
        VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES,
        stored.get(VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES),
        VIDEO_CONFIG_FALLBACKS.JOIN_WINDOW_MINUTES,
      ),
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing and
   * audits nothing — no misleading audit entry, the same discipline
   * `payment-config.service.ts`, `instant-config.service.ts` and
   * `search-config.service.ts` use.
   */
  async update(actingAdminId: string, update: VideoConfigUpdate): Promise<ResolvedVideoConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) {
      return this.getResolved();
    }

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    const before = await this.repo.findConfigByKeys(changes.map((change) => change.key));

    for (const change of changes) {
      await this.repo.upsertConfig(change.key, change.value);
      // *** Without this the 30s memo keeps minting on the previous TTL. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: VIDEO_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key, and
        // an auditor asking who last widened the token TTL should not have to
        // know a uuid.
        entityId: change.key,
        metadata: { before: before.get(change.key) ?? null, after: change.value },
      });
    }

    return this.getResolved();
  }

  private toKeyedChanges(update: VideoConfigUpdate): Array<{ key: VideoConfigKey; value: unknown }> {
    const changes: Array<{ key: VideoConfigKey; value: unknown }> = [];
    if (update.joinTokenTtlSeconds !== undefined) {
      changes.push({ key: VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS, value: update.joinTokenTtlSeconds });
    }
    if (update.joinWindowMinutes !== undefined) {
      changes.push({ key: VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES, value: update.joinWindowMinutes });
    }
    return changes;
  }

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(VIDEO_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: VIDEO_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a video configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: VideoConfigKey, value: unknown): void {
    const bounds = VIDEO_CONFIG_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.invalid(`${key} must be a number.`);
    }
    // Both values are whole units: a TTL is seconds on a JWT `exp` claim and a
    // window is minutes on a clock, and `30.5` in a panel is a typo.
    if (!Number.isInteger(value)) {
      throw this.invalid(`${key} must be a whole number.`);
    }
    if (value < bounds.min || value > bounds.max) {
      throw this.invalid(`${key} must be between ${bounds.min} and ${bounds.max}.`);
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: VIDEO_ERROR_CODES.CONFIG_INVALID, message });
  }

  /**
   * Tolerant hot-path reader. A missing, malformed or out-of-range row degrades
   * to the compiled-in default rather than throwing.
   *
   * *** THIS IS THE SAFE DIRECTION AND IT IS WORTH BEING EXPLICIT ABOUT WHY. ***
   * For the instant module the argument was availability — "routing at the
   * documented default is a defensible outcome, and refusing every instant
   * request because one config row is malformed is not." Here the argument is
   * stronger, because falling back is also the SECURE choice: the compiled-in
   * TTL is five minutes, and every out-of-bounds value this rejects is one that
   * would have made the token longer-lived than the bound allows. A malformed
   * row cannot widen the window; it can only return it to the default.
   */
  private async readBoundedNumber(key: VideoConfigKey, fallback: number): Promise<number> {
    const value = await this.appConfig.getNumber(key, fallback);
    return this.coerce(key, value, fallback);
  }

  private coerce(key: VideoConfigKey, value: unknown, fallback: number): number {
    const bounds = VIDEO_CONFIG_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (!Number.isInteger(value)) return fallback;
    if (value < bounds.min || value > bounds.max) return fallback;
    return value;
  }
}
