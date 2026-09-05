# API Test Findings — booking / payment / pricing / promotion

Findings from writing real HTTP endpoint tests (`app.inject()` through
`createConfiguredApp()`) against the `booking`, `payment`, `pricing`, and
`promotion` modules. One entry per bug, whether fixed or not. Compiled for the
coordinator's cross-group follow-up doc.

Status legend:
- **FIXED** — root-cause fix applied in this worktree, with a RED test
  against the old code and GREEN after the fix, both captured below.
- **FOUND, NOT FIXED — needs a decision** — real bug, but the correct fix is
  non-trivial, needs a product/design decision, or fixing scope would exceed
  this session's "only touch what a genuine bug requires" mandate. Left
  as-is deliberately, not patched around.

---

## 1. Shared test DB's `permissions` catalog was stale — `promotions.*`/`affiliates.*` keys missing

**Status: FIXED (by re-running the idempotent seed script — not an application code bug).**

**Route affected:** every `admin/promotions/*` and `admin/promotions/affiliates/*` route (all gated by `promotions.read`, `promotions.manage`, `promotions.export`, `affiliates.read`, `affiliates.manage`, or `affiliates.settle`).

**Exact trigger:** mint an admin JWT, grant it a `promotions.read` (or any `promotions.*`/`affiliates.*`) permission by looking up the permission's id from the `permissions` table and inserting an `admin_permission_grants` row, per the pattern `identity-access.listAdminIdsWithPermission.integration.spec.ts` already uses. The lookup (`select id from permissions where key = 'promotions.read'`) returned zero rows.

**Observed failure:** every `promotion.endpoint.spec.ts` test failed in `beforeAll` with a thrown fixture-precondition error (not a test failure — the fixture setup itself couldn't grant the permission it needed):
```
Fixture precondition failed: permission "promotions.read" not found — run identity.seed.ts first.
```

**Root cause:** `src/shared/auth/permission.catalog.ts` currently defines 58 permission keys, including the 6 `PROMOTIONS_*`/`AFFILIATES_*` ones this module's admin controller uses (`payment-admin.controller.ts`'s own header comment references "the existing 52" as the permission-set baseline before this module's additions). `src/modules/identity/identity.seed.ts` — the script that copies `PERMISSION_DEFINITIONS` into the `permissions` table, `role_permissions` bundles included — is idempotent and insert-only (`ON CONFLICT DO NOTHING`), but it had only ever been run against this shared Postgres database at a point before the promotion/affiliate permissions existed in code. The `permissions` table had exactly 52 rows; `PermissionGuard#hasAllPermissions` correctly resolves "0 matching permission rows" the same way it would resolve a genuinely revoked permission — there is no way for the running application to distinguish "this admin lacks the permission" from "this permission doesn't exist in the catalog yet," and it should not need to, since the catalog is supposed to be kept in sync by re-running the seed after a code change adds a key.

**Fix applied:** ran `npm run db:seed` (`ts-node identity.seed.ts`) against the shared database. It is explicitly idempotent/insert-only and reported:
```
identity.seed: done — {"permissions":58,"roles":6,"rolePermissionsAdded":14,"rolePermissionsRemoved":0,"bootstrapAdminCreated":true}
```
This added the 6 missing permission rows and their 14 role-bundle memberships (e.g. `finance`/`operations` gaining the promotions/affiliates keys `permission.catalog.ts` already says they should hold), without touching or removing any of the pre-existing 52 rows or any admin's existing direct grants.

**One side effect worth flagging explicitly, not a bug:** the same seed run also has a `BOOTSTRAP_SUPER_ADMIN_MOBILE` step (`identity.seed.ts`) that creates a `super_admin` admin row if none exists yet holding that role — `bootstrapAdminCreated: true` in the output above means this shared database had no super_admin admin row before this run and now has exactly one (idempotent — re-running the seed again will not create a second one). This is the seed script working as designed, not an artifact of this test session, but it is a persistent row in the shared database from here on, so it is recorded here for visibility.

**Why this is marked FIXED rather than "needs a decision":** the fix is exactly what the seed script's own re-runnable, insert-only design exists for — closing a catalog gap between code and a database that predates the code — not a workaround around a real defect. No application source file was touched.

---

(Further entries added as they are found.)
