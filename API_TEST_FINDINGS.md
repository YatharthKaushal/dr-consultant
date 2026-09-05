# API test findings — instant / video / clinical / followup

Compiled by the coordinator for this worktree (`api-test-consult`) while adding
real-HTTP endpoint test coverage (`src/modules/{instant,video,clinical,followup}/*.endpoint.spec.ts`)
against `createConfiguredApp()` + `app.inject()`. One entry per genuine finding,
whether fixed or not, per the coordinator's instructions.

---

## FIXED — application bug

### 1. `GET /api/admin/instant-consults/:consultationId` — 200 with `data: null` instead of 404 for an unknown/mistyped id

- **Route:** `GET /api/admin/instant-consults/:consultationId` (`instant-admin.controller.ts`)
- **Triggering request:** any admin holding `appointments.read`, requesting a
  `consultationId` that does not exist (or is not `mode: 'instant'`).
- **Observed failure (RED):** `200 OK` with body `{ success: true, data: null }`.
  Every other "get one" admin route in this codebase (e.g.
  `booking-admin.controller.ts#getOne`) 404s in the equivalent case.
- **Root cause:** `InstantService#getInstantConsult` deliberately returns `null`
  for its other (internal) callers — `InstantFacade`, the M-21 data-rights
  code — which need to distinguish "no such instant consult" from a thrown
  exception on a hot path. `instant-admin.controller.ts#getOne` forwarded that
  `null` straight into the HTTP response instead of converting it, unlike the
  established convention.
- **Fix:** `getOne` now awaits the result and throws the existing, already-exported
  `instantConsultNotFound()` helper (from `instant.service.ts`) when the result
  is `null` — small, root-cause, matches the codebase's own convention.
- **Proof:** RED test asserted 404 and got 200/`null`; GREEN after the fix —
  `src/modules/instant/instant.endpoint.spec.ts`, test
  `"BUG FIX, VERIFIED: an unknown consultation id now 404s INSTANT_CONSULT_NOT_FOUND instead of 200ing with data: null"`.
- **Status:** Fixed. Commit `820f7a0`.

---

## Investigated, confirmed correct by design (NOT bugs) — flagged because these are exactly the areas with historical precedent for subtle bugs, and were adversarially tested rather than assumed

### 2. Clinical draft save (`PUT /api/consultations/:id/clinical-record`) — PUT semantics, a field left out is cleared

Confirmed as designed, not a bug. Saved `diagnosis` + `caseSummary`, then PUT
again omitting both — both came back `null` in the response AND in a fresh SQL
read. Matches `clinical.service.ts#saveDraft`'s own header and `toRowPatch`'s
unconditional overwrite. Same behaviour proved for template PUT (medicines
cleared on omission). See `clinical.endpoint.spec.ts`.

### 3. Clinical prescribing gate — tied to the consultation's booking-time specialty snapshot, not the doctor's current primary specialty

Confirmed correct, not a bug. Three adversarial cases, all against the real
HTTP route:
- A doctor whose current PRIMARY specialty is non-prescribing can still
  prescribe on a consultation booked under a prescribing specialty they also
  practise.
- A doctor whose current PRIMARY is prescribing is still refused on a
  consultation booked under a non-prescribing specialty.
- A doctor's primary specialty is CHANGED after booking (prescribing → a
  different prescribing specialty) — the OLD consultation still finalises
  with its medicine intact (proves the code reads
  `consultations.specialty_id → specialties.can_prescribe`, never
  doctor-primary), and the converse: a NEW consultation booked under a
  non-prescribing specialty is still refused even though the doctor's new
  current primary can prescribe.

See `clinical.endpoint.spec.ts`.

### 4. Video: a SCHEDULED consultation returns the doctor to the routing pool on end (`releaseDoctorToRoutingPool`)

Confirmed correct via real HTTP + fresh SQL (this was a previously-fixed bug
in an earlier round; this round re-proves it end to end over the real route
rather than at the service layer). `POST /api/video/consultations/:id/end` on
a `mode: 'scheduled'` call moves the consultation to
`awaiting_documentation` and the doctor's `presence` back to `available_now`;
the same route on an `instant` call sets the completion gate instead. See
`video.endpoint.spec.ts`.

### 5. Clinical: prescription-PDF download permission gate is genuinely narrowed to one file category

