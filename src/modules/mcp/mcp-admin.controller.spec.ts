import type { AuthContext } from '../../shared/auth/auth.types';
import type { CreatedMcpClient, PublicMcpClient } from './mcp.contract';
import { McpAdminController } from './mcp-admin.controller';
import type { McpClientService } from './mcp-client.service';

const ADMIN: AuthContext = { accountType: 'admin', accountId: 'admin-1' };

const PUBLIC_CLIENT: PublicMcpClient = {
  id: 'client-1',
  name: 'WhatsApp aggregator',
  keyPrefix: 'mcp_AbCdEfGh',
  keyLast4: 'wxyz',
  scopes: ['list_service_catalogue'],
  isActive: true,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CREATED: CreatedMcpClient = { client: PUBLIC_CLIENT, plaintextKey: 'mcp_THEPLAINTEXTKEYVALUE0123456789' };

function createDeps() {
  const clients = {
    list: jest.fn().mockResolvedValue([PUBLIC_CLIENT]),
    getById: jest.fn().mockResolvedValue(PUBLIC_CLIENT),
    create: jest.fn().mockResolvedValue(CREATED),
    update: jest.fn().mockResolvedValue(PUBLIC_CLIENT),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<McpClientService>;
  return { controller: new McpAdminController(clients), clients };
}

describe('McpAdminController', () => {
  it('lists clients', async () => {
    const { controller } = createDeps();
    await expect(controller.list()).resolves.toEqual([PUBLIC_CLIENT]);
  });

  it('gets one client', async () => {
    const { controller, clients } = createDeps();
    await controller.get('client-1');
    expect(clients.getById).toHaveBeenCalledWith('client-1');
  });

  it('creates a client, attributing the acting admin', async () => {
    const { controller, clients } = createDeps();

    await controller.create(ADMIN, { name: 'Aggregator', scopes: ['list_doctors'] });

    expect(clients.create).toHaveBeenCalledWith('admin-1', { name: 'Aggregator', scopes: ['list_doctors'] });
  });

  it('defaults an omitted scopes array to empty — fail closed', async () => {
    const { controller, clients } = createDeps();

    await controller.create(ADMIN, { name: 'Aggregator' });

    expect(clients.create).toHaveBeenCalledWith('admin-1', { name: 'Aggregator', scopes: [] });
  });

  it('updates a client, attributing the acting admin', async () => {
    const { controller, clients } = createDeps();

    await controller.update(ADMIN, 'client-1', { isActive: false });

    expect(clients.update).toHaveBeenCalledWith('admin-1', 'client-1', { isActive: false });
  });

  it('deletes a client, attributing the acting admin', async () => {
    const { controller, clients } = createDeps();

    await controller.remove(ADMIN, 'client-1');

    expect(clients.remove).toHaveBeenCalledWith('admin-1', 'client-1');
  });

  /* ---------------------------------------------------------------------- */
  /* The key is shown exactly once, by exactly one endpoint                  */
  /* ---------------------------------------------------------------------- */

  describe('no endpoint but creation ever returns a key', () => {
    it('POST /admin/mcp/clients returns the plaintext key', async () => {
      const { controller } = createDeps();

      const created = await controller.create(ADMIN, { name: 'Aggregator' });

      expect(created.plaintextKey).toBe(CREATED.plaintextKey);
    });

    it('GET (list) returns no key material', async () => {
      const { controller } = createDeps();

      const serialized = JSON.stringify(await controller.list());

      expect(serialized).not.toContain(CREATED.plaintextKey);
      expect(serialized).not.toContain('plaintextKey');
      expect(serialized).not.toContain('hashedKey');
    });

    it('GET /:id returns no key material', async () => {
      const { controller } = createDeps();

      const serialized = JSON.stringify(await controller.get('client-1'));

      expect(serialized).not.toContain(CREATED.plaintextKey);
      expect(serialized).not.toContain('hashedKey');
    });

    it('PATCH /:id returns no key material — there is no rotation endpoint that re-reveals a key', async () => {
      const { controller } = createDeps();

      const serialized = JSON.stringify(await controller.update(ADMIN, 'client-1', { isActive: true }));

      expect(serialized).not.toContain(CREATED.plaintextKey);
      expect(serialized).not.toContain('plaintextKey');
    });

    it('DELETE /:id returns nothing at all', async () => {
      const { controller } = createDeps();

      await expect(controller.remove(ADMIN, 'client-1')).resolves.toBeUndefined();
    });

    it('every read route returns only the nine public fields', async () => {
      const { controller } = createDeps();

      const listed = await controller.list();
      const fetched = await controller.get('client-1');
      const updated = await controller.update(ADMIN, 'client-1', {});

      const expected = ['createdAt', 'id', 'isActive', 'keyLast4', 'keyPrefix', 'lastUsedAt', 'name', 'scopes', 'updatedAt'];
      expect(Object.keys(listed[0]!).sort()).toEqual(expected);
      expect(Object.keys(fetched).sort()).toEqual(expected);
      expect(Object.keys(updated).sort()).toEqual(expected);
    });
  });
});
