import { CloudinaryClassifier } from './cloudinary-storage.classifier';

/**
 * Fixtures modelled on `cloudinary@2.11.0`'s own `UploadApiErrorResponse`
 * type (`node_modules/cloudinary/types/index.d.ts`): `{ message: string;
 * name: string; http_code: number; request_id?: string }` — a plain object
 * carried as the callback's `error` argument (and as the rejection value once
 * wrapped in a Promise), not a custom `Error` subclass with a rich type
 * hierarchy the way AWS SDK v3's exceptions are.
 */
function cloudinaryError(params: { message: string; http_code?: number; name?: string }): Record<string, unknown> {
  return {
    message: params.message,
    name: params.name ?? 'Error',
    http_code: params.http_code,
    request_id: 'req_test_1234',
  };
}

describe('CloudinaryClassifier', () => {
  const classifier = new CloudinaryClassifier();

  describe('invalid_credentials', () => {
    it('classifies a 401 with an invalid-signature message', () => {
      const result = classifier.classify(cloudinaryError({ http_code: 401, message: 'Invalid Signature 4a1b2c3d.' }));
      expect(result.kind).toBe('invalid_credentials');
      expect(result.detail).toContain('Invalid Signature');
    });

    it('classifies a 401 with an unknown-api_key message', () => {
      expect(classifier.classify(cloudinaryError({ http_code: 401, message: 'Unknown API key abcd1234' })).kind).toBe(
        'invalid_credentials',
      );
    });

    it('falls back to message matching when http_code is absent (a config-time failure)', () => {
      expect(classifier.classify(cloudinaryError({ message: 'Invalid api_key' })).kind).toBe('invalid_credentials');
    });
  });

  describe('access_denied', () => {
    it('classifies a 403', () => {
      expect(classifier.classify(cloudinaryError({ http_code: 403, message: 'Forbidden' })).kind).toBe('access_denied');
    });
  });

  describe('not_found', () => {
    it('classifies a 404', () => {
      expect(classifier.classify(cloudinaryError({ http_code: 404, message: 'Resource not found' })).kind).toBe('not_found');
    });

    it('falls back to message matching for a "not found" result with no http_code', () => {
      // uploader.destroy on a missing asset resolves ok (result: 'not found'),
      // handled by the adapter without throwing — but a raw "not found" thrown
      // by some other call path should still classify correctly.
      expect(classifier.classify(cloudinaryError({ message: 'Resource not found' })).kind).toBe('not_found');
    });
  });

  describe('network_or_timeout', () => {
    it('classifies a Node socket-level connection error', () => {
      expect(classifier.classify({ code: 'ECONNRESET', message: 'socket hang up' }).kind).toBe('network_or_timeout');
    });

    it('classifies a DNS resolution failure reaching api.cloudinary.com', () => {
      expect(classifier.classify({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.cloudinary.com' }).kind).toBe(
        'network_or_timeout',
      );
    });

    it('classifies a message-only timeout with no http_code', () => {
      expect(classifier.classify(cloudinaryError({ message: 'Request timed out' })).kind).toBe('network_or_timeout');
    });

    it('classifies a 500 as network_or_timeout', () => {
      expect(classifier.classify(cloudinaryError({ http_code: 500, message: 'Internal Server Error' })).kind).toBe(
        'network_or_timeout',
      );
    });

    it('classifies a 503 as network_or_timeout', () => {
      expect(classifier.classify(cloudinaryError({ http_code: 503, message: 'Service Unavailable' })).kind).toBe(
        'network_or_timeout',
      );
    });
  });

  describe('unknown', () => {
    it('classifies an unrecognised http_code as unknown, never as benign', () => {
      const result = classifier.classify(cloudinaryError({ http_code: 420, message: 'Rate limited, sort of' }));
      expect(result.kind).toBe('unknown');
    });

    it('classifies an object with no recognisable fields', () => {
      expect(classifier.classify({}).kind).toBe('unknown');
    });

    it('classifies a thrown string without throwing itself', () => {
      expect(classifier.classify('something went sideways').kind).toBe('unknown');
    });

    it('classifies null/undefined without throwing', () => {
      expect(classifier.classify(null).kind).toBe('unknown');
      expect(classifier.classify(undefined).kind).toBe('unknown');
    });
  });

  describe('detail', () => {
    it('collapses whitespace and truncates very long vendor text', () => {
      const result = classifier.classify(cloudinaryError({ http_code: 400, message: `x${'y'.repeat(1_000)}` }));
      expect(result.detail.length).toBeLessThanOrEqual(301);
      expect(result.detail.endsWith('…')).toBe(true);
    });
  });
});
