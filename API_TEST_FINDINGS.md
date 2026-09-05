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

(Entries added as they are found.)
