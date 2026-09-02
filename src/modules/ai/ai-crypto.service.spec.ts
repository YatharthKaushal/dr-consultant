import { AiCryptoService } from './ai-crypto.service';
import { lastFour, maskedKey, redactSecret } from './ai-redaction.util';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

/**
 * `AiCryptoService` reads its master key from `getEnv()` in the constructor,
 * and `getEnv()` memoizes a validated object built from real `.env` files.
 * Rather than reach into that cache, the module is re-required under a mocked
 * `env.validation` — the same trick keeps the two-different-master-keys test
 * honest, since it needs two live services with genuinely different keys.
 */
function serviceWithKey(hexKey: string): AiCryptoService {
  let created!: AiCryptoService;
  jest.isolateModules(() => {
    jest.doMock('../../config/env/env.validation', () => ({
      getEnv: () => ({ AI_CREDENTIAL_ENCRYPTION_KEY: hexKey }),
    }));
    const { AiCryptoService: Ctor } = require('./ai-crypto.service') as typeof import('./ai-crypto.service');
    created = new Ctor();
  });
  return created;
}

describe('AiCryptoService', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../config/env/env.validation');
  });

  describe('encrypt/decrypt round trip', () => {
    it('decrypts back to the exact plaintext', () => {
      const service = serviceWithKey(KEY_A);
      const plaintext = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

      expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
    });

    it('round-trips non-ASCII and long keys', () => {
      const service = serviceWithKey(KEY_A);
      const plaintext = `${'x'.repeat(500)}-ünïcödé-🔑`;

      expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
    });

    it('never emits the plaintext inside the stored value', () => {
      const service = serviceWithKey(KEY_A);
      const plaintext = 'sk-live-SUPERSECRETVALUE-0000';

      const stored = service.encrypt(plaintext);

      expect(stored).not.toContain(plaintext);
      expect(stored).not.toContain('SUPERSECRET');
    });

    it('produces a different ciphertext each time (fresh IV), so identical keys are not linkable in the table', () => {
      const service = serviceWithKey(KEY_A);
      const plaintext = 'sk-identical-key-value-here';

      const first = service.encrypt(plaintext);
      const second = service.encrypt(plaintext);

      expect(first).not.toBe(second);
      expect(service.decrypt(first)).toBe(plaintext);
      expect(service.decrypt(second)).toBe(plaintext);
    });
  });

  describe('stored format', () => {
    it('is `v1:iv:authTag:ciphertext`, all base64url', () => {
      const service = serviceWithKey(KEY_A);

      const parts = service.encrypt('sk-format-check-1234').split(':');

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      // base64url alphabet only — no `+`, `/` or `=` padding, so the value is
      // safe in a URL/log/JSON without further escaping.
      for (const part of parts.slice(1)) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      // 12-byte IV and 16-byte tag, base64url-encoded (no padding).
      expect(Buffer.from(parts[1] as string, 'base64url')).toHaveLength(12);
      expect(Buffer.from(parts[2] as string, 'base64url')).toHaveLength(16);
    });
  });

  describe('tamper detection (GCM auth tag)', () => {
    it('refuses a ciphertext whose payload was altered', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-tamper-target-9999');

      const [version, iv, tag, ciphertext] = stored.split(':') as [string, string, string, string];
      // Flip one bit of the ciphertext.
      const bytes = Buffer.from(ciphertext, 'base64url');
      bytes[0] = (bytes[0] as number) ^ 0x01;
      const tampered = [version, iv, tag, bytes.toString('base64url')].join(':');

      expect(() => service.decrypt(tampered)).toThrow();
    });

    it('refuses a ciphertext whose auth tag was altered', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-tamper-tag-8888');

      const [version, iv, tag, ciphertext] = stored.split(':') as [string, string, string, string];
      const bytes = Buffer.from(tag, 'base64url');
      bytes[0] = (bytes[0] as number) ^ 0xff;
      const tampered = [version, iv, bytes.toString('base64url'), ciphertext].join(':');

      expect(() => service.decrypt(tampered)).toThrow();
    });

    it('refuses a ciphertext whose IV was altered', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-tamper-iv-7777');

      const [version, iv, tag, ciphertext] = stored.split(':') as [string, string, string, string];
      const bytes = Buffer.from(iv, 'base64url');
      bytes[0] = (bytes[0] as number) ^ 0xff;
      const tampered = [version, bytes.toString('base64url'), tag, ciphertext].join(':');

      expect(() => service.decrypt(tampered)).toThrow();
    });
  });

  describe('malformed stored values', () => {
    it('rejects a value with the wrong field count', () => {
      const service = serviceWithKey(KEY_A);
      expect(() => service.decrypt('not-a-stored-value')).toThrow(/4 colon-separated fields/);
    });

    it('rejects an unknown format version', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-version-check-6666');
      const [, iv, tag, ciphertext] = stored.split(':') as [string, string, string, string];

      expect(() => service.decrypt(['v9', iv, tag, ciphertext].join(':'))).toThrow(/unsupported format version/);
    });

    it('rejects a truncated IV with a message naming the problem', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-iv-length-5555');
      const [version, , tag, ciphertext] = stored.split(':') as [string, string, string, string];
      const shortIv = Buffer.alloc(8).toString('base64url');

      expect(() => service.decrypt([version, shortIv, tag, ciphertext].join(':'))).toThrow(/IV/);
    });
  });

  describe('wrong master key', () => {
    it('fails cleanly rather than returning garbage', () => {
      const stored = serviceWithKey(KEY_A).encrypt('sk-wrong-key-target-4444');
      const other = serviceWithKey(KEY_B);

      expect(() => other.decrypt(stored)).toThrow();
    });

    it('rejects a master key that is not 32 bytes', () => {
      // Unreachable via a normal boot (env validation catches it first), but
      // the constructor must not accept it silently.
      expect(() => serviceWithKey('ab'.repeat(16))).toThrow(/32 bytes/);
    });
  });

  describe('matches', () => {
    it('is true for the same plaintext under the same key', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-same-value-3333');

      expect(service.matches(stored, 'sk-same-value-3333')).toBe(true);
    });

    it('is false for a different plaintext', () => {
      const service = serviceWithKey(KEY_A);
      const stored = service.encrypt('sk-same-value-3333');

      expect(service.matches(stored, 'sk-different-value-3333')).toBe(false);
    });

    it('is false (never throws) for an undecryptable value', () => {
      const service = serviceWithKey(KEY_A);

      expect(service.matches('garbage', 'sk-anything')).toBe(false);
      expect(service.matches(serviceWithKey(KEY_B).encrypt('sk-anything'), 'sk-anything')).toBe(false);
    });
  });

  describe('lastFour', () => {
    it('takes the last four characters of the key', () => {
      const service = serviceWithKey(KEY_A);
      expect(service.lastFour('sk-proj-abcdef1234')).toBe('1234');
      expect(lastFour('sk-proj-abcdefWXYZ')).toBe('WXYZ');
    });

    it('pads a shorter key so the column is always exactly four characters', () => {
      expect(lastFour('ab')).toBe('**ab');
      expect(lastFour('')).toBe('****');
      expect(lastFour('abcd')).toBe('abcd');
    });
  });
});

describe('redactSecret', () => {
  it('replaces the key with ****last4 wherever it appears', () => {
    const key = 'AIzaSyDUMMYKEYVALUE1234';
    const text = `GET https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${key} failed`;

    const redacted = redactSecret(text, key, lastFour(key));

    expect(redacted).not.toContain(key);
    expect(redacted).toContain('****1234');
  });

  it('replaces every occurrence, not just the first', () => {
    const key = 'sk-repeated-secret-value-0001';
    const text = `${key} then again ${key}`;

    const redacted = redactSecret(text, key, lastFour(key));

    expect(redacted).toBe('****0001 then again ****0001');
  });

  it('leaves text alone when the key does not appear', () => {
    const key = 'sk-absent-secret-value-0002';
    expect(redactSecret('nothing sensitive here', key, lastFour(key))).toBe('nothing sensitive here');
  });

  it('ignores implausibly short secrets rather than corrupting unrelated text', () => {
    // A 4-character "secret" would otherwise mangle any text containing it.
    expect(redactSecret('the cat sat on the mat', 'at', 'xxat')).toBe('the cat sat on the mat');
  });

  it('maskedKey renders the admin-facing form', () => {
    expect(maskedKey('1234')).toBe('****1234');
  });
});
