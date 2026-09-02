import { z } from 'zod';
import {
  extractJson,
  invokeJsonPromptFallback,
  invokeNativeStructured,
  looksLikeUnsupportedStructuredOutput,
  messageText,
  type StructuredCapableChatModel,
} from './llm-structured-output.util';
import type { LlmCompletionParams } from './llm-provider.types';

const SCHEMA = z.object({ specialty: z.string(), confidence: z.number() });

function params(overrides: Partial<LlmCompletionParams<{ specialty: string; confidence: number }>> = {}) {
  return {
    system: 'You are a triage assistant.',
    user: 'I cannot sleep and feel anxious.',
    schema: SCHEMA,
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    baseUrl: null,
    timeoutMs: 15_000,
    ...overrides,
  };
}

/** A stand-in chat model. `StructuredCapableChatModel` is a structural type, so a plain object satisfies it — which is the point of declaring it that way. */
function stubModel(behaviour: {
  structured?: (input: unknown, options?: unknown) => Promise<unknown>;
  plain?: (input: unknown, options?: unknown) => Promise<{ content: unknown }>;
}) {
  const withStructuredOutput = jest.fn(() => ({
    invoke: jest.fn(behaviour.structured ?? (async () => ({}))),
  }));
  const invoke = jest.fn(behaviour.plain ?? (async () => ({ content: '' })));

  return {
    model: { withStructuredOutput, invoke } as unknown as StructuredCapableChatModel,
    withStructuredOutput,
    invoke,
  };
}

describe('invokeNativeStructured', () => {
  it('passes the schema, a stable tool name and the requested method to LangChain', async () => {
    const { model, withStructuredOutput } = stubModel({
      structured: async () => ({ specialty: 'psychiatry', confidence: 0.8 }),
    });

    await invokeNativeStructured(model, params(), 'functionCalling');

    expect(withStructuredOutput).toHaveBeenCalledWith(SCHEMA, {
      name: 'structured_result',
      method: 'functionCalling',
    });
  });

  it('sends a system message and a human message, in that order', async () => {
    let captured: unknown;
    const { model } = stubModel({
      structured: async (input) => {
        captured = input;
        return { specialty: 'psychiatry', confidence: 0.8 };
      },
    });

    await invokeNativeStructured(model, params(), 'jsonSchema');

    expect(captured).toEqual([
      ['system', 'You are a triage assistant.'],
      ['human', 'I cannot sleep and feel anxious.'],
    ]);
  });

  it('bounds the call with the resolved per-call timeout', async () => {
    let options: unknown;
    const { model } = stubModel({
      structured: async (_input, opts) => {
        options = opts;
        return { specialty: 'psychiatry', confidence: 0.8 };
      },
    });

    await invokeNativeStructured(model, params({ timeoutMs: 4_000 }), 'jsonSchema');

    expect(options).toEqual({ timeout: 4_000 });
  });

  it('re-validates the model’s output through the caller’s zod schema', async () => {
    // Not redundant: it is what makes BOTH paths (native and the JSON
    // fallback) end at the same guarantee, so a caller never has to know
    // which one ran.
    const { model } = stubModel({ structured: async () => ({ specialty: 'psychiatry', confidence: 'high' }) });

    await expect(invokeNativeStructured(model, params(), 'jsonSchema')).rejects.toThrow();
  });

  it('returns the parsed value on success', async () => {
    const { model } = stubModel({ structured: async () => ({ specialty: 'psychiatry', confidence: 0.91 }) });

    await expect(invokeNativeStructured(model, params(), 'jsonSchema')).resolves.toEqual({
      specialty: 'psychiatry',
      confidence: 0.91,
    });
  });
});

