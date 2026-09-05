# API Test Findings — clarification / feedback / governance / audit / data-rights

Compiled while writing real HTTP endpoint tests (`*.endpoint.spec.ts`, via `app.inject()`
against `createConfiguredApp()`) for these five modules. One entry per bug found, whether
fixed or not.

Format per entry:
- **Route**
- **Trigger** — exact request that causes it
- **Observed** — exact status/body/stack
- **Root cause**
- **Status** — `fixed` (with red/green proof location) | `found, not fixed — needs a decision` (with reasoning)

---

## Governance (`governance-admin.controller.ts`)

No bugs found. All six routes (two working queues, quality dashboard,
doctor-reliability drill-down, two CSV exports) are correctly gated on
`governance.read_queues`/`governance.read_quality`/`governance.export`
independently; dashboard numbers (`pendingCaseSummaries`, `redFlags`,
`followUpAlerts`) matched real seeded fixtures exactly (baseline-delta
verified against a shared database); CSV exports carry the correct rows,
content-type and `Content-Disposition`; `GET .../doctors/:doctorId/reliability`
404s cleanly for a well-formed but non-existent doctor id.

## Audit (`audit-admin.controller.ts`)

No bugs found. `audit.read`/`audit.export`/`config.read`/`config.manage` are
all four independently enforced (an admin holding one but not another is
refused). `ip_address` — inserted directly into `audit_log` via raw SQL to
bypass `AuditService.write` (which never accepts one) — was confirmed absent
from the raw JSON text of both `GET .../log` and `GET .../export`, not just
from a typed field. Retention-config validation (`AUDIT_RETENTION_DAYS_BOUNDS`)
enforced server-side as documented.
