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

  it('executeForRequest delegates to the service', async () => {
    const { facade, service } = createDeps();
    service.executeForRequest.mockResolvedValue({ requestId: 'r1', status: 'executed' } as never);

    await expect(facade.executeForRequest('r1', 'admin-1')).resolves.toEqual({ requestId: 'r1', status: 'executed' });
    expect(service.executeForRequest).toHaveBeenCalledWith('r1', 'admin-1');
  });
});
