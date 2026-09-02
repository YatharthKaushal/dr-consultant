import { Injectable, ServiceUnavailableException, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { BEARER_PREFIX } from '../../shared/auth/auth.constants';
import { MCP_ERROR_CODES } from './mcp.constants';
import type { McpClientContext } from './mcp.contract';
import { McpClientService } from './mcp-client.service';
import { McpRateLimitService } from './mcp-rate-limit.service';
import { McpSettingsService } from './mcp-settings.service';

/** What this guard attaches to the request, mirroring how `JwtAuthGuard` attaches `request.auth`. */
export interface RequestWithMcpClient {
  headers: { authorization?: string };
  mcpClient?: McpClientContext;
}

/**
 * Authenticates an external MCP client from `Authorization: Bearer <key>`.
 *
 * WHY A DEDICATED GUARD RATHER THAN INLINE CHECKS IN THE CONTROLLER
 * -----------------------------------------------------------------
 * The `@Public()` marker is unavoidable either way: `JwtAuthGuard` is a
 * global `APP_GUARD`, global guards run before any route-scoped one, and it
 * would reject an MCP key as an invalid JWT before route code ever ran. An
 * MCP key is a different credential type entirely — a long-lived machine
 * secret, not a `tokenVersion`-checked user session — so routing it through
 * `AuthContextResolver` was never an option.
 *
 * Given `@Public()` is required regardless, the remaining choice is guard vs
 * handler-body checks, and the guard wins on three counts:
 *   - Authorization stays declarative, expressed the same way as every other
 *     route in this codebase (`@AccountType`, `@RequirePermission`), instead
 *     of being an `if` at the top of a handler that a future route on the
 *     same controller can forget to repeat.
 *   - It runs strictly before the handler, so an unauthenticated or
 *     rate-limited request never reaches MCP server construction or tool
 *     execution.
 *   - It composes with the existing three global guards rather than altering
 *     them: `AccountTypeGuard` and `PermissionGuard` both no-op on a route
 *     carrying no `@AccountType`/`@RequirePermission` metadata, so this slots
 *     in underneath with ZERO changes to `shared/auth`.
 *
 * The guard also owns the two request-level gates that must precede any work:
 * the `mcp.enabled` kill switch, and the per-client rate limit. Both are
 * "may this request proceed at all" questions, which is what a guard is.
 */
@Injectable()
export class McpClientGuard implements CanActivate {
  constructor(
    private readonly clients: McpClientService,
    private readonly rateLimit: McpRateLimitService,
    private readonly settings: McpSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Checked before the key is even looked at: a disabled surface should not
    // be doing database work on behalf of unauthenticated callers.
    if (!(await this.settings.isEnabled())) {
      throw new ServiceUnavailableException({
        code: MCP_ERROR_CODES.MCP_DISABLED,
        message: 'The MCP interface is not enabled on this deployment.',
      });
    }

    const request = context.switchToHttp().getRequest<RequestWithMcpClient>();
    const key = extractBearerKey(request.headers.authorization);
    if (!key) {
      throw unauthenticated();
    }

    const client = await this.clients.authenticate(key);
    if (!client) {
      throw unauthenticated();
    }

    // Only after the caller is known — an unauthenticated request must not be
    // able to write rows into the rate-limit counter table.
    await this.rateLimit.consume(client.clientId);

    request.mcpClient = client;
    return true;
  }
}

function extractBearerKey(header: string | undefined): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const key = header.slice(BEARER_PREFIX.length).trim();
  return key.length > 0 ? key : null;
}

/** One message for every authentication failure — see `McpClientService#authenticate`. */
function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException({
    code: MCP_ERROR_CODES.MCP_UNAUTHENTICATED,
    message: 'Invalid or missing MCP client key.',
  });
}
