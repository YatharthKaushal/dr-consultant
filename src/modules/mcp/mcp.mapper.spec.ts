import type { McpClientRow } from '../../schema/mcp-clients.schema';
import { toPublicMcpClient } from './mcp.mapper';

function row(overrides: Partial<McpClientRow> = {}): McpClientRow {
  return {
    id: 'client-1',
    name: 'WhatsApp aggregator',
    hashedKey: 'scrypt$16384$8$1$c2FsdHNhbHQ=$VEhJU0lTVEhFU0VDUkVU',
    keyPrefix: 'mcp_AbCdEfGh',
    keyLast4: 'wxyz',
    scopes: ['list_service_catalogue'],
    isActive: true,
    lastUsedAt: new Date('2026-02-01T10:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toPublicMcpClient', () => {
  it('projects the identification and configuration fields', () => {
    expect(toPublicMcpClient(row())).toEqual({
      id: 'client-1',
      name: 'WhatsApp aggregator',
      keyPrefix: 'mcp_AbCdEfGh',
      keyLast4: 'wxyz',
      scopes: ['list_service_catalogue'],
      isActive: true,
      lastUsedAt: '2026-02-01T10:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('NEVER carries hashedKey out of the module', () => {
    const client = toPublicMcpClient(row());

    expect(client).not.toHaveProperty('hashedKey');
    expect(JSON.stringify(client)).not.toContain('scrypt$');
    expect(JSON.stringify(client)).not.toContain('VEhJU0lTVEhFU0VDUkVU');
  });

  it('returns exactly nine fields, whatever the row grows', () => {
    const withExtra = { ...row(), someFutureSecret: 'must not escape' } as McpClientRow;

    const client = toPublicMcpClient(withExtra);

    expect(Object.keys(client).sort()).toEqual(['createdAt', 'id', 'isActive', 'keyLast4', 'keyPrefix', 'lastUsedAt', 'name', 'scopes', 'updatedAt']);
    expect(JSON.stringify(client)).not.toContain('must not escape');
  });

  it('renders a never-used client as lastUsedAt null', () => {
    expect(toPublicMcpClient(row({ lastUsedAt: null })).lastUsedAt).toBeNull();
  });

  it('serialises timestamps as ISO strings, so the facade stays JSON-safe', () => {
    const client = toPublicMcpClient(row());
    expect(typeof client.createdAt).toBe('string');
    expect(typeof client.updatedAt).toBe('string');
  });
});
