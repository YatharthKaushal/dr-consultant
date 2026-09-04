import { Injectable } from '@nestjs/common';
import type { VideoContract, VideoSessionView } from './video.contract';
import { VideoService } from './video.service';

/**
 * M-14's single public surface (`backend/README.md` §2).
 *
 * Deliberately narrow — one method. Nothing outside this module mints a join
 * token, receives the LiveKit webhook, or moves a consultation into
 * `in_progress`/`awaiting_documentation`; those all run from this module's own
 * controllers, so the contract carries only what the modules that DEPEND on
 * M-14 actually need:
 *
 *   M-15 (Clinical Records)  `getSession`. `docs/MODULES.md` gives M-15 a
 *                            "consultation ID audit trail across booking,
 *                            SESSION METADATA, prescription and case summary"
 *                            and lists M-14 among its dependencies. M-15 holds
 *                            a consultation id, not a
 *                            `consultation_participants` query, and this is how
 *                            it reaches the call that produced the record.
 *
 *   M-18 / M-21 / admin      `getSession` again. `docs/erd.sql` on
 *                            `disconnect_reason`: "Read when adjudicating a
 *                            technical_issue complaint or a refund - it is the
 *                            only thing separating a hang-up from a dropped
 *                            network."
 *
 * `getSession` here is the TRUSTED module-to-module form and applies no
 * ownership check — the caller authorizes, the same rule
 * `BookingContract#findById` and `InstantContract#getInstantConsult` state. The
 * two participant-facing routes go through `VideoService#getSessionForCaller`
 * instead, which does.
 *
 * *** THERE IS NO `issueJoinToken` ON THIS FACADE, AND THERE MUST NOT BE. ***
 * FR-8.5's gate is defined in terms of the CALLER — "only the assigned patient
 * and doctor" — so a trusted module-to-module mint would be a way to obtain
 * admission to a clinical conversation without being either of them. It stays
 * on the controller, where an `@CurrentUser()` exists to check against.
 */
@Injectable()
export class VideoFacade implements VideoContract {
  constructor(private readonly video: VideoService) {}

  /** See `VideoContract#getSession`. Never `null` — a consultation with no connections is the double no-show, which is a meaningful answer. */
  async getSession(consultationId: string): Promise<VideoSessionView> {
    return this.video.getSession(consultationId);
  }
}
