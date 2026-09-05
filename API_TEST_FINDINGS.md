# API endpoint test findings — identity, consent, patient, doctor, catalogue, availability

Produced while writing the first real-HTTP (`app.inject()`) endpoint tests for these six
modules. Each entry: route, exact request, exact failure observed, root cause, and
disposition (fixed with red/green proof, or found-and-not-fixed with reasoning).

Format per finding:

```
## <short title>
- Route: METHOD /api/...
- Request: <method/url/payload/headers that trigger it>
- Observed: <status code + response body, or stack trace>
- Root cause: <why>
- Disposition: FIXED <files changed, red/green proof> | NOT FIXED <why not — needs a
  design decision / risk too high / out of scope, etc.>
```

---

## Module status summary (updated as each module's spec file lands)
- catalogue: 45 cases, all pass against current code. No bugs found.
- consent: 61 cases, all pass against current code. No bugs found.
- patient: 26 cases. One bug found and fixed (below).
- identity: 53 cases, all pass against current code. No bugs found — the OTP flow, token refresh, logout-all, and the full admin RBAC surface (roles, direct permission grants, self-modification guard) all behave exactly as documented. `LAST_SUPER_ADMIN` (409) is NOT independently exercised: triggering it for real would require driving the shared, seeded `super_admin` row's holder count to zero in a database five other parallel worktrees are also using, which is an unacceptable blast radius for a check whose whole job is to prevent exactly that. `CANNOT_MODIFY_SELF`, `ROLE_NOT_FOUND`, `PERMISSION_NOT_FOUND`, `ADMIN_NOT_FOUND` and `MOBILE_NUMBER_TAKEN` are all covered directly.
- doctor: 67 cases, all pass against current code. No bugs found. Covers the full verification -> listing -> fee -> expert-role -> specialty-assignment state machine, session revocation on rejection, a real multipart/form-data document upload (the first in this codebase to drive a multipart route over real HTTP), and three separate split-permission proofs. One call is deliberately left UNMOCKED to record real environment behavior: with no S3/Cloudinary credentials configured, a fully valid upload reaches `StorageFacade.store()` and gets an honest 503 `DOCTOR_DOCUMENT_UPLOAD_FAILED` — not a bug, recorded so it isn't mistaken for one; `StorageFacade.store` is then mocked for the rest of that file so the review workflow has real rows to work with.

---

## `patient-admin.controller.ts` — malformed `:id` 500s instead of 400
- Route: `GET /api/admin/patients/:id` and `PATCH /api/admin/patients/:id/status`
- Request: `GET /api/admin/patients/not-a-uuid` (admin token holding `patients.read`); same shape for the PATCH route with `patients.manage_status`.
- Observed (RED, before fix): `500 { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred. Please try again." } }`. Server-side log showed a raw Postgres error surfacing through `HttpExceptionFilter`'s catch-all branch — `invalid input syntax for type uuid: "not-a-uuid"` (Postgres code `22P02`), because `@Param('id') id: string` passed the raw path segment straight to `PatientRepository`'s `eq(patientsTable.id, id)` against a `uuid` column with no validation in between.
- Root cause: `patient-admin.controller.ts`'s two `:id`-taking routes (`getById`, `updateStatus`) were missing `createUuidValidationPipe('id')` on their `@Param('id')` decorator — every sibling admin controller in this codebase (`doctor-admin.controller.ts`, `legal-document-admin.controller.ts`, `data-deletion-admin.controller.ts`, etc.) already uses this pipe for exactly this reason. A malformed id therefore skipped validation entirely and reached the database as a literal string compared against a `uuid` column.
- Disposition: FIXED. Added `createUuidValidationPipe('id')` to both `@Param('id')` decorators in `src/modules/patient/patient-admin.controller.ts`, matching the codebase's own established convention. Verified RED (`git stash` the fix, re-run `patient.endpoint.spec.ts -t malformed` — both malformed-id tests failed with `500` instead of the expected `400`) then GREEN (restore the fix, full `patient.endpoint.spec.ts` — 26/26 pass, including both malformed-id cases now returning `400 VALIDATION_FAILED`). This is a genuine root-cause fix (add the same guard every sibling route already has), not a workaround.

