import { DataRightsFacade } from './data-rights.facade';
import type { DataRightsService } from './data-rights.service';

function createDeps() {
  const service = {
    previewExecution: jest.fn(),
    executeForRequest: jest.fn(),
  } as unknown as jest.Mocked<DataRightsService>;
  const facade = new DataRightsFacade(service);
  return { facade, service };
}

describe('DataRightsFacade', () => {
  it('previewExecution delegates to the service', async () => {
    const { facade, service } = createDeps();
    service.previewExecution.mockResolvedValue({ requestId: 'r1' } as never);

    await expect(facade.previewExecution('r1')).resolves.toEqual({ requestId: 'r1' });
    expect(service.previewExecution).toHaveBeenCalledWith('r1');
  });

  it('executeForRequest delegates to the service, options undefined when omitted', async () => {
    const { facade, service } = createDeps();
    service.executeForRequest.mockResolvedValue({ requestId: 'r1', status: 'executed' } as never);

    const actor = { actorType: 'admin' as const, actorId: 'admin-1' };
    await expect(facade.executeForRequest('r1', actor)).resolves.toEqual({ requestId: 'r1', status: 'executed' });
    expect(service.executeForRequest).toHaveBeenCalledWith('r1', actor, undefined);
  });

  it('executeForRequest passes options.override through unchanged — ADDITIVE (open-obligations round)', async () => {
    const { facade, service } = createDeps();
    service.executeForRequest.mockResolvedValue({ requestId: 'r1', status: 'executed' } as never);

    const actor = { actorType: 'admin' as const, actorId: 'admin-1' };
    await facade.executeForRequest('r1', actor, { override: true });
    expect(service.executeForRequest).toHaveBeenCalledWith('r1', actor, { override: true });
  });
});
