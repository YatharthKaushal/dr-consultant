import { Injectable } from '@nestjs/common';
import type { ExecutionActor } from './data-rights.service';
import { DataRightsService } from './data-rights.service';
import type { DataRightsExecutionResult, DataRightsPreview } from './data-rights.types';

/**
 * Thin wrapper over `DataRightsService`, matching every other module's
 * `<domain>.facade.ts` shape in this codebase — kept even though nothing
 * outside this module calls it today (the admin controller could call the
 * service directly, the way `GovernanceModule`'s controller does) because
 * every already-merged owning module's M-21 additive methods document
 * themselves against `DataRightsFacade#previewExecution` by name; this
 * class is what makes that name real rather than aspirational.
 */
@Injectable()
export class DataRightsFacade {
  constructor(private readonly service: DataRightsService) {}

  /** See `DataRightsService#previewExecution`. Writes nothing. */
  async previewExecution(requestId: string): Promise<DataRightsPreview> {
    return this.service.previewExecution(requestId);
  }

  /** See `DataRightsService#executeForRequest`. `options.override` is ADDITIVE (open-obligations round) — admin-only by construction, see that method's own doc comment. */
  async executeForRequest(requestId: string, actor: ExecutionActor, options?: { override?: boolean }): Promise<DataRightsExecutionResult> {
    return this.service.executeForRequest(requestId, actor, options);
  }
}
