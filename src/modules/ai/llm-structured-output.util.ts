import type { BaseMessageLike } from '@langchain/core/messages';
import { z } from 'zod';
import { asRecord, readMessage, readStatus } from './llm-error.util';
import type { LlmCompletionParams } from './llm-provider.types';

/**
 * The slice of a LangChain chat model these helpers actually use, declared
 * structurally rather than as `BaseChatModel`.
 *
 * That is deliberate and load-bearing. `@langchain/core` ships BOTH `.d.ts`
 * and `.d.cts` declarations, and `tsc -p tsconfig.json` and `ts-jest` do not
 * always resolve a nested import to the same one. When they diverge,
 * `BaseChatModel` becomes two structurally-identical but nominally-distinct
 * classes, and passing a `ChatAnthropic` to a parameter typed
 * `BaseChatModel<...>` fails with a protected-member error under one
 * toolchain while compiling cleanly under the other — a build that passes
 * `tsc` and fails `jest`, which is a genuinely confusing thing to inherit.
 *
 * Depending on the SHAPE instead makes both toolchains agree, and has the
 * side benefit of documenting exactly how much of LangChain's very large
 * surface this module relies on: two methods.
 */
interface StructuredRunnable<RunOutput> {
  invoke(input: BaseMessageLike[], options?: { timeout?: number }): Promise<RunOutput>;
}

export interface StructuredCapableChatModel {
  withStructuredOutput<RunOutput extends Record<string, unknown>>(
    outputSchema: Record<string, unknown>,
    config?: { name?: string; method?: string },
  ): StructuredRunnable<RunOutput>;

  invoke(input: BaseMessageLike[], options?: { timeout?: number }): Promise<{ content: unknown }>;
}

/**
 * The tool/schema name LangChain sends to the vendor. Providers surface it in
 * their own errors and traces, so a recognisable constant beats a generated
 * one when reading a vendor's dashboard.
 */
const STRUCTURED_OUTPUT_NAME = 'structured_result';

/**
 * Which mechanism LangChain should use to force a shape out of the model.
 *
 *   - `jsonSchema`      -> `response_format: { type: "json_schema" }`. The
 *                          strongest guarantee, but only recent OpenAI models
 *                          and a handful of compatible hosts implement it.
 *   - `functionCalling` -> a single-tool call whose arguments are the answer.
 *                          By far the most widely implemented mechanism
 *                          across the OpenAI-compatible family.
 */
export type StructuredOutputMethod = 'jsonSchema' | 'functionCalling';

/**
 * The two message roles every call uses. Built as a typed constant rather
 * than inline so the tuple form (`["system", text]`) keeps its
 * `BaseMessageLike` typing instead of widening to `string[]`.
 */
function buildMessages(system: string, user: string): BaseMessageLike[] {
  return [
    ['system', system],
    ['human', user],
  ];
}

/**
 * Path A — NATIVE structured output.
 *
 * Hands the zod schema straight to LangChain, which translates it to the
 * vendor's own mechanism (`response_format`, a tool definition, or Gemini's
 * `responseSchema`) and parses the reply back.
 *
 * The result is re-parsed through the caller's zod schema afterwards even
 * though LangChain has already parsed it. That is not redundant: LangChain's
 * `includeRaw: false` path can return a value it failed to fully validate,
 * and more importantly this makes BOTH paths (native and the JSON fallback
 * below) end at the same guarantee — `LlmProviderAdapter.complete` returns a
 * value that has passed the caller's schema, full stop. A caller never has to
 * know which path ran.
 *
 * The `as unknown as Record<string, unknown>` cast is a TYPE-level
 * accommodation only. `withStructuredOutput` constrains its output generic to
 * `Record<string, any>` (LangChain assumes an object schema), while
 * `AiContract`'s `ZodSchema<T>` leaves `T` open. At runtime LangChain calls
 * `isInteropZodSchema` on the value and takes the zod path regardless of how
 * it was typed, so the real schema — including its zod v4 internals — is what
 * reaches the vendor.
 */
export async function invokeNativeStructured<T>(
  model: StructuredCapableChatModel,
  params: LlmCompletionParams<T>,
  method: StructuredOutputMethod,
): Promise<T> {
  const structured = model.withStructuredOutput<Record<string, unknown>>(
    params.schema as unknown as Record<string, unknown>,
    { name: STRUCTURED_OUTPUT_NAME, method },
  );

  const raw: unknown = await structured.invoke(buildMessages(params.system, params.user), {
    timeout: params.timeoutMs,
  });

  return params.schema.parse(raw);
}

