# API Endpoint Test Findings — search, notification, document, storage, carehub, ai, mcp

Compiled while writing `*.endpoint.spec.ts` HTTP-level tests (via `app.inject()`
against `createConfiguredApp()`) for this worktree's module group. One entry per
bug found, whether fixed or not.

Status legend:
- **FIXED** — genuine root-cause fix applied, proven red -> green, committed.
- **FOUND, NOT FIXED — needs a decision** — real issue, but the correct fix is
  non-trivial / needs a design call / low confidence in root cause, so the code
  was left as-is rather than patched around.

---

## 1. FIXED — `GET /api/care-hub/shared/:token` 414s for every real share-link token ever minted

**Route:** `GET /api/care-hub/shared/:token` (`carehub-share.controller.ts`, `@Public()`).

**Exact request that triggers it:** mint a real token via the real, authenticated
`POST /api/care-hub/content/:id/share` route (patient, published `caregiver_guide`
item), then `GET /api/care-hub/shared/<that real token>`.

**Exact failure observed:** `414` (URI Too Long), before the route handler,
any guard, or the controller ever runs. Not a validation error, not a 404 —
Fastify's router itself refuses to match the route.

**Root cause:** `carehub.service.ts#mintShareLink` mints a token shaped
`v1.<base64url(JSON({c: contentItemId, e: expiresAtSeconds}))>.<base64url(hmac-sha256)>`,
which for a uuid `contentItemId` and a 10-digit unix-seconds expiry is
consistently **126 characters**. `app.bootstrap.ts` constructs the Fastify
adapter as `new FastifyAdapter({ logger: false, trustProxy: env.TRUST_PROXY })`
with no `maxParamLength` override, so Fastify's router (`find-my-way`)
applies its **default of 100** — any `:token` path segment over 100
characters is refused with 414 at the router level, before Nest's own guard
stack, `ValidationPipe`, or the controller ever sees the request. This is not
an edge case or a pathological input: it is the length of **every** token
this feature has ever minted or ever will, given the fixed token format. The
entire FR-15.5 caregiver-guide share-link feature was unreachable through its
own real HTTP route.

**Discovered by:** `carehub.endpoint.spec.ts`, "mints a real token via
POST .../share, and GET /shared/:token resolves it unauthenticated" — driving
a genuinely server-minted token (not a synthetic long string) through
`app.inject()`. Went RED with `Expected: 200, Received: 414` (4 tests in that
file failed the same way: the happy path, the post-unpublish regression
check, the expired-token check, and the forged-token check — all of them
never even reached `resolveSharedContent()`).

**Fix applied:** `app.bootstrap.ts` — added `maxParamLength: 200` to the
`FastifyAdapter` constructor options, with a code comment explaining exactly
why (the fixed ~126-char token length, and that 200 leaves headroom without
materially widening what the router will match for any other route's `:id`-shaped
params, which stay far under either limit). This is the shared app-construction
function BOTH `main.ts` and every `app.inject()`-based test use (per its own
header, "one definition, both callers share it"), so the fix applies to the
real, deployed application, not only to tests.

**Proof:** RED (4 failing tests, all `Received: 414`) → fix → GREEN (same 4
tests pass, full file 44/44 passing). See `src/modules/carehub/carehub.endpoint.spec.ts`
and `src/app.bootstrap.ts`.

**Status: FIXED.**

---

