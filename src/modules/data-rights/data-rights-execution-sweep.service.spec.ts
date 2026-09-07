/**
 * `DataRightsExecutionSweepService.sweep()` — the grace-period auto-execute
 * pass. `new DataRightsExecutionSweepService(mockedDeps)`, never
 * `Test.createTestingModule`. Timer scheduling itself
 * (`onModuleInit`/`onApplicationShutdown`) is not exercised here — see
 * `pricing-quote-sweep.service.spec.ts` for why that half is conventionally
 * left to manual/integration verification in this codebase: a live
 * `setInterval` is not something a unit test usefully asserts on.
 */
import type { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import type { DataDeletionRequestRecord } from '../consent/data-deletion.types';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import { DataRightsExecutionSweepService } from './data-rights-execution-sweep.service';
import type { DataRightsService } from './data-rights.service';

function request(overrides: Partial<DataDeletionRequestRecord> = {}): DataDeletionRequestRecord {
  return {
    id: 'r1',
    patientId: 'p1',
    doctorId: null,
    status: 'requested',
    reason: null,
    reviewedByAdminId: null,
    reviewedAt: null,
    reviewNote: null,
    executedAt: null,
    executionOutcome: null,
    scheduledFor: new Date().toISOString(),
    cancelledAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createDeps() {
  const deletionRequests = {
    listDueForSweep: jest.fn().mockResolvedValue([]),
    autoApproveForSweep: jest.fn(),
  } as unknown as jest.Mocked<DataDeletionExecutionFacade>;

  const dataRights = { executeForRequest: jest.fn() } as unknown as jest.Mocked<DataRightsService>;

  const appConfig = { getJson: jest.fn().mockResolvedValue(true), getNumber: jest.fn() } as unknown as jest.Mocked<AppConfigService>;

  const service = new DataRightsExecutionSweepService(deletionRequests, dataRights, appConfig);
  return { service, deletionRequests, dataRights, appConfig };
}

describe('DataRightsExecutionSweepService.sweep', () => {
  it('auto-approves a still-requested/in_review request, then executes it, as the system actor', async () => {
    const { service, deletionRequests, dataRights } = createDeps();
    deletionRequests.listDueForSweep.mockResolvedValue([request({ status: 'requested' })]);

    const result = await service.sweep();

    expect(deletionRequests.autoApproveForSweep).toHaveBeenCalledWith('r1');
    expect(dataRights.executeForRequest).toHaveBeenCalledWith('r1', { actorType: 'system', actorId: null });
    expect(result).toEqual({ examined: 1, executed: 1, failed: 0, deferred: 0 });
  });

  it('does not auto-approve an already-approved request — goes straight to execute', async () => {
    const { service, deletionRequests, dataRights } = createDeps();
    deletionRequests.listDueForSweep.mockResolvedValue([request({ status: 'approved' })]);

    await service.sweep();

    expect(deletionRequests.autoApproveForSweep).not.toHaveBeenCalled();
    expect(dataRights.executeForRequest).toHaveBeenCalledWith('r1', { actorType: 'system', actorId: null });
  });

  it('one request failing does not stop the others in the same pass', async () => {
    const { service, deletionRequests, dataRights } = createDeps();
    deletionRequests.listDueForSweep.mockResolvedValue([request({ id: 'r1' }), request({ id: 'r2' })]);
    dataRights.executeForRequest.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    dataRights.executeForRequest.mockResolvedValueOnce(undefined as never); // r2's own call, after the mockImplementationOnce is consumed by r1

    const result = await service.sweep();

    expect(dataRights.executeForRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ examined: 2, executed: 1, failed: 1, deferred: 0 });
  });

  it('respects compliance.deletion_auto_execute=false — reports every due request as deferred, touches nothing', async () => {
    const { service, deletionRequests, dataRights, appConfig } = createDeps();
    appConfig.getJson.mockResolvedValue(false);
    deletionRequests.listDueForSweep.mockResolvedValue([request(), request({ id: 'r2' })]);

    const result = await service.sweep();

    expect(deletionRequests.autoApproveForSweep).not.toHaveBeenCalled();
    expect(dataRights.executeForRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ examined: 2, executed: 0, failed: 0, deferred: 2 });
  });

  it('nothing due is a clean no-op', async () => {
    const { service, dataRights } = createDeps();
    const result = await service.sweep();
    expect(result).toEqual({ examined: 0, executed: 0, failed: 0, deferred: 0 });
    expect(dataRights.executeForRequest).not.toHaveBeenCalled();
  });
});
