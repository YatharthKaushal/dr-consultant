# API Test Findings — compiled across all endpoint-test worktrees

Findings from writing the first real-HTTP (`app.inject()` through
`createConfiguredApp()`) endpoint tests for every module in this codebase.
One entry per bug, whether fixed or not. Compiled across parallel worktrees
for follow-up.

Status legend:
- **FIXED** — root-cause fix applied, with a RED test against the old code
  and GREEN after the fix.
- **FOUND, NOT FIXED — needs a decision** — real bug, but the correct fix is
  non-trivial, needs a product/design decision, or exceeds "only touch what
  a genuine bug requires." Left as-is deliberately, not patched around.

---

## Group: booking / payment / pricing / promotion

### 1. Shared test DB's `permissions` catalog was stale — `promotions.*`/`affiliates.*` keys missing

**Status: FIXED (by re-running the idempotent seed script — not an application code bug).**

**Route affected:** every `admin/promotions/*` and `admin/promotions/affiliates/*` route (all gated by `promotions.read`, `promotions.manage`, `promotions.export`, `affiliates.read`, `affiliates.manage`, or `affiliates.settle`).

**Exact trigger:** mint an admin JWT, grant it a `promotions.read` (or any `promotions.*`/`affiliates.*`) permission by looking up the permission's id from the `permissions` table and inserting an `admin_permission_grants` row. The lookup (`select id from permissions where key = 'promotions.read'`) returned zero rows.

**Observed failure:** every `promotion.endpoint.spec.ts` test failed in `beforeAll` with a thrown fixture-precondition error:
```
Fixture precondition failed: permission "promotions.read" not found — run identity.seed.ts first.
```

**Root cause:** `permission.catalog.ts` defines 58 permission keys including 6 `PROMOTIONS_*`/`AFFILIATES_*` ones, but `identity.seed.ts` (idempotent, insert-only) had only ever been run against this shared Postgres database before those 6 existed in code — the `permissions` table had exactly 52 rows. `PermissionGuard#hasAllPermissions` correctly resolves "0 matching permission rows" the same way it resolves a genuinely revoked permission — there's no way to distinguish "lacks the permission" from "permission doesn't exist in the catalog yet," and it shouldn't need to, since the catalog is meant to be kept in sync by re-running the seed after a code change adds a key.

**Fix applied:** ran `npm run db:seed` (`identity.seed.ts`) against the shared database:
```
identity.seed: done — {"permissions":58,"roles":6,"rolePermissionsAdded":14,"rolePermissionsRemoved":0,"bootstrapAdminCreated":true}
```
Added the 6 missing permission rows and their 14 role-bundle memberships, without touching any pre-existing row.

**Side effect worth flagging, not a bug:** the same seed run's `BOOTSTRAP_SUPER_ADMIN_MOBILE` step created a `super_admin` admin row since none existed yet (`bootstrapAdminCreated: true`) — a persistent row in the shared database from here on, working as designed.

**Why FIXED not "needs a decision":** exactly what the seed script's re-runnable, insert-only design exists for. No application source file was touched.

---

## Group: identity / consent / patient / doctor / catalogue / availability

Format per finding: route, exact request, exact observed failure, root cause, disposition.

