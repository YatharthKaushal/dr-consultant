import { Injectable } from '@nestjs/common';
import { ReleaseConfigService } from './release-config.service';
import { compareVersions } from './release-version.util';
import type { ReleaseStatus, ReleaseStatusQuery } from './release.types';

/**
 * The force-update decision itself. `updateRequired` is the gate an app
 * should treat as blocking; `updateAvailable` is informational (show a
 * dismissible banner) — the two are independent because a client below the
 * minimum is by definition also below the latest, but a client AT the
 * minimum and below the latest should nag, not block.
 */
@Injectable()
export class ReleaseService {
  constructor(private readonly config: ReleaseConfigService) {}

  async getReleaseStatus(query: ReleaseStatusQuery): Promise<ReleaseStatus> {
    const policy = await this.config.getResolved();
    const entry = policy[query.app][query.platform];

    return {
      updateRequired: compareVersions(query.version, entry.minimumSupportedVersion) < 0,
      updateAvailable: compareVersions(query.version, entry.latestVersion) < 0,
      minimumSupportedVersion: entry.minimumSupportedVersion,
      latestVersion: entry.latestVersion,
      storeUrl: entry.storeUrl,
      message: entry.message,
    };
  }
}
