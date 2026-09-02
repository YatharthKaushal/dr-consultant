import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { McpClientRow } from '../../schema/mcp-clients.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { ToolRegistry } from '../search/tools/search-tool.registry';
import { MCP_ERROR_CODES } from './mcp.constants';
import { McpClientRepository } from './mcp-client.repository';
import { McpClientService } from './mcp-client.service';
import { hashMcpKey } from './mcp-client-key.util';

jest.setTimeout(30_000);

function clientRow(overrides: Partial<McpClientRow> = {}): McpClientRow {
  return {
    id: 'client-1',
    name: 'WhatsApp aggregator',
    hashedKey: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    keyPrefix: 'mcp_AbCdEfGh',
    keyLast4: 'wxyz',
    scopes: ['list_service_catalogue'],
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findByName: jest.fn(),
    findByKeyPrefix: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    touchLastUsed: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<McpClientRepository>;

  const registry = {
    has: jest.fn().mockReturnValue(true),
    listNames: jest.fn().mockReturnValue(['list_service_catalogue', 'get_service_details']),
  } as unknown as jest.Mocked<ToolRegistry>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  return { service: new McpClientService(repo, registry, audit), repo, registry, audit };
}

describe('McpClientService', () => {
  describe('create', () => {
    it('returns the plaintext key exactly once, alongside the public client', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockImplementation(async (data) => clientRow(data as Partial<McpClientRow>));

      const result = await service.create('admin-1', { name: 'Aggregator', scopes: ['list_service_catalogue'] });

      expect(result.plaintextKey).toMatch(/^mcp_/);
      expect(result.client.name).toBe('Aggregator');
    });

    it('stores a hash, never the plaintext key', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockImplementation(async (data) => clientRow(data as Partial<McpClientRow>));

      const result = await service.create('admin-1', { name: 'Aggregator', scopes: [] });
      const written = repo.create.mock.calls[0]![0];

      expect(written.hashedKey).not.toBe(result.plaintextKey);
      expect(written.hashedKey).toMatch(/^scrypt\$/);
      expect(JSON.stringify(written)).not.toContain(result.plaintextKey.slice(4));
    });

    it('never writes key material into the audit log', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockImplementation(async (data) => clientRow(data as Partial<McpClientRow>));

      const result = await service.create('admin-1', { name: 'Aggregator', scopes: [] });
      const entry = audit.write.mock.calls[0]![0];
      const serialized = JSON.stringify(entry);

      expect(serialized).not.toContain(result.plaintextKey);
      expect(serialized).not.toContain('scrypt$');
      expect(serialized).not.toContain('hashedKey');
    });

    it('audits the creation with before/after', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockImplementation(async (data) => clientRow(data as Partial<McpClientRow>));

      await service.create('admin-1', { name: 'Aggregator', scopes: [] });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'create',
          entityType: 'mcp_client',
          metadata: expect.objectContaining({ before: null }),
        }),
      );
    });

    it('defaults to no scopes, so a client created carelessly can call nothing', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockImplementation(async (data) => clientRow(data as Partial<McpClientRow>));

      const result = await service.create('admin-1', { name: 'Aggregator', scopes: [] });

      expect(result.client.scopes).toEqual([]);
    });

    it('rejects a scope that is not a known tool name', async () => {
      const { service, registry } = createDeps();
      registry.has.mockReturnValue(false);

      await expect(service.create('admin-1', { name: 'Aggregator', scopes: ['typo_tool'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('names the valid tools when a scope is rejected', async () => {
      const { service, registry } = createDeps();
      registry.has.mockReturnValue(false);

      try {
        await service.create('admin-1', { name: 'Aggregator', scopes: ['typo_tool'] });
        fail('expected rejection');
      } catch (error) {
        const body = (error as BadRequestException).getResponse() as { code: string; message: string };
        expect(body.code).toBe(MCP_ERROR_CODES.UNKNOWN_SCOPE);
        expect(body.message).toContain('typo_tool');
      }
    });

    it('rejects a duplicate name', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(clientRow());

      await expect(service.create('admin-1', { name: 'WhatsApp aggregator', scopes: [] })).rejects.toBeInstanceOf(ConflictException);
    });

    it('converts a concurrent unique-violation into the same conflict', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(null);
      repo.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(service.create('admin-1', { name: 'Aggregator', scopes: [] })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('list / getById', () => {
    it('never exposes hashedKey in a listing', async () => {
      const { service, repo } = createDeps();
      repo.list.mockResolvedValue([clientRow({ hashedKey: 'scrypt$16384$8$1$c2FsdA==$U0VDUkVU' })]);

      const clients = await service.list();

      expect(JSON.stringify(clients)).not.toContain('scrypt$');
      expect(clients[0]).not.toHaveProperty('hashedKey');
    });

    it('never exposes hashedKey from getById', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(clientRow());

      const client = await service.getById('client-1');

      expect(client).not.toHaveProperty('hashedKey');
      expect(client).toMatchObject({ keyPrefix: 'mcp_AbCdEfGh', keyLast4: 'wxyz' });
    });

    it('throws CLIENT_NOT_FOUND for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('audits before/after without key material', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(clientRow({ scopes: ['list_service_catalogue'] }));
      repo.update.mockResolvedValue(clientRow({ scopes: ['get_service_details'] }));

      await service.update('admin-1', 'client-1', { scopes: ['get_service_details'] });

      const entry = audit.write.mock.calls[0]![0];
      expect(entry).toMatchObject({ action: 'update', entityType: 'mcp_client' });
      expect(JSON.stringify(entry)).not.toContain('scrypt$');
      expect(entry.metadata).toMatchObject({
        before: expect.objectContaining({ scopes: ['list_service_catalogue'] }),
        after: expect.objectContaining({ scopes: ['get_service_details'] }),
      });
    });

    it('is a no-op (no write, no audit) for an empty patch', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(clientRow());

      await service.update('admin-1', 'client-1', {});

      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('validates scopes on update too', async () => {
      const { service, registry } = createDeps();
      registry.has.mockReturnValue(false);

      await expect(service.update('admin-1', 'client-1', { scopes: ['bad'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects renaming onto an existing name', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(clientRow({ id: 'client-1', name: 'A' }));
      repo.findByName.mockResolvedValue(clientRow({ id: 'client-2', name: 'B' }));

      await expect(service.update('admin-1', 'client-1', { name: 'B' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws CLIENT_NOT_FOUND for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.update('admin-1', 'nope', { isActive: false })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deactivation is the revocation path — the row survives for its audit history', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(clientRow({ isActive: true }));
      repo.update.mockResolvedValue(clientRow({ isActive: false }));

      const result = await service.update('admin-1', 'client-1', { isActive: false });

      expect(result.isActive).toBe(false);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes and audits with the before state', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(clientRow());

      await service.remove('admin-1', 'client-1');

      expect(repo.delete).toHaveBeenCalledWith('client-1');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', metadata: expect.objectContaining({ after: null }) }));
    });

    it('never writes key material on delete either', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(clientRow({ hashedKey: 'scrypt$16384$8$1$c2FsdA==$U0VDUkVU' }));

      await service.remove('admin-1', 'client-1');

      expect(JSON.stringify(audit.write.mock.calls[0]![0])).not.toContain('scrypt$');
    });

    it('throws CLIENT_NOT_FOUND for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.remove('admin-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  describe('authenticate', () => {
    const KEY = 'mcp_TestKeyValue_0123456789abcdefghij';

    it('accepts a valid key and returns the client context', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY), scopes: ['list_doctors'] }));

      const result = await service.authenticate(KEY);

      expect(result).toEqual({ clientId: 'client-1', name: 'WhatsApp aggregator', scopes: ['list_doctors'] });
    });

    it('looks the row up by the key prefix', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(null);

      await service.authenticate(KEY);

      expect(repo.findByKeyPrefix).toHaveBeenCalledWith(KEY.slice(0, 12));
    });

    it('rejects an invalid key', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY) }));

      await expect(service.authenticate('mcp_TestKeyValue_WRONGWRONGWRONGWRONG')).resolves.toBeNull();
    });

    it('rejects a key whose prefix matches no client', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(null);

      await expect(service.authenticate(KEY)).resolves.toBeNull();
    });

    it('rejects a valid key belonging to an INACTIVE client', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY), isActive: false }));

      await expect(service.authenticate(KEY)).resolves.toBeNull();
    });

    it('returns the same null for every failure reason — no reconnaissance', async () => {
      const { service, repo } = createDeps();

      repo.findByKeyPrefix.mockResolvedValueOnce(null);
      const unknown = await service.authenticate(KEY);

      repo.findByKeyPrefix.mockResolvedValueOnce(clientRow({ hashedKey: await hashMcpKey(KEY), isActive: false }));
      const inactive = await service.authenticate(KEY);

      repo.findByKeyPrefix.mockResolvedValueOnce(clientRow({ hashedKey: await hashMcpKey('mcp_SomethingElse_000000') }));
      const wrongKey = await service.authenticate(KEY);

      expect(unknown).toBeNull();
      expect(inactive).toBeNull();
      expect(wrongKey).toBeNull();
    });

    it('spends scrypt work even when no row matched, so latency is not an oracle', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(null);

      const started = process.hrtime.bigint();
      await service.authenticate(KEY);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      expect(elapsedMs).toBeGreaterThan(1);
    });

    it('stamps last_used_at on success', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY) }));

      await service.authenticate(KEY);

      expect(repo.touchLastUsed).toHaveBeenCalledWith('client-1');
    });

    it('still authenticates when the last_used_at write fails', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY) }));
      repo.touchLastUsed.mockRejectedValue(new Error('db down'));

      await expect(service.authenticate(KEY)).resolves.not.toBeNull();
    });

    it('does not stamp last_used_at for a failed authentication', async () => {
      const { service, repo } = createDeps();
      repo.findByKeyPrefix.mockResolvedValue(clientRow({ hashedKey: await hashMcpKey(KEY), isActive: false }));

      await service.authenticate(KEY);

      expect(repo.touchLastUsed).not.toHaveBeenCalled();
    });
  });
});
