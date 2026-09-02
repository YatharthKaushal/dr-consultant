import { Injectable } from '@nestjs/common';
import { AiRotationService } from './ai-rotation.service';
import type { AiCompletionRequest, AiCompletionResult, AiContract } from './ai.contract';

/**
 * The AI gateway's only public surface. Thin by design — every decision
 * (candidate ordering, decryption, rotation, cooldowns, health) lives in
 * `AiRotationService`, and this class exists to be the one type another
 * module imports, so that swapping the local implementation for a TCP client
 * later changes nothing at any call site (`backend/README.md` §1).
 */
@Injectable()
export class AiFacade implements AiContract {
  constructor(private readonly rotation: AiRotationService) {}

  async isAvailable(): Promise<boolean> {
    return this.rotation.isAvailable();
  }

  async completeStructured<T>(req: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    return this.rotation.completeStructured(req);
  }
}
