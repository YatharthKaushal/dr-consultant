import type { ComplaintStatus } from '../../schema/enums.schema';

/**
 * One entry in `complaints.messages` — the shape the schema's own comment
 * names: "author_id, author_type, body, is_internal, at".
 *
 * `authorType` is `'patient' | 'admin'`: the two sides of the thread this
 * schema comment describes ("the thread between the patient and whichever
 * admin is `assigned_to_admin_id`"). `isInternal` is what lets an admin
 * leave a note for another admin (a triage remark, "waiting on refund
 * confirmation") on the SAME thread without a patient ever seeing it —
 * `feedback-message.util.ts#toPatientVisibleMessages` is the one place that
 * filters it out before a patient-facing view is built.
 */
export interface ComplaintMessage {
  authorId: string;
  authorType: 'patient' | 'admin';
  body: string;
  isInternal: boolean;
  /** ISO-8601. Stored as a string, not a `Date` — `messages` is `jsonb`, and a `Date` would round-trip through Postgres as a string anyway. */
  at: string;
}

/**
 * M-19's single public surface (`backend/README.md` §2).
 *
 * Narrow on purpose, matching every other module's facade in this codebase:
 * the one NAMED future consumer is M-20 (Governance and Quality, unbuilt),
 * and `docs/MODULES.md` gives it exactly one fact from this module — "quality
 * dashboard: ... complaints" — a status-count breakdown, never a complaint's
 * content and never a patient's identity. Submitting feedback, raising a
 * complaint, working the workflow and exchanging thread messages are this
 * module's own acts, reached through its own controllers with the caller's
 * own credentials — a facade method that let another module act on a
 * patient's or admin's behalf would be exactly the kind of exposure
 * `clarification.contract.ts`'s header warns against, one hop removed.
 */
export interface FeedbackContract {
  /**
   * *** THE M-20 SEAM. *** Every status in `COMPLAINT_STATUSES`
   * (`schema/enums.schema.ts`) is a key, `0` for a status with no rows — a
   * dashboard rendering this directly never has to guard a missing key.
   *
   * No auth/ownership check: this is a trusted module-to-module read, the
   * same rule `BookingContract.getBooking`'s own doc comment states for the
   * identical reason ("For M-12/M-14/M-15/M-19... which each hang their own
   * record off a consultation id").
   */
  countComplaintsByStatus(): Promise<Record<ComplaintStatus, number>>;
}
