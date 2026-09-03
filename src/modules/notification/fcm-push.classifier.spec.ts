import { FcmPushClassifier, toDetail } from './fcm-push.classifier';

/**
 * Classification is duck-typed on `.code`, not `instanceof`, so these
 * fixtures are plain objects shaped like the errors `firebase-admin@14.3.0`
 * throws — the same approach `s3-storage.classifier.spec.ts` takes, and for
 * the same reason: the credential and transport layers below the messaging
 * API throw errors that never reach a modelled Firebase class.
 *
 * NO NETWORK CALL IS MADE ANYWHERE IN THIS FILE. The classifier takes an
 * error object and returns a kind; that is its whole surface.
 */
const classifier = new FcmPushClassifier();

function fcmError(code: string, message = 'vendor text'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('FcmPushClassifier', () => {
  /**
   * *** THE ONE WITH A SIDE EFFECT. *** FCM is saying the token is dead — the
   * app was uninstalled or the token rotated. `notification.service.ts` clears
   * it from the account row; not doing so leaves every future notification to
   * that account failing forever against a token FCM has already disowned.
   */
  it('classifies a not-registered token as unregistered_token, the one kind that clears the stored token', () => {
    expect(classifier.classify(fcmError('messaging/registration-token-not-registered')).kind).toBe(
      'unregistered_token',
    );
  });

  /**
   * NOT cleared: a token rejected because it belongs to the OTHER app's
   * Firebase project is still a valid token, and deleting it would hide a
   * misconfiguration rather than surface it.
   */
  it.each([
    ['messaging/invalid-registration-token'],
    ['messaging/invalid-recipient'],
    ['messaging/mismatched-credential'],
  ])('classifies %s as invalid_token, which is NOT cleared', (code) => {
    expect(classifier.classify(fcmError(code)).kind).toBe('invalid_token');
  });

  it.each([
    ['messaging/authentication-error'],
    ['messaging/invalid-apns-credentials'],
    ['app/invalid-credential'],
    ['app/invalid-app-options'],
  ])('classifies %s as invalid_credentials', (code) => {
    expect(classifier.classify(fcmError(code)).kind).toBe('invalid_credentials');
  });

  /**
   * FCM delivers to iOS THROUGH APNs, so one SDK covers both platforms — and
   * an APNs certificate/key problem surfaces as a "third party" auth error
   * rather than as an FCM one. It is a credential failure, just one hop
   * further down.
   */
  it('classifies the APNs third-party auth error as invalid_credentials', () => {
    expect(classifier.classify(fcmError('messaging/third-party-auth-error')).kind).toBe('invalid_credentials');
  });

  it.each([
    ['messaging/message-rate-exceeded'],
    ['messaging/device-message-rate-exceeded'],
    ['messaging/topics-message-rate-exceeded'],
    ['messaging/quota-exceeded'],
  ])('classifies %s as rate_limited', (code) => {
    expect(classifier.classify(fcmError(code)).kind).toBe('rate_limited');
  });

  it.each([['messaging/server-unavailable'], ['messaging/internal-error'], ['messaging/unknown-error']])(
    'classifies %s as unavailable',
    (code) => {
      expect(classifier.classify(fcmError(code)).kind).toBe('unavailable');
    },
  );

  it.each([['ECONNRESET'], ['ETIMEDOUT'], ['ENOTFOUND'], ['UND_ERR_CONNECT_TIMEOUT']])(
    'classifies the transport failure %s as unavailable',
    (code) => {
      expect(classifier.classify(fcmError(code)).kind).toBe('unavailable');
    },
  );

  /** An unrecognised shape is `unknown`, never benign — the rule `StorageErrorClassifier` states. */
  it.each([
    [fcmError('messaging/something-google-added-later')],
    [new Error('a bare error with no code')],
    ['a string'],
    [null],
    [undefined],
    [{}],
    [42],
  ])('classifies the unrecognised shape %s as unknown', (error) => {
    expect(classifier.classify(error).kind).toBe('unknown');
  });

  /**
   * *** THE CONTRACT THAT MATTERS MOST HERE. ***
   *
   * This runs on the failure path of a `notify` call that is itself
   * documented as never throwing into a caller's flow. A classifier that
   * threw would turn a failed push into a failed booking. So it must survive
   * anything, including shapes no real SDK produces:
   *
   *   - a null-prototype object, where `String(error)` itself raises
   *     "Cannot convert object to primitive value";
   *   - an object whose `.code` getter throws.
   */
  it.each([
    ['a null-prototype object', Object.create(null) as unknown],
    ['an object with a throwing code getter', { get code(): never { throw new Error('boom'); } }],
    ['an object with a throwing message getter', { get message(): never { throw new Error('boom'); } }],
    ['a proxy that answers undefined to everything', new Proxy({}, { get: () => undefined })],
  ])('never throws on %s, and still returns a kind', (_label, error) => {
    expect(() => classifier.classify(error)).not.toThrow();
    expect(classifier.classify(error).kind).toBe('unknown');
    expect(typeof classifier.classify(error).detail).toBe('string');
  });

  describe('detail', () => {
    it('carries the vendor message', () => {
      expect(classifier.classify(fcmError('messaging/internal-error', 'Backend error')).detail).toBe('Backend error');
    });

    it('collapses whitespace so a multi-line vendor error stays one log line', () => {
      expect(toDetail('a\n  b\t c ')).toBe('a b c');
    });

    /** `notifications.failure_reason` is `varchar(200)`; this leaves room for the `kind:` prefix the service adds. */
    it('bounds a long vendor message', () => {
      expect(toDetail('x'.repeat(500)).length).toBeLessThanOrEqual(141);
    });

    it('says "no detail" rather than being empty, so a failure_reason is never just the kind and a colon', () => {
      expect(toDetail('   ')).toBe('no detail');
    });
  });
});