describe('invokeJsonPromptFallback', () => {
  it('appends the JSON Schema to the system prompt and leaves the user message alone', async () => {
    let captured: [string, string][] = [];
    const { model } = stubModel({
      plain: async (input) => {
        captured = input as [string, string][];
        return { content: '{"specialty":"psychiatry","confidence":0.7}' };
      },
    });

    await invokeJsonPromptFallback(model, params());

    const [[systemRole, systemText], [humanRole, humanText]] = captured;
    expect(systemRole).toBe('system');
    expect(systemText).toContain('You are a triage assistant.');
    expect(systemText).toContain('single JSON object');
    // The actual schema, so the model knows the field names.
    expect(systemText).toContain('"specialty"');
    expect(systemText).toContain('"confidence"');
    expect(humanRole).toBe('human');
    expect(humanText).toBe('I cannot sleep and feel anxious.');
  });

  it('parses a bare JSON reply', async () => {
    const { model } = stubModel({ plain: async () => ({ content: '{"specialty":"psychiatry","confidence":0.7}' }) });

    await expect(invokeJsonPromptFallback(model, params())).resolves.toEqual({
      specialty: 'psychiatry',
      confidence: 0.7,
    });
  });

  it('parses a reply the model wrapped in a markdown fence anyway', async () => {
    const { model } = stubModel({
      plain: async () => ({ content: '```json\n{"specialty":"psychiatry","confidence":0.7}\n```' }),
    });

    await expect(invokeJsonPromptFallback(model, params())).resolves.toEqual({
      specialty: 'psychiatry',
      confidence: 0.7,
    });
  });

  it('parses a reply padded with prose', async () => {
    const { model } = stubModel({
      plain: async () => ({ content: 'Sure! Here you go:\n{"specialty":"psychiatry","confidence":0.7}\nHope that helps.' }),
    });

    await expect(invokeJsonPromptFallback(model, params())).resolves.toEqual({
      specialty: 'psychiatry',
      confidence: 0.7,
    });
  });

  it('handles a reply delivered as content blocks rather than a string', async () => {
    const { model } = stubModel({
      plain: async () => ({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: '{"specialty":"psychiatry",' },
          { type: 'text', text: '"confidence":0.7}' },
        ],
      }),
    });

    await expect(invokeJsonPromptFallback(model, params())).resolves.toEqual({
      specialty: 'psychiatry',
      confidence: 0.7,
    });
  });

  it('throws when the model answered with prose and no JSON at all', async () => {
    const { model } = stubModel({ plain: async () => ({ content: 'I am not able to help with that.' }) });

    await expect(invokeJsonPromptFallback(model, params())).rejects.toThrow();
  });

  it('still asks for JSON when the schema cannot be expressed as JSON Schema', async () => {
    // A transform has no JSON Schema equivalent and `z.toJSONSchema` throws.
    // The instruction must survive that, because zod still validates the reply.
    const transformed = z.string().transform((value) => ({ value }));
    let systemText = '';
    const { model } = stubModel({
      plain: async (input) => {
        systemText = (input as [string, string][])[0][1];
        return { content: '"hello"' };
      },
    });

    const result = await invokeJsonPromptFallback(model, {
      system: 'You are a triage assistant.',
      user: 'hi',
      schema: transformed,
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: null,
      timeoutMs: 15_000,
    });

    expect(systemText).toContain('single JSON object');
    // No schema block, because there was none to emit — but zod still ran.
    expect(systemText).not.toContain('JSON Schema:');
    expect(result).toEqual({ value: 'hello' });
  });
});

describe('looksLikeUnsupportedStructuredOutput', () => {
  it('is true for a host rejecting response_format', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({
        status: 400,
        message: "400 'response_format.type' : value is not one of the allowed values ['text','json_object']",
      }),
    ).toBe(true);
  });

  it('is true for a host that does not implement tools', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({
        status: 400,
        message: '400 tool_choice is not supported by this model',
      }),
    ).toBe(true);
  });

  it('is true for an unrecognised json_schema parameter', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({
        status: 422,
        param: 'response_format',
        message: 'Unknown parameter: json_schema',
      }),
    ).toBe(true);
  });

  it('is FALSE for a dead key, however the body is worded', () => {
    // The gate gets a second billed call on the same credential, so a false
    // positive costs the client money on a request that was already lost.
    expect(
      looksLikeUnsupportedStructuredOutput({ status: 401, message: '401 Incorrect API key provided' }),
    ).toBe(false);
  });

  it('is FALSE for a rate limit', () => {
    expect(looksLikeUnsupportedStructuredOutput({ status: 429, message: '429 Rate limit reached' })).toBe(false);
  });

  it('is FALSE for a 5xx, whatever it mentions', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({ status: 503, message: '503 tools are not supported right now' }),
    ).toBe(false);
  });

  it('is FALSE for a 4xx that names no capability', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({ status: 400, message: '400 messages: must contain at least one item' }),
    ).toBe(false);
  });

  it('is FALSE for a 4xx that names a capability but reports no capability problem', () => {
    expect(
      looksLikeUnsupportedStructuredOutput({ status: 400, message: '400 tools[0].function.name is required' }),
    ).toBe(false);
  });

  it('is FALSE when there is no status at all (a connection failure)', () => {
    expect(looksLikeUnsupportedStructuredOutput({ message: 'Connection error.' })).toBe(false);
  });
});

describe('extractJson', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a ```json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('unwraps a bare ``` fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('takes the span from the first { to the last }', () => {
    expect(extractJson('Here: {"a":{"b":2}} — done')).toBe('{"a":{"b":2}}');
  });

  it('leaves text with no object alone, so JSON.parse produces the real error', () => {
    expect(extractJson('no json here')).toBe('no json here');
  });
});

describe('messageText', () => {
  it('returns a string content as-is', () => {
    expect(messageText({ content: 'hello' })).toBe('hello');
  });

  it('concatenates the text blocks of an array content', () => {
    expect(messageText({ content: [{ text: 'a' }, { notText: 'x' }, { text: 'b' }] })).toBe('ab');
  });

  it('returns an empty string for content it cannot read', () => {
    expect(messageText({ content: null })).toBe('');
    expect(messageText({ content: 42 })).toBe('');
  });
});
