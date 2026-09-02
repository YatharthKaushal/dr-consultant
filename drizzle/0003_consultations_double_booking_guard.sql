-- M-07 (Availability and Scheduling), not M-11 (Booking).
--
-- `consultations` is an M-11-owned table (booking doesn't exist yet as a
-- module) and this migration otherwise makes no changes to it — no columns,
-- no other indexes, nothing but this one constraint. It is added here,
-- hand-written (drizzle-kit has no schema-level way to express a PARTIAL
-- unique index), because:
--
--   1. `src/schema/consultations.schema.ts`'s own doc comment already
--      commits to this constraint: "Double-booking prevention... [is],
--      per docs/erd.sql, added by hand in the first migration
--      (db/README.md, not yet written)" — but checking `drizzle/
--      0000_late_clea.sql`, that promise was never actually kept: there is
--      only a plain non-unique `index().on(doctorId, scheduledStartAt)`.
--   2. M-07's own "Done when" bar in `docs/MODULES.md` is explicit: "two
--      patients cannot take the same slot" — that guarantee cannot exist
--      without this constraint, and M-07 is the module whose job is exactly
--      this guarantee. Waiting for M-11 to be built to add it would ship
--      M-07 without meeting its own done-when criterion.
--
-- Partial: only consultation rows that are actually occupying a doctor's
-- calendar slot participate. `cancelled`/`no_show`/`expired` free the slot,
-- so two such rows (or one cancelled + one live) at the same
-- (doctor_id, scheduled_start_at) are legitimate and must NOT be rejected.
-- `doctor_id`/`scheduled_start_at` can each independently be NULL (an
-- unassigned instant-request row, or a not-yet-scheduled row) — those never
-- collide with anything, hence the explicit IS NOT NULL guards alongside the
-- NULL-distinct behavior Postgres already gives unique indexes.
CREATE UNIQUE INDEX "consultations_doctor_slot_unique_idx"
  ON "consultations" ("doctor_id", "scheduled_start_at")
  WHERE "doctor_id" IS NOT NULL
    AND "scheduled_start_at" IS NOT NULL
    AND "status" IN ('pending_payment', 'scheduled', 'awaiting_doctor', 'in_progress', 'awaiting_documentation', 'completed');
