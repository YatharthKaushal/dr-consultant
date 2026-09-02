import type { DoctorAvailabilityRow } from '../../schema/doctor-availability.schema';
import type { AvailabilityRuleType } from '../../schema/enums.schema';
import type { WeeklyAvailabilityRule } from './availability.contract';

/** `doctor_availability` carries no admin-only/internal column — every field here is safe for a doctor to see about their own rules. Kept as an explicit projection anyway (rather than returning the raw row) so the response shape stays insulated from a future schema addition. */

export function toPublicWeeklyRule(row: DoctorAvailabilityRow): WeeklyAvailabilityRule {
  return {
    id: row.id,
    dayOfWeek: row.dayOfWeek as number,
    startTime: row.startTime as string,
    endTime: row.endTime as string,
  };
}

export interface PublicOverrideRule {
  id: string;
  specificDate: string;
  startTime: string;
  endTime: string;
}

export function toPublicOverrideRule(row: DoctorAvailabilityRow): PublicOverrideRule {
  return {
    id: row.id,
    specificDate: row.specificDate as string,
    startTime: row.startTime as string,
    endTime: row.endTime as string,
  };
}

export interface PublicBlockRule {
  id: string;
  specificDate: string;
  startTime: string | null;
  endTime: string | null;
}

export function toPublicBlockRule(row: DoctorAvailabilityRow): PublicBlockRule {
  return {
    id: row.id,
    specificDate: row.specificDate as string,
    startTime: row.startTime,
    endTime: row.endTime,
  };
}

/** The uniform "any rule type" shape — used by the admin "view everything" read (`GET /admin/doctors/:id/availability`), which mixes weekly/override/block rows in one list. */
export interface PublicAvailabilityRule {
  id: string;
  ruleType: AvailabilityRuleType;
  dayOfWeek: number | null;
  specificDate: string | null;
  startTime: string | null;
  endTime: string | null;
}

export function toPublicAvailabilityRule(row: DoctorAvailabilityRow): PublicAvailabilityRule {
  return {
    id: row.id,
    ruleType: row.ruleType,
    dayOfWeek: row.dayOfWeek,
    specificDate: row.specificDate,
    startTime: row.startTime,
    endTime: row.endTime,
  };
}
