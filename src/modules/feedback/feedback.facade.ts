import { Injectable } from '@nestjs/common';
import type { ComplaintStatus } from '../../schema/enums.schema';
import { ComplaintService } from './complaint.service';
import type { FeedbackContract } from './feedback.contract';
import { FeedbackService } from './feedback.service';

/**
 * M-19's single public surface (`backend/README.md` §2).
 *
 * See `feedback.contract.ts` for the full argument. Short version: the one
 * NAMED future consumer (M-20, unbuilt) needs a status-count breakdown of
 * complaints, never feedback or complaint content and never a patient's
 * identity — so that is all this facade exposes. Submitting feedback,
 * raising a complaint, working the workflow and exchanging thread messages
 * are this module's own acts, reached through `feedback.controller.ts`/
 * `complaint.controller.ts`/`feedback-admin.controller.ts`/
 * `complaint-admin.controller.ts` with the caller's own credentials; there
 * is no facade method that lets another module act on a patient's or
 * admin's behalf.
 */
@Injectable()
export class FeedbackFacade implements FeedbackContract {
  constructor(
    private readonly complaints: ComplaintService,
    private readonly feedback: FeedbackService,
  ) {}

  /** See `FeedbackContract#countComplaintsByStatus`. No auth/ownership check — the caller (a trusted module-to-module read) authorizes. */
  async countComplaintsByStatus(): Promise<Record<ComplaintStatus, number>> {
    return this.complaints.countComplaintsByStatus();
  }

  /** ADDITIVE (M-21/data rights execution) — see `FeedbackContract#countDataRightsRowsForPatient`. */
  async countDataRightsRowsForPatient(patientId: string): Promise<{ feedback: number; complaints: number }> {
    const [feedbackCount, complaintsCount] = await Promise.all([
      this.feedback.countByPatientId(patientId),
      this.complaints.countByPatientId(patientId),
    ]);
    return { feedback: feedbackCount, complaints: complaintsCount };
  }
}
