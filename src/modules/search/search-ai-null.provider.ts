import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AiCompletionRequest, AiCompletionResult, SearchAiPort } from './search-ai.contract';

/**
 * The null-object bound to `SEARCH_AI_PORT` until `modules/ai` is merged —
 * the direct counterpart of `consultation-busy-interval.provider.ts`, which
 * stands in for M-11 in exactly the same way.
 *
 * It reports unavailable and throws `AI_UNAVAILABLE` if called anyway, which
 * are precisely the two conditions `query-interpreter.service.ts` already
 * has to handle. The consequence is deliberate and worth stating plainly:
 * with no AI module present, M-09 is fully functional — every endpoint
 * answers, and every answer comes from the deterministic concern matcher.
 * That is the same code path the `search.ai_enabled` kill switch takes, so
 * the fallback is exercised in production from day one rather than being a
 * branch nobody runs until an outage.
 */
@Injectable()
export class SearchAiNullProvider implements SearchAiPort {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async completeStructured<T>(_request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    throw new ServiceUnavailableException({
      code: 'AI_UNAVAILABLE',
      message: 'No AI provider is configured.',
    });
  }
}
