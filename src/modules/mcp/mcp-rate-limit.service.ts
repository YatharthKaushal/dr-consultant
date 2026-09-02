import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { MCP_ERROR_CODES } from './mcp.constants';
import { McpClientRepository } from './mcp-client.repository';
import { McpSettingsService } from './mcp-settings.service';

/**
 * Per-client request budget, counted in the database.
 *
 * Follows the `otp_request_attempts` precedent exactly: write a row for the
 * attempt, count rows in the trailing window, refuse past the threshold.
 * Deliberately not an in-process counter — see
 * `mcp-request-attempts.schema.ts` for why that breaks the moment this runs
 * as more than one process.
 *
 * ORDER OF OPERATIONS: count first, then record. The recorded row is the
 * attempt that was just ALLOWED, so a client sitting exactly at the limit
 * stays refused without its refusals inflating the count further (a
 * record-then-count design lets a burst of rejected requests extend its own
 * lockout, which turns a rate limit into a self-deepening ban).
 */
@Injectable()
export class McpRateLimitService {
  constructor(
    private readonly repo: McpClientRepository,
    private readonly settings: McpSettingsService,
  ) {}

  /** Throws `MCP_RATE_LIMITED` (429, with `retryAfterSeconds`) when the client is over budget. */
  async consume(clientId: string): Promise<void> {
    const { maxRequests, windowSeconds } = await this.settings.getRateLimit();
    const since = new Date(Date.now() - windowSeconds * 1000);

    const used = await this.repo.countRequestAttemptsSince(clientId, since);
    if (used >= maxRequests) {
      throw new HttpException(
        {
          code: MCP_ERROR_CODES.MCP_RATE_LIMITED,
          message: `Rate limit exceeded: at most ${maxRequests} requests per ${windowSeconds} seconds.`,
          retryAfterSeconds: windowSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.repo.recordRequestAttempt(clientId);
  }
}
