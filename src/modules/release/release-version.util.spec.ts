import { BadRequestException } from '@nestjs/common';
import { compareVersions, isValidVersion, parseVersion } from './release-version.util';

describe('release-version.util', () => {
  describe('compareVersions', () => {
    it('treats a missing segment as 0 — "1.2" equals "1.2.0"', () => {
      expect(compareVersions('1.2', '1.2.0')).toBe(0);
    });

    it('compares numerically, not lexically — "1.10.0" > "1.9.0"', () => {
      expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
      expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    });

    it('compares by leftmost differing segment', () => {
      expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    });

    it('is reflexive on equal strings', () => {
      expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    });

    it('throws BadRequestException on a malformed version, never a silent NaN comparison', () => {
      expect(() => compareVersions('abc', '1.0.0')).toThrow(BadRequestException);
      expect(() => compareVersions('1.0.0', '1.0.0-beta')).toThrow(BadRequestException);
      expect(() => compareVersions('', '1.0.0')).toThrow(BadRequestException);
    });
  });

  describe('isValidVersion', () => {
    it('accepts plain numeric-segment strings', () => {
      expect(isValidVersion('1')).toBe(true);
      expect(isValidVersion('1.2')).toBe(true);
      expect(isValidVersion('1.2.3')).toBe(true);
    });

    it('rejects anything else', () => {
      expect(isValidVersion('1.2.3-beta')).toBe(false);
      expect(isValidVersion('v1.2.3')).toBe(false);
      expect(isValidVersion('')).toBe(false);
      expect(isValidVersion('1..2')).toBe(false);
    });
  });

  describe('parseVersion', () => {
    it('splits into numeric segments', () => {
      expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    });

    it('throws the release-specific error code', () => {
      try {
        parseVersion('nope');
        fail('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'RELEASE_INVALID_VERSION' });
      }
    });
  });
});
