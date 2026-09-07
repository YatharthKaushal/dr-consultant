import { BadRequestException } from '@nestjs/common';
import { RELEASE_ERROR_CODES } from './release.constants';

/**
 * Numeric-segment version comparison — `major.minor.patch`, any number of
 * segments, missing ones treated as `0` (`'1.2' == '1.2.0'`). No build
 * metadata / pre-release tag support (`1.0.0-beta`): app store version
 * strings on both platforms are plain numeric triples, and adding SemVer's
 * full pre-release precedence rules here would be complexity this feature
 * has no user for.
 */
const VERSION_SEGMENT_PATTERN = /^\d+(\.\d+)*$/;

export function isValidVersion(value: string): boolean {
  return typeof value === 'string' && VERSION_SEGMENT_PATTERN.test(value.trim());
}

export function parseVersion(value: string): number[] {
  if (!isValidVersion(value)) {
    throw new BadRequestException({
      code: RELEASE_ERROR_CODES.INVALID_VERSION,
      message: `"${value}" is not a valid version string (expected numeric segments like "1.2.3").`,
    });
  }
  return value.trim().split('.').map(Number);
}

/** `-1` if `a < b`, `0` if equal, `1` if `a > b`. Throws `BadRequestException` on a malformed input — callers validate before comparing, never after. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}
