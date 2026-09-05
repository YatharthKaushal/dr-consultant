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

(entries added as found)
