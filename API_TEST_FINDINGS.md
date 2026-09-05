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

## Clarification (`clarification.controller.ts` / `clarification-admin.controller.ts`)

No bugs found. All 11 routes covered. CHECK #1 ("who may be asked") and
CHECK #2 ("what they may see") — both previously adversarially tested at the
service layer per the module's own header comments — were proven to hold
through the real HTTP stack: assigning a verified-but-non-expert doctor is
refused (409 `CLARIFICATION_NOT_AN_EXPERT`); an expert reading or responding
to another expert's assigned case gets 404, never 403 (no existence leak).
The de-identification guarantee (no `patientName`/`patientPhone`/
`patientAddress`/`patientEmail` field or column) held under a real
whitelist-bypass attempt — the extra fields were silently stripped by
`ValidationPipe({ whitelist: true })` and never appeared in the raw response
text or the persisted row. The full status state machine (draft -> posted ->
awaiting_response -> response_received/clarification_asked -> reviewed ->
closed) was driven end to end over real HTTP with correct 409s at each
illegal transition.

## Feedback and Complaints (`feedback.controller.ts` / `complaint.controller.ts` / `feedback-admin.controller.ts` / `complaint-admin.controller.ts`)

No bugs found. All 13 routes covered. The real `UNIQUE(consultation_id)`
constraint on `feedback` was hit by two genuine, sequential HTTP submissions
for the same consultation — the second cleanly answers 409
`FEEDBACK_ALREADY_SUBMITTED` (never a 500 from an unhandled `23505`), and the
original row is provably unmodified. The complaint state machine
(`open -> in_progress -> resolved | rejected`) enforces every documented
edge (assign is one-shot from `open` only; resolve/reject both require
`in_progress`; `resolvedAt` is set on resolve and never on reject).
`isInternal` filtering held: an admin's internal-only note appears in the
admin's own detail view but is absent — both structurally (missing from the
`messages` array) and from the raw response text of both the patient's
detail AND list views.

## Audit (`audit-admin.controller.ts`)

No bugs found. `audit.read`/`audit.export`/`config.read`/`config.manage` are
all four independently enforced (an admin holding one but not another is
refused). `ip_address` — inserted directly into `audit_log` via raw SQL to
bypass `AuditService.write` (which never accepts one) — was confirmed absent
from the raw JSON text of both `GET .../log` and `GET .../export`, not just
from a typed field. Retention-config validation (`AUDIT_RETENTION_DAYS_BOUNDS`)
enforced server-side as documented.
