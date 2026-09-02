import { BadRequestException } from '@nestjs/common';
import { AnthropicAdapter } from './anthropic.adapter';
import { BedrockAdapter } from './bedrock.adapter';
import { AI_ERROR_CODES, PROVIDER_CODES } from './ai.constants';
import { GoogleGenAiAdapter } from './google-genai.adapter';
import { LlmProviderRegistry } from './llm-provider.registry';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';

function createRegistry() {
  return new LlmProviderRegistry(
    new OpenAiCompatibleAdapter(),
    new AnthropicAdapter(),
    new GoogleGenAiAdapter(),
    new BedrockAdapter(),
  );
}

describe('LlmProviderRegistry', () => {
  it('resolves an adapter for every declared provider code', () => {
    // The claim this asserts is the design's central one: `PROVIDER_CODES` and
    // the registry cannot drift apart. TypeScript already refuses to compile a
    // missing entry (the map is `Record<ProviderCode, ...>`); this catches the
    // other direction — an adapter registered under the wrong key.
    const registry = createRegistry();

    for (const code of PROVIDER_CODES) {
      const adapter = registry.find(code);
      expect(adapter).not.toBeNull();
      expect(adapter?.provider).toBe(code);
    }
  });

  it('gives every adapter its own classifier', () => {
    const registry = createRegistry();
    const classifiers = PROVIDER_CODES.map((code) => registry.find(code)?.classifier);

    expect(new Set(classifiers).size).toBe(PROVIDER_CODES.length);
    for (const classifier of classifiers) {
      expect(typeof classifier?.classify).toBe('function');
    }
  });

  describe('find', () => {
    it('returns null for an unknown provider rather than throwing', () => {
      // Rotation MUST be able to skip an unserviceable profile and carry on —
      // one row restored from a dump written by a newer build cannot be
      // allowed to take down every completion.
      expect(createRegistry().find('some_future_provider')).toBeNull();
    });

    it('returns null for an empty string and for a near-miss', () => {
      const registry = createRegistry();
      expect(registry.find('')).toBeNull();
      expect(registry.find('openai')).toBeNull();
      expect(registry.find('OPENAI_COMPATIBLE')).toBeNull();
    });

    it('is not fooled by an inherited Object property name', () => {
      // `find` guards with an explicit membership test rather than a bare
      // property lookup, so a prototype key cannot resolve to an "adapter".
      const registry = createRegistry();
      expect(registry.find('toString')).toBeNull();
      expect(registry.find('constructor')).toBeNull();
      expect(registry.find('__proto__')).toBeNull();
    });
  });

  describe('require', () => {
    it('returns the adapter for a known provider', () => {
      expect(createRegistry().require('anthropic').provider).toBe('anthropic');
    });

    it('throws 400 UNSUPPORTED_PROVIDER naming the supported set', () => {
      const error = (() => {
        try {
          createRegistry().require('some_future_provider');
          return null;
        } catch (e: unknown) {
          return e;
        }
      })();

      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { code: string; message: string };
      expect(body.code).toBe(AI_ERROR_CODES.UNSUPPORTED_PROVIDER);
      expect(body.message).toContain('openai_compatible');
      expect(body.message).toContain('some_future_provider');
    });
  });
});
