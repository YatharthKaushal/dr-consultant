import { Injectable } from '@nestjs/common';
import type { McpClientContext, PublicMcpClient } from './mcp.contract';
import { McpClientService } from './mcp-client.service';

/**
 * MCP's public surface. Deliberately narrow — nothing else in the codebase
 * consumes this module today, and the two methods here are the only ones a
 * plausible near-term consumer needs: a governance/audit screen listing which
 * external integrations exist, and a caller that has already been handed a
 * key needing it resolved.
 *
 * There is no facade method that returns key material, and no method that
 * creates a client — creation is an audited admin action that belongs to the
 * admin controller, not to a surface another module could call.
 */
@Injectable()
export class McpFacade {
  constructor(private readonly clients: McpClientService) {}

  /** Every registered external MCP client. Never includes key material. */
  async listClients(): Promise<PublicMcpClient[]> {
    return this.clients.list();
  }

  /** Verifies a presented key. `null` for every failure reason — see `McpClientService#authenticate`. */
  async authenticate(presentedKey: string): Promise<McpClientContext | null> {
    return this.clients.authenticate(presentedKey);
  }
}
