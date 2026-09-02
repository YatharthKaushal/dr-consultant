import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import type { SearchAiPort } from './search-ai.contract';
import { SEARCH_AI_PORT, SEARCH_CONFIG_FALLBACKS, SEARCH_CONFIG_KEYS } from './search.constants';
import { toLogExcerpt } from './search-text.util';

/**
 * *** STAGE 2. THE ONLY PLACE IN THIS CODEBASE THAT CALLS A LANGUAGE MODEL. ***
 *
 * SRS §7 buys "a hosted language model for query interpretation WITH a
 * curated symptom-to-specialty mapping layer, so behaviour stays explainable
 * and admin-controllable". This service is the whole of the first half, and
 * it is deliberately small, because the model's job here is deliberately
 * small:
 *
 *   INPUT   the patient's own words, plus the live taxonomy.
 *   OUTPUT  concern CODES, specialty CODES, and one sentence of navigation
 *           prose in which every entity is a `{{...}}` TOKEN.
 *
 * The model therefore never picks a doctor, never orders results, never sees
 * a fee or a schedule, and never writes an entity name in free text. Stages
 * 3-6 are pure arithmetic over curated data. That is what makes the whole
 * feature testable, auditable and kill-switchable, and it is why an AI
 * outage degrades the quality of the mapping rather than the availability of
 * the feature.
 *
 * ---------------------------------------------------------------------------
 * THE PROMPT IS BUILT FROM LIVE TAXONOMY, NEVER FROM A HARD-CODED LIST.
 * FR-19.1 requires a specialty added in the admin panel to work with no code
 * change; FR-5.7 requires the same of the mapping and synonyms. Both are only
 * true if the model is told, at request time, what the taxonomy currently IS.
 * Adding a specialty row is therefore the entire deployment procedure for
 * teaching search about it.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE MODE ENDS IN THE DETERMINISTIC MATCHER, never in an error
 * reaching the patient: kill switch off, port unavailable, ANY throw
 * (`AI_UNAVAILABLE` included), schema-invalid output, or output whose codes
 * are all unresolvable. A patient asked where to go for help; "where to go
 * for help" is answerable from the curated taxonomy alone, so there is no
 * failure here worth showing them.
 */

/**
 * The structured shape the model must return. Bounds are enforced HERE as
 * well as by the schema the AI module applies, because a provider that
 * silently truncates or a future prompt change must not be able to widen
 * what stages 3-6 accept.
 */
export const INTERPRETATION_SCHEMA = z.object({
  /** `concerns.code` values, best first. */
  concernCodes: z.array(z.string().max(60)).max(5),
  /** `specialties.code` values — FR-5.3's "professional type". */
  professionalTypes: z.array(z.string().max(60)).max(5),
  /** One or two sentences of navigation prose. Entities appear ONLY as `{{specialty:code}}`/`{{concern:code}}`. */
  guidance: z.string().max(600),
});

export type Interpretation = z.infer<typeof INTERPRETATION_SCHEMA>;

export type InterpretationOutcome =
  | { source: 'ai'; value: Interpretation; model: string; latencyMs: number }
  /** Every fallback reason is named, so `meta.interpretation` and the logs tell the truth about which path ran and why. */
  | { source: 'deterministic'; reason: 'kill_switch' | 'unavailable' | 'call_failed' | 'invalid_output' };

const MAX_TOKENS = 500;

/**
 * The instruction half of the prompt. The taxonomy half is appended at
 * request time by `buildSystemPrompt`.
 *
 * The prohibitions are stated to the model as well as enforced after it,
 * because defence in depth is cheap here: a model that never writes
 * diagnostic language costs nothing, and `response-validator.service.ts`
 * still assumes it will.
 */
const SYSTEM_PROMPT_RULES = [
  'You route a person to the right kind of mental-health professional on a booking app. You are a navigation aid, nothing else.',
  '',
  'You MUST NOT: name, suggest or imply any medical condition or diagnosis; describe severity, urgency, risk or probability; recommend or mention any treatment, therapy or medication; tell the person what their symptoms mean.',
  'You MUST: map what they wrote onto the concern and specialty lists below, and nothing outside those lists.',
  '',
  'Return JSON with exactly these fields:',
  '  concernCodes       - up to 5 codes from the CONCERNS list, most relevant first. Use [] if nothing fits.',
  '  professionalTypes  - up to 5 codes from the SPECIALTIES list, most relevant first. Use [] if nothing fits.',
  '  guidance           - one or two short sentences telling the person which kind of professional they can talk to.',
  '',
  'In `guidance`, you may NOT write the name of any specialty or concern as ordinary words. Refer to them ONLY as tokens: {{specialty:CODE}} and {{concern:CODE}}, using codes from the lists below. Any other token, or a code that is not in the lists, will cause your whole answer to be discarded.',
  'The person may write in English, Hindi, or a mix of both, in any script. Always answer in English.',
  '',
  'Good: "You can talk to a {{specialty:psychiatry}} about {{concern:sleep}}."',
  'Bad: "You may have insomnia, which is likely mild. See a psychiatrist for medication."',
].join('\n');

/**
 * PURE. The live taxonomy, rendered for the prompt. Exported so a test can
 * assert that a newly-added specialty reaches the model with no code change
 * (FR-19.1) without constructing the service.
 */
