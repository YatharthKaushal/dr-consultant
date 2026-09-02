import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { SearchConfigRepository } from './search-config.repository';
import {
  SEARCH_AUDIT_ENTITY_TYPES,
  SEARCH_CONFIG_FALLBACKS,
  SEARCH_CONFIG_KEYS,
  SEARCH_CONFIG_KEY_LIST,
  SEARCH_ERROR_CODES,
  type SearchConfigKey,
} from './search.constants';

/** The resolved `search.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedSearchConfig {
  crisisKeywords: string[];
  crisisGuidance: { message: string; helplines: Array<{ name: string; phone: string; availability?: string }> };
  popularSearches: Array<{ label: string; query: string }>;
  aiEnabled: boolean;
  maxResults: number;
  rateLimitPerHour: number;
}

/** A `PUT /admin/search/config` body: every field optional, only the present ones are written. */
export interface SearchConfigUpdate {
  crisisKeywords?: string[];
  crisisGuidance?: { message: string; helplines: Array<{ name: string; phone: string; availability?: string }> };
  popularSearches?: Array<{ label: string; query: string }>;
  aiEnabled?: boolean;
  maxResults?: number;
  rateLimitPerHour?: number;
}

const MAX_RESULTS_BOUNDS = { min: 1, max: 100 };
const RATE_LIMIT_BOUNDS = { min: 1, max: 1000 };
const MAX_CRISIS_KEYWORDS = 500;
const MAX_POPULAR_SEARCHES = 30;
const MAX_HELPLINES = 10;

/**
 * The READ AND WRITE path for M-09's own `app_config` keys — FR-5.7's "the
 * mapping, synonym list and crisis keyword list are editable from the admin
 * panel without an app release", and SRS 5.2's "configuration values,
 * including... crisis keywords, mapping rules... live in data, not code".
 *
 * Three things this service is responsible for that a bare config write is
 * not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `SEARCH_CONFIG_KEY_LIST`. An
 *      admin holding `SEARCH_MANAGE_MAPPING` must not be able to reach
 *      `payments.gst_rate` through this endpoint because both happen to live
 *      in one table.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write
 *      is not caught by the database. Crisis keywords in particular are
 *      re-checked here as well as in the DTO — an empty array would silently
 *      disable the safety guardrail, so it is refused outright.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER (which is why `app_config` needs no version
 *      table of its own — see its schema comment), and then calls
 *      `AppConfigService.invalidate(key)`. Without that last call the 30s
 *      memo would keep serving the old value, and an admin turning the AI
 *      off or fixing a crisis keyword would watch nothing happen.
 */
@Injectable()
export class SearchConfigService {
  constructor(
    private readonly repo: SearchConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Every `search.*` value, resolved. One query for the whole set, not one per key. */
  async getResolved(): Promise<ResolvedSearchConfig> {
    const stored = await this.repo.findByKeys(SEARCH_CONFIG_KEY_LIST);
    return {
      crisisKeywords: this.readStringArray(stored.get(SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS), SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS),
      crisisGuidance: this.readCrisisGuidance(stored.get(SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE)),
      popularSearches: this.readPopularSearches(stored.get(SEARCH_CONFIG_KEYS.POPULAR_SEARCHES)),
      aiEnabled: stored.get(SEARCH_CONFIG_KEYS.AI_ENABLED) === undefined
        ? SEARCH_CONFIG_FALLBACKS.AI_ENABLED
        : stored.get(SEARCH_CONFIG_KEYS.AI_ENABLED) === true,
      maxResults: this.readNumber(stored.get(SEARCH_CONFIG_KEYS.MAX_RESULTS), SEARCH_CONFIG_FALLBACKS.MAX_RESULTS),
      rateLimitPerHour: this.readNumber(stored.get(SEARCH_CONFIG_KEYS.RATE_LIMIT_PER_HOUR), SEARCH_CONFIG_FALLBACKS.RATE_LIMIT_PER_HOUR),
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call (nothing
   * defined) writes nothing and audits nothing — no misleading audit entry,
   * the same discipline `doctor.service.ts#adminUpdateProfileFields` uses.
   */
  async update(actingAdminId: string, update: SearchConfigUpdate): Promise<ResolvedSearchConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) {
      return this.getResolved();
    }

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    const before = await this.repo.findByKeys(changes.map((change) => change.key));

    for (const change of changes) {
      await this.repo.upsert(change.key, change.value);
      // *** Without this the 30s memo keeps serving the previous value. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: SEARCH_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key,
        // and an auditor searching for who last changed the crisis keywords
        // should not have to know a uuid.
        entityId: change.key,
        metadata: { before: before.get(change.key) ?? null, after: change.value },
      });
    }

