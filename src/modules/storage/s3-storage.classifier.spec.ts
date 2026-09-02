import { S3Classifier } from './s3-storage.classifier';

/**
 * Fixtures modelled on what `@aws-sdk/client-s3@3.1124.0` actually throws,
 * verified against the installed SDK's own type declarations
 * (`@smithy/core`'s `ServiceException`: `.name` set to the AWS error code,
 * `.$metadata.httpStatusCode` carrying the HTTP status) and its exported
 * exception list (`NoSuchBucket`/`NoSuchKey`/`AccessDenied` are real modelled
 * classes; `InvalidAccessKeyId`/`SignatureDoesNotMatch`/`ExpiredToken` are
 * NOT — they surface as a generic error object with only `.name` set,
 * confirmed by `Object.keys(require('@aws-sdk/client-s3'))` not including
 * them).
 */
function s3Error(params: { name: string; message: string; httpStatusCode?: number }): Record<string, unknown> {
  return {
    name: params.name,
    message: params.message,
    $fault: 'client',
    $metadata: params.httpStatusCode === undefined ? {} : { httpStatusCode: params.httpStatusCode },
  };
}

describe('S3Classifier', () => {
  const classifier = new S3Classifier();

  describe('invalid_credentials', () => {
    it('classifies InvalidAccessKeyId (403, unmodelled — name only)', () => {
      const result = classifier.classify(
        s3Error({
          name: 'InvalidAccessKeyId',
          message: 'The AWS Access Key Id you provided does not exist in our records.',
          httpStatusCode: 403,
        }),
      );
      expect(result.kind).toBe('invalid_credentials');
      expect(result.detail).toContain('Access Key Id');
    });

    it('classifies SignatureDoesNotMatch (403, unmodelled — name only)', () => {
      const result = classifier.classify(
        s3Error({
          name: 'SignatureDoesNotMatch',
          message:
            'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
          httpStatusCode: 403,
        }),
      );
      expect(result.kind).toBe('invalid_credentials');
    });

    it('classifies ExpiredToken', () => {
      expect(
        classifier.classify(s3Error({ name: 'ExpiredToken', message: 'The provided token has expired.', httpStatusCode: 400 }))
          .kind,
      ).toBe('invalid_credentials');
    });

    it('falls back to a bare 401 when name carries no signal', () => {
      expect(classifier.classify(s3Error({ name: 'UnknownAuthError', message: 'Unauthorized', httpStatusCode: 401 })).kind).toBe(
        'invalid_credentials',
      );
    });
  });

  describe('access_denied — distinguished from invalid_credentials despite the SAME 403 status', () => {
    it('classifies the modelled AccessDenied exception', () => {
      const result = classifier.classify(
        s3Error({ name: 'AccessDenied', message: 'Access Denied', httpStatusCode: 403 }),
      );
      expect(result.kind).toBe('access_denied');
    });

    it('does NOT confuse AccessDenied (valid creds, no permission) with InvalidAccessKeyId (bad creds) — both are 403', () => {
      const deniedKind = classifier.classify(s3Error({ name: 'AccessDenied', message: 'Access Denied', httpStatusCode: 403 })).kind;
      const invalidKind = classifier.classify(
        s3Error({ name: 'InvalidAccessKeyId', message: 'does not exist', httpStatusCode: 403 }),
      ).kind;

      expect(deniedKind).toBe('access_denied');
      expect(invalidKind).toBe('invalid_credentials');
      expect(deniedKind).not.toBe(invalidKind);
    });
  });

  describe('not_found', () => {
    it('classifies the modelled NoSuchBucket exception', () => {
      expect(
        classifier.classify(
          s3Error({ name: 'NoSuchBucket', message: 'The specified bucket does not exist', httpStatusCode: 404 }),
        ).kind,
      ).toBe('not_found');
    });

    it('classifies the modelled NoSuchKey exception', () => {
      expect(
        classifier.classify(s3Error({ name: 'NoSuchKey', message: 'The specified key does not exist.', httpStatusCode: 404 }))
          .kind,
      ).toBe('not_found');
    });

    it('falls back to a bare 404 when name carries no signal', () => {
      expect(classifier.classify(s3Error({ name: 'SomeHost404', message: 'not there', httpStatusCode: 404 })).kind).toBe(
        'not_found',
      );
    });
  });

  describe('network_or_timeout', () => {
    it('classifies a Node socket-level connection error', () => {
      expect(classifier.classify({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' }).kind).toBe(
        'network_or_timeout',
      );
    });

    it('classifies a DNS resolution failure', () => {
      expect(classifier.classify({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND bucket.s3.amazonaws.com' }).kind).toBe(
        'network_or_timeout',
      );
    });

    it('classifies a named TimeoutError with no status at all', () => {
      expect(classifier.classify({ name: 'TimeoutError', message: 'Connection timed out.' }).kind).toBe(
        'network_or_timeout',
      );
    });

    it('classifies a 500 InternalError as network_or_timeout, not unknown', () => {
      expect(
        classifier.classify(s3Error({ name: 'InternalError', message: 'We encountered an internal error.', httpStatusCode: 500 }))
          .kind,
      ).toBe('network_or_timeout');
    });

    it('classifies a 503 SlowDown/throttling response as network_or_timeout', () => {
      expect(
        classifier.classify(s3Error({ name: 'SlowDown', message: 'Please reduce your request rate.', httpStatusCode: 503 })).kind,
      ).toBe('network_or_timeout');
    });
  });

  describe('unknown', () => {
    it('classifies an unrecognised error shape as unknown, never as benign', () => {
      const result = classifier.classify(s3Error({ name: 'SomeFutureError', message: "I'm a teapot", httpStatusCode: 418 }));
      expect(result.kind).toBe('unknown');
      expect(result.detail).toContain('teapot');
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
      const result = classifier.classify(s3Error({ name: 'SomeError', message: `x${'y'.repeat(1_000)}`, httpStatusCode: 400 }));
      expect(result.detail.length).toBeLessThanOrEqual(301);
      expect(result.detail.endsWith('…')).toBe(true);
    });
  });
});
