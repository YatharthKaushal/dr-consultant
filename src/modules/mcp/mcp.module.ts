import { Module } from '@nestjs/common';
import { SearchToolModule } from '../search/tools/search-tool.module';
import { McpAdminController } from './mcp-admin.controller';
import { McpClientGuard } from './mcp-client.guard';
import { McpClientRepository } from './mcp-client.repository';
import { McpClientService } from './mcp-client.service';
import { McpController } from './mcp.controller';
import { McpFacade } from './mcp.facade';
import { McpRateLimitService } from './mcp-rate-limit.service';
import { McpServerAdapter } from './mcp-server.adapter';
import { McpSettingsService } from './mcp-settings.service';

/**
 * The MCP transport module: owns `mcp_clients` and `mcp_request_attempts`,
 * the admin CRUD over them, client authentication, and the Streamable HTTP
 * endpoint that exposes the tool registry to external clients.
 *
 * It owns NO tools. Every tool lives in `SearchToolModule` and is reached
 * through `ToolRegistry`, which is what keeps "written once, exposed twice"
 * true: this module is a transport, and swapping it out would not change a
 * single tool.
 *
 * `McpClientGuard` is a provider (not an `APP_GUARD`) — it is route-scoped
 * via `@UseGuards` on `McpController` and must never apply globally. See its
 * own doc comment for why a guard rather than in-handler checks.
 *
 * Not `@Global()`, and `DATABASE`/`AuditService`/`AppConfigService` need no
 * `imports` here since all three are already `@Global()` — same as
 * `DoctorModule`/`CatalogueModule`/`AvailabilityModule`.
 */
@Module({
  imports: [SearchToolModule],
  controllers: [McpController, McpAdminController],
  providers: [
    McpClientRepository,
    McpClientService,
    McpSettingsService,
    McpRateLimitService,
    McpServerAdapter,
    McpClientGuard,
    McpFacade,
  ],
  exports: [McpFacade],
})
export class McpModule {}
