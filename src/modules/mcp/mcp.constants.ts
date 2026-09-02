/** `audit_log.entity_type` values this module writes. */
export const MCP_AUDIT_ENTITY_TYPES = {
  CLIENT: 'mcp_client',
} as const;

export const MCP_ERROR_CODES = {
  /** No/!Bearer Authorization header, unknown key, wrong key, or a deactivated client — one code for all of them, deliberately (see `mcp-client.service.ts`). */
  MCP_UNAUTHENTICATED: 'MCP_UNAUTHENTICATED',
  /** The whole MCP surface is switched off via `mcp.enabled`. */
  MCP_DISABLED: 'MCP_DISABLED',
  /** Per-client request budget exhausted. Carries `retryAfterSeconds`, like identity's OTP limiter. */
  MCP_RATE_LIMITED: 'MCP_RATE_LIMITED',
  CLIENT_NOT_FOUND: 'MCP_CLIENT_NOT_FOUND',
  CLIENT_NAME_TAKEN: 'MCP_CLIENT_NAME_TAKEN',
  /** A `scopes` entry that is not a known tool name. */
  UNKNOWN_SCOPE: 'MCP_UNKNOWN_SCOPE',
} as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/** `app_config` keys this module reads, via `AppConfigService`. */
export const MCP_CONFIG_KEYS = {
  ENABLED: 'mcp.enabled',
  RATE_LIMIT_MAX_REQUESTS: 'mcp.rate_limit.max_requests_per_window',
  RATE_LIMIT_WINDOW_SECONDS: 'mcp.rate_limit.window_seconds',
} as const;

/**
 * Compiled-in fallbacks, same discipline as
 * `AVAILABILITY_CONFIG_FALLBACKS` — a missing or malformed `app_config` row
 * degrades to these rather than breaking.
 *
 * ENABLED DEFAULTS TO **FALSE**, deliberately. This is an externally-reachable
 * surface that hands a third-party machine our specialty catalogue, fee
 * ranges and doctor directory, and its intended consumer (a WhatsApp
 * automation aggregator) is not built. Defaulting to on would mean every
 * deploy from the moment this merges is serving that surface before anyone
 * has decided to expose it, and before a single `mcp_clients` row exists to
 * use it — an open door with nobody expected to walk through it. Turning it
 * on is one `app_config` row, made deliberately, and auditable; turning it
 * off after an incident is not a thing you want to be doing for the first
 * time during the incident.
 */
export const MCP_CONFIG_FALLBACKS = {
  ENABLED: false,
  RATE_LIMIT_MAX_REQUESTS: 120,
  RATE_LIMIT_WINDOW_SECONDS: 60,
} as const;

/** Path the MCP endpoint is mounted at, under `main.ts`'s global `/api` prefix. */
export const MCP_ROUTE_PATH = 'mcp';

/** Advertised to clients in the MCP `initialize` handshake. */
export const MCP_SERVER_INFO = {
  name: 'dr-consultation-tools',
  version: '1.0.0',
} as const;