/**
 * Path B — JSON-MODE PROMPTING, the fallback for a host that cannot do the
 * native thing.
 *
 * Appends the schema (as JSON Schema) to the system prompt, asks for a bare
 * JSON object, then strips any markdown fence the model wrapped it in and
 * parses it through zod. Strictly weaker than path A — the model can still
 * return prose, and then this throws — which is why it is a fallback and not
 * the default.
 *
 * Used by `OpenAiCompatibleAdapter` only, and only after a native attempt has
 * failed in a way that says the host does not implement the mechanism (see
 * `looksLikeUnsupportedStructuredOutput`). Anthropic and Gemini both
 * implement their native mechanism universally across the models worth
 * configuring, so wiring a second path into them would add an untested branch
 * for a case that does not arise.
 */
export async function invokeJsonPromptFallback<T>(
  model: StructuredCapableChatModel,
  params: LlmCompletionParams<T>,
): Promise<T> {
  const system = `${params.system}\n\n${jsonInstruction(params.schema)}`;

  const reply = await model.invoke(buildMessages(system, params.user), { timeout: params.timeoutMs });

  return params.schema.parse(JSON.parse(extractJson(messageText(reply))));
}

/**
 * True when a failed native attempt looks like "this host does not implement
 * that mechanism", rather than "your key is dead" or "you are rate limited".
 *
 * Deliberately narrow. It gates a SECOND billable call on the same
 * credential, so a false positive costs the client money and doubles the
 * latency of a request that was going to fail anyway. Every pattern here
 * names a capability, and the check additionally requires a 4xx — a 500 or a
 * 429 is never a capability problem, however the body is worded.
 */
export function looksLikeUnsupportedStructuredOutput(error: unknown): boolean {
  const status = readStatus(error);
  if (status === undefined || status < 400 || status >= 500) {
    return false;
  }

  const record = asRecord(error);
  const param = typeof record.param === 'string' ? record.param : '';
  const haystack = `${param} ${readMessage(error)}`;

  const namesACapability =
    /response_format/i.test(haystack) ||
    /json[_ ]schema/i.test(haystack) ||
    /\btools?\b/i.test(haystack) ||
    /tool[_ ]choice/i.test(haystack) ||
    /function[_ ]call/i.test(haystack) ||
    /structured output/i.test(haystack);

  if (!namesACapability) return false;

  return (
    /not support/i.test(haystack) ||
    /unsupported/i.test(haystack) ||
    /unrecognized/i.test(haystack) ||
    /unknown (?:field|parameter|argument)/i.test(haystack) ||
    /invalid[_ ](?:type|value) for/i.test(haystack) ||
    /is not (?:a )?(?:valid|allowed|permitted)/i.test(haystack) ||
    // The shape several OpenAI-compatible hosts use to say they implement a
    // narrower enum than OpenAI does — e.g. DeepSeek answering a
    // `json_schema` response format with "value is not one of the allowed
    // values ['text','json_object']". Without this the fallback never fires
    // for exactly the hosts it exists for.
    /is not one of/i.test(haystack) ||
    /extra inputs are not permitted/i.test(haystack)
  );
}

/** The JSON Schema instruction appended to the system prompt on the fallback path. */
function jsonInstruction(schema: unknown): string {
  const lines = [
    'You must reply with a single JSON object and nothing else.',
    'No prose before or after it, no explanation, and no markdown code fence.',
  ];

  const jsonSchema = toJsonSchema(schema);
  if (jsonSchema !== null) {
    lines.push('The object must validate against this JSON Schema:', jsonSchema);
  }

  return lines.join('\n');
}

/**
 * zod v4 can emit JSON Schema for most, but not all, schemas — a transform or
 * a custom refinement has no JSON Schema equivalent and `toJSONSchema` throws.
 * A schema we cannot describe still gets the "reply with JSON only"
 * instruction and is still validated by zod on the way back; it just does not
 * get to tell the model the field names up front.
 */
function toJsonSchema(schema: unknown): string | null {
  try {
    return JSON.stringify(z.toJSONSchema(schema as Parameters<typeof z.toJSONSchema>[0]));
  } catch {
    return null;
  }
}

/**
 * A message's text content. `content` is either a plain string or an array of
 * typed blocks (what every provider returns once tool use or thinking blocks
 * are in play), so the array case has to be handled or the fallback path
 * would break on exactly the models most likely to need it.
 */
export function messageText(message: { content: unknown }): string {
  const { content } = message;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const text = asRecord(block).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  return '';
}

/**
 * Pulls the JSON object out of a reply that may be fenced or padded with
 * prose, despite having been asked for neither. Models do this often enough
 * that not handling it would make the fallback path fail for a formatting
 * habit rather than a real problem.
 *
 * Strips a ```json fence if present, otherwise takes the span from the first
 * `{` to the last `}`. Returns the input unchanged when neither applies, so
 * the `JSON.parse` that follows produces a real parse error rather than this
 * function inventing one.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}
