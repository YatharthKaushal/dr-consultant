import type { PushAppKey } from '../notification/notification-push.types';
import type { ReleasePlatform } from './release.constants';

/** One `{app}.{platform}` cell of `release.policy`. */
export interface ReleasePolicyEntry {
  minimumSupportedVersion: string;
  latestVersion: string;
  storeUrl: string | null;
  message: string | null;
}

/** The full stored shape: `{ patient: { ios, android }, doctor: { ios, android } }`. */
export type ReleasePolicy = Record<PushAppKey, Record<ReleasePlatform, ReleasePolicyEntry>>;

export interface ReleaseStatusQuery {
  app: PushAppKey;
  platform: ReleasePlatform;
  version: string;
}

export interface ReleaseStatus {
  updateRequired: boolean;
  updateAvailable: boolean;
  minimumSupportedVersion: string;
  latestVersion: string;
  storeUrl: string | null;
  message: string | null;
}
