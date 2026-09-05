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

## 2. FOUND, NOT FIXED — needs a decision: `notification.seed.ts` permanently defeats `listForAdmin()`'s default/custom distinction

**Route:** `GET /api/admin/notifications/templates` (`notification-admin.controller.ts`).

**Exact request that triggers it:** run `npm run db:seed:notifications` (or
any deployment/dev setup that has ever run it — this shared test database
has), then `GET /api/admin/notifications/templates` as an admin holding
`content.manage_notification_templates`, for any of the nine schema-named
template codes (e.g. `checkin_due`) that no admin has ever actually edited.

**Exact observation:** the response's `source` field for `checkin_due` (and
every other of the nine seeded codes) is `"custom"`, even though the title/body
are byte-for-byte the compiled-in default and no admin has ever called
`PUT /api/admin/notifications/templates/checkin_due`. Confirmed directly
against Postgres: `select value->'checkin_due' from app_config where
key='notifications.templates'` returns the exact compiled-in copy — a
row IS present, it just was never edited by a human.

**Root cause:** `notification-template.service.ts`'s own class doc comment
defines the field precisely: `"default" = compiled-in, no app_config entry
yet. "custom" = an admin has edited it.` — `listForAdmin()` computes it as
`lookupTemplate(stored, code) === null ? 'default' : 'custom'`, i.e. purely
by "does a key exist in the stored map", never by comparing content.
`notification.seed.ts`, however, unconditionally writes ALL NINE compiled-in
templates into that one `app_config` row at seed time (`ON CONFLICT DO
NOTHING`, but on the KEY `notifications.templates` as a whole — the insert is
all-nine-or-nothing, not per-template), specifically so — per its own
comment — "the copy is VISIBLE and EDITABLE in the admin panel from day one."
That pre-population makes `lookupTemplate(stored, code)` non-null for every
one of the nine codes on any database the seed has ever touched, so `source`
reads `'custom'` for all of them **forever**, regardless of whether a human
ever touched any of them. The admin panel's "this is genuinely default, no
one has customized it, revert would be a no-op" signal is permanently wrong
on any seeded deployment — which, per the seed script's own stated purpose,
is meant to be every real deployment.

**Why this was not patched here:** the actual DELIVERED template content and
the `DELETE` "revert" behavior are both still correct — `deleteTemplate()`
doesn't consult `source` at all, so this is a display/informational
discrepancy, not a functional delivery bug. But the right fix is a genuine
design choice between at least two different correct directions, and I'm not
confident which the codebase owners intend:
  1. Stop the seed script from pre-populating all nine templates into the
     stored map at all (only write copy an admin has actually customized;
     `getResolved()`/`findTemplate()` already fall back to
     `NOTIFICATION_TEMPLATE_DEFAULTS` on a missing/empty row, so nothing
     about *sending* depends on the seed having run — its own doc comment
     says exactly this). This changes what a fresh `db:seed:notifications`
     writes, which may be relied upon elsewhere (e.g. an audit-log row is
     written per seeded key on first insert).
  2. Keep the seed as-is, but change `source`'s derivation in
     `listForAdmin()` to compare the STORED value against
     `NOTIFICATION_TEMPLATE_DEFAULTS` content instead of mere key presence —
     a template equal to its compiled-in default reads as `'default'` even
     if a row exists, and only a value that actually differs reads as
     `'custom'`. This changes the meaning of `source` for every consumer of
     `AdminNotificationTemplate` and needs its own confirmation that nothing
     downstream depends on "a row exists" being the definition.

Either fix is small in code size but changes documented, load-bearing
behavior (a seed script's contract, or a public admin-facing field's
semantics) rather than being an obviously-correct one-liner, so per this
round's discipline it is reported rather than patched. My own test
(`notification.endpoint.spec.ts`) was adjusted to use a fresh, run-unique
template code for its PUT/DELETE proof instead of asserting `source ===
'default'` against one of the nine real, shared, seed-populated codes — both
to avoid this discrepancy and to avoid mutating shared production-shaped
config data other tests/deployments read.

**Status: FOUND, NOT FIXED — needs a decision.**

---