Confirmed correct (this is a pre-existing fix — `patient-file.service.ts#canAccessForDownload`
— not newly fixed by this round). Proved over real HTTP: an admin with no
grants → 404 (no existence leak via a different status), an admin with an
*unrelated* permission → 404 (the gate does not leak to any admin
permission), an admin holding `clinical.read_records` → 200, and an admin
with NO grants at all can still download an ordinary (non-prescription) file
— proving the narrowing is real, not a blanket admin-permission requirement.
See `clinical.endpoint.spec.ts`.

---

## Test-infrastructure note (NOT an app bug) — flagged for the other parallel groups

### 6. `CLINICAL_RECORD_FINALISED_EVENT` is fire-and-forget; a test's own teardown can race the listener it triggers

`clinical.service.ts#finalise` emits `CLINICAL_RECORD_FINALISED_EVENT`
fire-and-forget (documented, deliberate — finalise itself must not fail on a
listener error). `FollowupClinicalListener` reacts by inserting a
`followup_assignments` row asynchronously, which can land AFTER `finalise`'s
HTTP response has already returned. A test that calls `finalise` and tears
down immediately after (deleting `followup_assignments` for its
consultation ids, then deleting `consultations`) can find 0 assignment rows
at delete time, then have the listener's row land moments later — and the
`consultations` delete then fails on a fresh FK violation.

This raced the clinical module's own endpoint-spec teardown on its first run
(found and fixed there with a small retry loop — 10 attempts, 300ms backoff
— around the reverse-FK delete sequence, rather than a fixed sleep). **Any
test elsewhere in this codebase that calls `finalise` (or otherwise completes
a consultation) and tears down immediately after is exposed to the same
race** — worth the other parallel groups checking their own teardowns for
it if they touch a completed/finalised consultation.

Note this is a *different* failure mode from a similar-looking one found
independently in the followup module's own endpoint spec (see the
`notifications` FK gap below) — that one was deterministic (every attempt
failed identically), not a timing race, and needed an added delete, not a
retry.

---

## Test-file bugs found and fixed while getting these suites green (not application bugs — noted for transparency, no app follow-up needed)

These were bugs in the new test files themselves, caught by actually running
them against the real database, not in the application under test:

- **`followup.endpoint.spec.ts`**: asserted the wrong expected error-code
  string for the account-type guard (`'AUTH_WRONG_ACCOUNT_TYPE'` vs. the real
  `'WRONG_ACCOUNT_TYPE'` per `auth.constants.ts`).
- **`followup.endpoint.spec.ts`**: three tests set a consultation's `doctorId`
  without ever linking that doctor to the fixture specialty via
  `doctor_specialties` — Postgres's composite `consultations_doctor_specialty_fk`
  rejected the insert. Fixed by inserting that row in `beforeAll` and cleaning
  it in `afterAll`.
- **`followup.endpoint.spec.ts`**: the `afterAll` teardown never deleted
  `notifications` rows, which carry a real FK onto `consultations` (raising a
  red-flag alert writes one via a real code path this suite exercises).
  Deterministic on every attempt, not a race — confirmed by querying
  `pg_constraint` and per-table row counts directly against the real
  database rather than guessing. Fixed by adding the delete in the correct
  order.

---

## Summary

| Module | Routes | Covered | Tests | App bugs found | App bugs fixed |
|---|---|---|---|---|---|
| instant | 17 | 17 (16 fully, 1 partial — SSE stream, see below) | 47 | 1 | 1 |
| video | 9 | 9 | 45 | 0 | 0 |
| clinical | 12 | 12 | 28 | 0 | 0 |
| followup | — (see module report) | — | 33 | 0 | 0 |
| **Total** | | | **153** | **1** | **1** |

**Could not verify:** `GET /doctors/me/stream` (SSE, instant module) — full
open/close cycle. `app.inject()` (`light-my-request`) fabricates a request
with no real socket, and `@nestjs/core`'s `SseStream` unconditionally calls
`req.socket.setKeepAlive(true)`, throwing before the controller runs. This is
a test-tooling gap, not an app defect — `instant-presence.service.spec.ts`
already covers `openStream`/`releaseStream` directly. Only the 401/403 guard
boundary is verified over real HTTP for this route.