    return this.getResolved();
  }

  private toKeyedChanges(update: SearchConfigUpdate): Array<{ key: SearchConfigKey; value: unknown }> {
    const changes: Array<{ key: SearchConfigKey; value: unknown }> = [];
    if (update.crisisKeywords !== undefined) changes.push({ key: SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS, value: update.crisisKeywords });
    if (update.crisisGuidance !== undefined) changes.push({ key: SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE, value: update.crisisGuidance });
    if (update.popularSearches !== undefined) changes.push({ key: SEARCH_CONFIG_KEYS.POPULAR_SEARCHES, value: update.popularSearches });
    if (update.aiEnabled !== undefined) changes.push({ key: SEARCH_CONFIG_KEYS.AI_ENABLED, value: update.aiEnabled });
    if (update.maxResults !== undefined) changes.push({ key: SEARCH_CONFIG_KEYS.MAX_RESULTS, value: update.maxResults });
    if (update.rateLimitPerHour !== undefined) {
      changes.push({ key: SEARCH_CONFIG_KEYS.RATE_LIMIT_PER_HOUR, value: update.rateLimitPerHour });
    }
    return changes;
  }

  /** Structurally unreachable from the controller (the DTO has no free-form key), and enforced anyway — this is the guard that keeps one shared table from becoming a shared permission. */
  private assertOwnedKey(key: string): void {
    if (!(SEARCH_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: SEARCH_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a search configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: SearchConfigKey, value: unknown): void {
    switch (key) {
      case SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS: {
        const keywords = value as unknown[];
        if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > MAX_CRISIS_KEYWORDS) {
          throw this.invalid('crisisKeywords must be a non-empty array of at most 500 phrases.');
        }
        if (!keywords.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
          throw this.invalid('crisisKeywords must contain only non-empty strings.');
        }
        return;
      }
      case SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE: {
        const guidance = value as { message?: unknown; helplines?: unknown };
        if (typeof guidance !== 'object' || guidance === null || typeof guidance.message !== 'string' || guidance.message.trim().length === 0) {
          throw this.invalid('crisisGuidance.message must be a non-empty string.');
        }
        if (!Array.isArray(guidance.helplines) || guidance.helplines.length === 0 || guidance.helplines.length > MAX_HELPLINES) {
          throw this.invalid('crisisGuidance.helplines must be a non-empty array of at most 10 entries.');
        }
        return;
      }
      case SEARCH_CONFIG_KEYS.POPULAR_SEARCHES: {
        const items = value as unknown[];
        if (!Array.isArray(items) || items.length > MAX_POPULAR_SEARCHES) {
          throw this.invalid('popularSearches must be an array of at most 30 entries.');
        }
        return;
      }
      case SEARCH_CONFIG_KEYS.AI_ENABLED: {
        if (typeof value !== 'boolean') throw this.invalid('aiEnabled must be a boolean.');
        return;
      }
      case SEARCH_CONFIG_KEYS.MAX_RESULTS:
        this.assertIntegerInBounds('maxResults', value, MAX_RESULTS_BOUNDS);
        return;
      case SEARCH_CONFIG_KEYS.RATE_LIMIT_PER_HOUR:
        this.assertIntegerInBounds('rateLimitPerHour', value, RATE_LIMIT_BOUNDS);
        return;
    }
  }

  private assertIntegerInBounds(field: string, value: unknown, bounds: { min: number; max: number }): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw this.invalid(`${field} must be an integer between ${bounds.min} and ${bounds.max}.`);
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: SEARCH_ERROR_CODES.CONFIG_INVALID, message });
  }

  /* ---------------------------------------------------------------------- */
  /* Tolerant readers — `app_config.value` is untyped jsonb                  */
  /* ---------------------------------------------------------------------- */

  private readStringArray(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback];
    const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return strings.length > 0 ? strings : [...fallback];
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private readCrisisGuidance(value: unknown): ResolvedSearchConfig['crisisGuidance'] {
    if (typeof value !== 'object' || value === null) return SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE;
    const candidate = value as { message?: unknown; helplines?: unknown };
    if (typeof candidate.message !== 'string' || candidate.message.trim().length === 0) {
      return SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE;
    }
    const helplines = Array.isArray(candidate.helplines)
      ? candidate.helplines.filter(
          (entry): entry is { name: string; phone: string; availability?: string } =>
            typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' && typeof (entry as { phone?: unknown }).phone === 'string',
        )
      : [];
    // A guidance block with no reachable helpline is worse than the
    // compiled-in one — this is the one config read where degrading to the
    // default is the safe outcome, not the lazy one.
    if (helplines.length === 0) return SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE;
    return { message: candidate.message, helplines };
  }

  /**
   * Accepts BOTH `[{ label, query }]` and a bare `["low mood"]`, coercing
   * the latter. Admins edit this by hand and the simpler shape is the one
   * they will reach for; refusing it would be pedantry with a safety cost of
   * zero and a support cost of real.
   */
  private readPopularSearches(value: unknown): Array<{ label: string; query: string }> {
    if (!Array.isArray(value)) return [...SEARCH_CONFIG_FALLBACKS.POPULAR_SEARCHES];
    const items = value.flatMap((entry) => {
      if (typeof entry === 'string' && entry.trim().length > 0) return [{ label: entry, query: entry }];
      if (typeof entry === 'object' && entry !== null) {
        const candidate = entry as { label?: unknown; query?: unknown };
        const query = typeof candidate.query === 'string' ? candidate.query : undefined;
        const label = typeof candidate.label === 'string' ? candidate.label : query;
        if (query && label) return [{ label, query }];
      }
      return [];
    });
    return items.length > 0 ? items : [...SEARCH_CONFIG_FALLBACKS.POPULAR_SEARCHES];
  }
}
