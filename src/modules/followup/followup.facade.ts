import { Injectable } from '@nestjs/common';
import type { SafetyAlertType } from '../../schema/enums.schema';
import { FollowupAlertService } from './followup-alert.service';
import type {
  CarePlanView,
  CheckinResponseView,
  FollowUpBookingRecommendation,
  FollowupAssignmentView,
  FollowupContract,
  SafetyAlertView,
  SubmitCheckinResult,
} from './followup.contract';
import { FollowupService } from './followup.service';

/**
 * M-16's single public surface (`backend/README.md` §2). Thin delegation —
 * every rule lives in `followup.service.ts`/`followup-alert.service.ts`.
 *
 * No consumer is wired to this facade in this worktree yet — see
 * `followup.service.ts#assignPathway`'s header for the one method that
 * genuinely needs a caller added elsewhere, and this module's build report
 * for the full account.
 */
@Injectable()
export class FollowupFacade implements FollowupContract {
  constructor(
    private readonly followup: FollowupService,
    private readonly alerts: FollowupAlertService,
  ) {}

  async assignPathway(input: { consultationId: string; pathwayCode: string; startsOn?: Date }): Promise<FollowupAssignmentView> {
    return this.followup.assignPathway(input);
  }

  async getAssignment(consultationId: string): Promise<FollowupAssignmentView | null> {
    return this.followup.getAssignment(consultationId);
  }

  async submitCheckin(input: {
    consultationId: string;
    checkinDate?: string;
    answers: Record<string, string>;
    actorPatientId: string;
  }): Promise<SubmitCheckinResult> {
    return this.followup.submitCheckin(input);
  }

  async listCheckins(consultationId: string): Promise<CheckinResponseView[]> {
    return this.followup.listCheckins(consultationId);
  }

  async listAlertsForConsultation(consultationId: string): Promise<SafetyAlertView[]> {
    return this.alerts.listAlertsForConsultation(consultationId);
  }

  async recommendFollowUpBooking(consultationId: string, urgent: boolean): Promise<FollowUpBookingRecommendation> {
    return this.followup.recommendFollowUpBooking(consultationId, urgent);
  }

  async getCarePlan(consultationId: string): Promise<CarePlanView> {
    return this.followup.getCarePlan(consultationId);
  }

  /** ADDITIVE (M-20/governance and quality) — see `FollowupContract#listOpenAlerts`. */
  async listOpenAlerts(limit: number, offset: number): Promise<SafetyAlertView[]> {
    return this.alerts.listOpenAlertsForAdmin(limit, offset);
  }

  /** ADDITIVE (M-20/governance and quality) — see `FollowupContract#countOpenAlertsByType`. */
  async countOpenAlertsByType(): Promise<Partial<Record<SafetyAlertType, number>>> {
    return this.alerts.countOpenAlertsByType();
  }
}
