import { BadRequestException } from '@nestjs/common';
import { buildStorageKey, parseStorageKey } from './storage-key.util';

describe('storage-key.util', () => {
  describe('round trip', () => {
    it('builds and parses an s3 key', () => {
      const key = buildStorageKey('s3', 'doctor-documents', 'abc-123.pdf');
      expect(key).toBe('s3:doctor-documents/abc-123.pdf');

      const parsed = parseStorageKey(key);
      expect(parsed).toEqual({
        provider: 's3',
        category: 'doctor-documents',
        objectId: 'abc-123.pdf',
        rest: 'doctor-documents/abc-123.pdf',
      });
    });

    it('builds and parses a cloudinary key', () => {
      const key = buildStorageKey('cloudinary', 'patient-files', 'abc-123');
      expect(key).toBe('cloudinary:patient-files/abc-123');

      const parsed = parseStorageKey(key);
      expect(parsed).toEqual({
        provider: 'cloudinary',
        category: 'patient-files',
        objectId: 'abc-123',
        rest: 'patient-files/abc-123',
      });
    });

    it('round-trips an objectId that itself contains slashes and dots', () => {
      // Not something either adapter currently produces, but the format must
      // not silently corrupt a nested-looking id — `rest`/`objectId` just
      // split on the FIRST slash after the provider prefix.
      const key = buildStorageKey('s3', 'content', 'nested/2024/report.final.pdf');

      const parsed = parseStorageKey(key);
      expect(parsed.category).toBe('content');
      expect(parsed.objectId).toBe('nested/2024/report.final.pdf');
      expect(parsed.rest).toBe('content/nested/2024/report.final.pdf');
    });
  });

  describe('malformed / unknown-prefix keys', () => {
    const cases: Array<[name: string, key: string]> = [
      ['no colon at all', 'not-a-key'],
      ['unknown provider prefix', 'azure:patient-files/abc-123'],
      ['empty provider prefix', ':patient-files/abc-123'],
      ['no category/objectId after the prefix', 's3:'],
      ['no slash after the provider prefix', 's3:justanobjectid'],
      ['empty category before the slash', 's3:/abc-123'],
      ['empty objectId after the slash', 's3:doctor-documents/'],
      ['empty string', ''],
    ];

    it.each(cases)('rejects: %s (%s)', (_name, key) => {
      expect(() => parseStorageKey(key)).toThrow(BadRequestException);
    });

    it('throws the STORAGE_KEY_INVALID code and mentions the offending key', () => {
      try {
        parseStorageKey('not-a-key');
        throw new Error('expected parseStorageKey to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'STORAGE_KEY_INVALID',
          message: expect.stringContaining('not-a-key'),
        });
      }
    });
  });

  describe('provider prefix is case-sensitive and exact', () => {
    it('does not accept a provider prefix with different casing', () => {
      expect(() => parseStorageKey('S3:doctor-documents/abc-123.pdf')).toThrow(BadRequestException);
    });

    it('does not accept a prefix that merely starts with a known provider name', () => {
      expect(() => parseStorageKey('s3x:doctor-documents/abc-123.pdf')).toThrow(BadRequestException);
    });
  });
});
