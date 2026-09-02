import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import type { CreatedMcpClient, PublicMcpClient } from './mcp.contract';
import { CreateMcpClientDto, UpdateMcpClientDto } from './mcp-admin.dto';
import { McpClientService } from './mcp-client.service';

/**
 * Admin CRUD for external MCP clients. Mirrors `doctor-admin.controller.ts`:
 * `@AccountType('admin')` on the class, a `@RequirePermission` per route.
 *
 * Reads need `mcp.read`; every mutation needs `mcp.manage`, which is granted
 * to `super_admin` alone — creating a client hands an outside party a live
 * credential to our catalogue and doctor directory, which is a different
 * order of decision from the day-to-day operations work `mcp.read` supports.
 */
@Controller('admin/mcp/clients')
@AccountType('admin')
export class McpAdminController {
  constructor(private readonly clients: McpClientService) {}

  @Get()
  @RequirePermission(PERMISSIONS.MCP_READ)
  list(): Promise<PublicMcpClient[]> {
    return this.clients.list();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.MCP_READ)
  get(@Param('id', createUuidValidationPipe('id')) id: string): Promise<PublicMcpClient> {
    return this.clients.getById(id);
  }

  /**
   * The ONLY response in the entire API that contains a key. It is not stored
   * anywhere, so this response is the sole opportunity to record it — see
   * `mcp.contract.ts`'s `CreatedMcpClient`.
   */
  @Post()
  @RequirePermission(PERMISSIONS.MCP_MANAGE)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateMcpClientDto): Promise<CreatedMcpClient> {
    return this.clients.create(auth.accountId, { name: dto.name, scopes: dto.scopes ?? [] });
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.MCP_MANAGE)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateMcpClientDto,
  ): Promise<PublicMcpClient> {
    return this.clients.update(auth.accountId, id, dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.MCP_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string): Promise<void> {
    return this.clients.remove(auth.accountId, id);
  }
}
