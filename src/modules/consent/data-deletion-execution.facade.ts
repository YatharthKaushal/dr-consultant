import { Injectable } from '@nestjs/common';
import type { DeletionStatus } from '../../schema/enums.schema';
import { ConsentRepository } from './consent.repository';
import type { DataDeletionExecutionContract } from './data-deletion-execution.contract';
import { DataDeletionService } from './data-deletion.service';
import type { DataDeletionRequestRecord } from './data-deletion.types';

/** See `data-deletion-execution.contract.ts`'s header for why this is a separate facade from `ConsentFacade`. */
@Injectable()
export class DataDeletionExecutionFacade implements DataDeletionExecutionContract {
  constructor(
    private readonly service: DataDeletionService,
    private readonly consents: ConsentRepository,
  ) {}

  async getRequest(requestId: string): Promise<DataDeletionRequestRecord | null> {
    return this.service.findForExecution(requestId);
  }

  async recordExecutionOutcome(
    actor: { actorType: 'admin' | 'system'; actorId: string | null },
    requestId: string,
    input: { status: Extract<DeletionStatus, 'executed' | 'failed'>; executionOutcome: unknown },
  ): Promise<DataDeletionRequestRecord> {
    return this.service.recordExecutionOutcome(actor, requestId, input);
  }

  async countConsentsForPatient(patientId: string): Promise<number> {
    return this.consents.countPatientAcceptances(patientId);
  }

  async listDueForSweep(limit: number): Promise<DataDeletionRequestRecord[]> {
    return this.service.listDueForSweep(limit);
  }

  async autoApproveForSweep(requestId: string): Promise<DataDeletionRequestRecord> {
    return this.service.autoApproveForSweep(requestId);
  }
}
