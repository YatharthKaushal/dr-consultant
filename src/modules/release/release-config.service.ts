import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { PUSH_APP_KEYS, type PushAppKey } from '../notification/notification-push.types';
import { ReleaseConfigRepository } from './release-config.repository';
import { RELEASE_AUDIT_ENTITY_TYPES, RELEASE_CONFIG_KEYS, RELEASE_DEFAULT_ENTRY, RELEASE_ERROR_CODES, RELEASE_PLATFORMS } from './release.constants';
import { isValidVersion } from './release-version.util';
import type { ReleasePolicy, ReleasePolicyEntry } from './release.types';

/**
 * The READ AND WRITE path for `release.policy` — modelled on `pricing-
 * config.service.ts`/`payment-config.service.ts`: key ownership, shape
 * validation, before/after audit inside a transaction, then
 * `AppConfigService.invalidate(key)`.
 *
 * Unlike pricing/payment config this is not financial, so a malformed or
 * missing row degrades to `RELEASE_DEFAULT_ENTRY` (never blocks a login)
 * rather than failing the request — the same "fail open" posture
 * `release.constants.ts#RELEASE_DEFAULT_ENTRY`'s own comment states.
 */
@Injectable()
export class ReleaseConfigService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: ReleaseConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The full policy, every `{app}.{platform}` cell present — missing/malformed cells fall back individually, not the whole document. */
  async getResolved(): Promise<ReleasePolicy> {
    const raw = await this.appConfig.getJson<unknown>(RELEASE_CONFIG_KEYS.POLICY, undefined);
    return this.resolve(raw);
  }

  /** Reads the row directly (not the 30s memo) — the admin screen must show what is actually stored, not a stale cache. */
  async getStored(): Promise<ReleasePolicy> {
    const raw = await this.repo.find(RELEASE_CONFIG_KEYS.POLICY);
    return this.resolve(raw);
  }

  /**
   * Full-document replace: the admin screen edits and PUTs back the whole
   * policy, same shape `pricing-config.service.ts#update`'s
   * `PricingConfigUpdate` avoids for its own catalogue field — here there is
   * exactly one key, so a partial-field update would need per-cell PATCH
   * semantics this feature has no need for yet.
   */
  async update(actingAdminId: string, policyInput: unknown): Promise<ReleasePolicy> {
    this.assertValidPolicy(policyInput);
    const policy = policyInput;

    await this.db.transaction(async (tx) => {
      const before = await this.repo.find(RELEASE_CONFIG_KEYS.POLICY, tx);
      await this.repo.upsert(RELEASE_CONFIG_KEYS.POLICY, policy, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: RELEASE_AUDIT_ENTITY_TYPES.CONFIG,
          entityId: RELEASE_CONFIG_KEYS.POLICY,
          metadata: { before: before ?? null, after: policy },
        },
        tx,
      );
    });

    this.appConfig.invalidate(RELEASE_CONFIG_KEYS.POLICY);
    return this.getResolved();
  }

  /* ---------------------------------------------------------------------- */

  private resolve(raw: unknown): ReleasePolicy {
    const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const policy = {} as ReleasePolicy;
    for (const app of PUSH_APP_KEYS) {
      policy[app] = {} as ReleasePolicy[PushAppKey];
      const appEntry = typeof source[app] === 'object' && source[app] !== null ? (source[app] as Record<string, unknown>) : {};
      for (const platform of RELEASE_PLATFORMS) {
        policy[app][platform] = this.resolveEntry(appEntry[platform]);
      }
    }
    return policy;
  }

  private resolveEntry(value: unknown): ReleasePolicyEntry {
    if (typeof value !== 'object' || value === null) return { ...RELEASE_DEFAULT_ENTRY };
    const entry = value as Partial<ReleasePolicyEntry>;
    if (!this.isValidEntry(entry)) return { ...RELEASE_DEFAULT_ENTRY };
    return {
      minimumSupportedVersion: entry.minimumSupportedVersion as string,
      latestVersion: entry.latestVersion as string,
      storeUrl: entry.storeUrl ?? null,
      message: entry.message ?? null,
    };
  }

  private isValidEntry(entry: Partial<ReleasePolicyEntry>): boolean {
    return (
      typeof entry.minimumSupportedVersion === 'string' &&
      isValidVersion(entry.minimumSupportedVersion) &&
      typeof entry.latestVersion === 'string' &&
      isValidVersion(entry.latestVersion) &&
      (entry.storeUrl === undefined || entry.storeUrl === null || typeof entry.storeUrl === 'string') &&
      (entry.message === undefined || entry.message === null || typeof entry.message === 'string')
    );
  }

  /** Every cell of a full-document PUT must be well-formed — an admin write is never allowed to degrade silently to the fallback the way a read does. */
  private assertValidPolicy(policy: unknown): asserts policy is ReleasePolicy {
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
      throw this.invalid('The policy must be an object keyed by app.');
    }
    const source = policy as Record<string, unknown>;
    for (const app of PUSH_APP_KEYS) {
      const appEntry = source[app];
      if (typeof appEntry !== 'object' || appEntry === null || Array.isArray(appEntry)) {
        throw this.invalid(`Missing or invalid "${app}" entry.`);
      }
      for (const platform of RELEASE_PLATFORMS) {
        const entry = (appEntry as Record<string, unknown>)[platform];
        if (typeof entry !== 'object' || entry === null) {
          throw this.invalid(`Missing "${app}.${platform}" entry.`);
        }
        if (!this.isValidEntry(entry as Partial<ReleasePolicyEntry>)) {
          throw this.invalid(`"${app}.${platform}" must have valid minimumSupportedVersion and latestVersion strings.`);
        }
      }
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: RELEASE_ERROR_CODES.CONFIG_INVALID, message });
  }
}