export function buildSystemPrompt(specialties: readonly PublicSpecialty[], concerns: readonly PublicConcern[]): string {
  const specialtyById = new Map(specialties.map((specialty) => [specialty.id, specialty]));

  const specialtyLines = specialties.map((specialty) => `  ${specialty.code} - ${specialty.name}`);
  const concernLines = concerns.map((concern) => {
    const specialty = specialtyById.get(concern.specialtyId);
    // The curated synonyms are the model's cue for informal and mixed-script
    // phrasing (FR-5.1). They are also exactly what an admin edits, which is
    // how FR-5.7's "changes behaviour with no release" reaches the AI path
    // and not only the deterministic one.
    const synonyms = concern.matchPhrases.slice(0, 12).join(', ');
    const under = specialty ? ` [${specialty.code}]` : '';
    return `  ${concern.code} - ${concern.name}${under}${synonyms ? ` (also written as: ${synonyms})` : ''}`;
  });

  return [
    SYSTEM_PROMPT_RULES,
    '',
    'SPECIALTIES:',
    ...(specialtyLines.length > 0 ? specialtyLines : ['  (none configured)']),
    '',
    'CONCERNS:',
    ...(concernLines.length > 0 ? concernLines : ['  (none configured)']),
  ].join('\n');
}

@Injectable()
export class QueryInterpreterService {
  private readonly logger = new Logger(QueryInterpreterService.name);

  constructor(
    @Inject(SEARCH_AI_PORT) private readonly ai: SearchAiPort,
    private readonly appConfig: AppConfigService,
  ) {}

  /** The `search.ai_enabled` kill switch, read fresh per request (memoized 30s by `AppConfigService`) so flipping it in the admin panel takes effect without a restart. */
  async isAiEnabled(): Promise<boolean> {
    const value = await this.appConfig.getJson<unknown>(SEARCH_CONFIG_KEYS.AI_ENABLED, SEARCH_CONFIG_FALLBACKS.AI_ENABLED);
    // Defensive: `app_config.value` is untyped jsonb. Anything that is not
    // literally `true` leaves the model switched off — the safe direction
    // for a kill switch is off.
    return value === true;
  }

  /**
   * Stage 2. Returns an `ai` outcome only when the model answered AND its
   * output parsed; every other path returns a named `deterministic` reason
   * and the caller runs the matcher.
   *
   * NEVER throws for an AI reason. It CAN throw whatever
   * `beforeModelCall` throws — see that parameter's own note; that is the
   * rate limiter's 429, which must reach the patient rather than be mistaken
   * for an outage.
   *
   * @param beforeModelCall Invoked at the LAST moment before the model is
   *   actually called — after the kill switch and the availability probe
   *   have both passed. This is the hook the caller uses to spend AI budget,
   *   and its placement is the point: budget must be charged for calls that
   *   are genuinely about to happen, never for a request that the kill
   *   switch or an outage means will be served deterministically. Getting
   *   this wrong makes an AI outage throttle patients on top of degrading
   *   them, which is exactly backwards.
   */
  async interpret(
    queryText: string,
    specialties: readonly PublicSpecialty[],
    concerns: readonly PublicConcern[],
    beforeModelCall?: () => Promise<void>,
  ): Promise<InterpretationOutcome> {
    if (!(await this.isAiEnabled())) {
      return { source: 'deterministic', reason: 'kill_switch' };
    }

    // `isAvailable` is the cheap probe; it saves a round trip when every
    // credential is already known-exhausted. It is NOT a guarantee — the
    // call below is still fully guarded.
    let available = false;
    try {
      available = await this.ai.isAvailable();
    } catch (error) {
      this.logger.warn(`AI availability probe threw, treating as unavailable: ${this.describe(error)}`);
      return { source: 'deterministic', reason: 'unavailable' };
    }
    if (!available) {
      return { source: 'deterministic', reason: 'unavailable' };
    }

    // DELIBERATELY OUTSIDE the try below. A rate-limit rejection is a 429 the
    // patient must see, not an AI failure to swallow into the deterministic
    // fallback — putting this inside the catch would silently convert every
    // throttle into a degraded-but-successful search.
    if (beforeModelCall) {
      await beforeModelCall();
    }

    try {
      const result = await this.ai.completeStructured({
        system: buildSystemPrompt(specialties, concerns),
        user: queryText,
        schema: INTERPRETATION_SCHEMA,
        maxTokens: MAX_TOKENS,
      });

      // Re-parsed on this side of the port on purpose. The AI module applies
      // the schema too, but this service is what stages 3-6 trust, and
      // trusting a shape because another module promised to check it is how
      // a provider quirk becomes a patient-facing bug.
      const parsed = INTERPRETATION_SCHEMA.safeParse(result.value);
      if (!parsed.success) {
        this.logger.warn(`AI returned output failing the interpretation schema; falling back. Query: ${toLogExcerpt(queryText)}`);
        return { source: 'deterministic', reason: 'invalid_output' };
      }

      return { source: 'ai', value: parsed.data, model: result.model, latencyMs: result.latencyMs };
    } catch (error) {
      // *** ANY throw, `AI_UNAVAILABLE` included. An AI failure is never a
      // patient-visible error. *** Logged at warn, not error: the fallback
      // is a designed path, not an incident.
      this.logger.warn(`AI interpretation failed, falling back to the deterministic matcher: ${this.describe(error)}`);
      return { source: 'deterministic', reason: 'call_failed' };
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
