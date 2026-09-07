import { Module } from '@nestjs/common';
import { ReleaseAdminController } from './release-admin.controller';
import { ReleaseConfigRepository } from './release-config.repository';
import { ReleaseConfigService } from './release-config.service';
import { ReleaseController } from './release.controller';
import { ReleaseService } from './release.service';

/**
 * Force-update policy — entirely greenfield when this module was written
 * (no `app_version`/`minVersion`/`platform` concept anywhere in the
 * codebase). Owns one `app_config` key, `release.policy` — no schema file,
 * no migration.
 *
 * *** THIS MODULE OWNS NO TABLE, AND EXPORTS NEITHER A FACADE NOR A
 * CONTRACT. *** Same posture `governance.module.ts`'s header states for
 * itself: no other module needs to read release policy — the one consumer
 * is the mobile app itself, over `ReleaseController`'s public HTTP route —
 * so adding an unconsumed `<domain>.facade.ts`/`.contract.ts` pair would be
 * two empty files with no caller, not the convention this codebase actually
 * follows it for.
 *
 * *** WHY PER-APP *** AND *** PER-PLATFORM ***, NOT ONE SHARED MINIMUM. ***
 * `PUSH_APP_KEYS` (`notification-push.types.ts`) already establishes that
 * the patient and doctor apps are separate store listings with independent
 * release cadences — a shared minimum would force one app's rollout to wait
 * on the other's. Within one app, iOS and Android also diverge routinely:
 * an App Store review can sit for days after the matching Android build is
 * already live, and a single shared minimum would force choosing between
 * locking out Android users early or leaving the still-broken iOS build
 * reachable. `RELEASE_PLATFORMS` (`ios`/`android`) is a small, local
 * addition — no platform discriminator exists anywhere else in this schema,
 * and none is needed beyond this one config document.
 */
@Module({
  controllers: [ReleaseController, ReleaseAdminController],
  providers: [ReleaseConfigRepository, ReleaseConfigService, ReleaseService],
})
export class ReleaseModule {}