### Module status summary
- **catalogue**: 45 cases, all pass against current code. No bugs found.
- **consent**: 61 cases, all pass against current code. No bugs found.
- **patient**: 26 cases. One bug found and fixed (below).
- **identity**: 53 cases, all pass against current code. No bugs found — OTP flow, token refresh, logout-all, and the full admin RBAC surface all behave exactly as documented. `LAST_SUPER_ADMIN` (409) is NOT independently exercised: triggering it for real would require driving the shared, seeded `super_admin` row's holder count to zero in a database five other parallel worktrees also use — an unacceptable blast radius for a check whose whole job is preventing exactly that. `CANNOT_MODIFY_SELF`, `ROLE_NOT_FOUND`, `PERMISSION_NOT_FOUND`, `ADMIN_NOT_FOUND`, `MOBILE_NUMBER_TAKEN` all covered directly.
- **doctor**: 67 cases, all pass against current code. No bugs found. Covers the full verification→listing→fee→expert-role→specialty-assignment state machine, session revocation on rejection, a real multipart/form-data document upload (first in this codebase over real HTTP), three split-permission proofs. One call deliberately left UNMOCKED to record real environment behavior: with no S3/Cloudinary credentials, a fully valid upload reaches `StorageFacade.store()` and gets an honest 503 `DOCTOR_DOCUMENT_UPLOAD_FAILED` — not a bug, recorded so it isn't mistaken for one.
- **availability**: 43 cases, all pass against current code. No bugs found. Covers the weekly-schedule atomic replace, override/block shape and overlap rules, the `RULE_NOT_FOUND` ownership-leak collapse (another doctor's rule id gets the identical 404 a nonexistent id gets), the real `scheduling.min_notice_minutes`/`scheduling.max_slot_query_days` trap read from `app_config`, an unbookable doctor's slot routes degrading to `[]`, and the `AVAILABILITY_READ` vs `AVAILABILITY_MANAGE` split.

### `patient-admin.controller.ts` — malformed `:id` 500s instead of 400

- **Route:** `GET /api/admin/patients/:id` and `PATCH /api/admin/patients/:id/status`
- **Request:** `GET /api/admin/patients/not-a-uuid` (admin token holding `patients.read`); same shape for the PATCH route with `patients.manage_status`.
- **Observed (RED, before fix):** `500 { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred. Please try again." } }`. Server log showed a raw Postgres error surfacing through `HttpExceptionFilter`'s catch-all — `invalid input syntax for type uuid: "not-a-uuid"` (`22P02`), because `@Param('id') id: string` passed the raw path segment straight to `eq(patientsTable.id, id)` against a `uuid` column with no validation in between.
- **Root cause:** `patient-admin.controller.ts`'s two `:id`-taking routes were missing `createUuidValidationPipe('id')` — every sibling admin controller (`doctor-admin.controller.ts`, `legal-document-admin.controller.ts`, `data-deletion-admin.controller.ts`, etc.) already uses this pipe for exactly this reason.
- **Disposition:** **FIXED.** Added `createUuidValidationPipe('id')` to both `@Param('id')` decorators in `src/modules/patient/patient-admin.controller.ts`. Verified RED (both malformed-id tests failed with `500`) then GREEN (full `patient.endpoint.spec.ts` — 26/26 pass, both malformed-id cases now returning `400 VALIDATION_FAILED`). Genuine root-cause fix — the same guard every sibling route already has.

---

## Group: search / notification / document / storage / carehub / ai / mcp

**Total: 65 routes, 165 tests, all passing.**

### 1. `GET /api/care-hub/shared/:token` 414'd for every real share-link token ever minted

- **Status: FIXED — this made the entire FR-15.5 caregiver-guide share feature unreachable in production.**
- **Route:** `GET /api/care-hub/shared/:token`
- **Request:** any real signed share token minted by `CarehubService` (126 characters).
- **Observed (RED, before fix):** `414 Request-URI Too Long` from Fastify itself, before the route handler ever ran — Fastify's default `maxParamLength` is 100 characters, and every real token this module mints is 126.
- **Root cause:** `src/app.bootstrap.ts` constructs `new FastifyAdapter(...)` with no `maxParamLength` override, so Fastify's 100-char default silently rejected any URL param longer than that — a limit nothing in this codebase had ever hit before this module minted long signed tokens as path params.
- **Disposition:** **FIXED.** Added `maxParamLength: 200` to the `FastifyAdapter` options in `src/app.bootstrap.ts`. RED: 4 failing tests, all `414`. GREEN: 44/44 passing in `carehub.endpoint.spec.ts`.

### 2. `notification.seed.ts` mislabels every seeded template's `source` as `'custom'` forever

- **Status: FOUND, NOT FIXED — needs a design decision.**
- **Route:** `GET /admin/notifications/templates` (the `source` field on each returned template).
- **Observed:** every one of the nine compiled-in templates `notification.seed.ts` writes into the single `notifications.templates` app_config row reads `source: 'custom'`, even when never touched by an admin — contradicting that field's own documented meaning (distinguishing a compiled-in default from an admin override).
- **Root cause:** the seed script writes the compiled-in templates into the same storage shape an admin edit would produce, with no separate marker distinguishing "seeded as default" from "admin-edited."
- **Disposition:** **NOT FIXED.** Two plausible correct fixes (a separate `source` column at write time, or deriving `source` by diffing against the compiled-in defaults at read time) represent a real design choice, not a one-line correction — reported for a decision rather than guessed at. Delivery/revert behavior is unaffected either way.

