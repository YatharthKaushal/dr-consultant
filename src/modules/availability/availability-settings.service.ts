import { BadRequestException, Injectable } from '@nestjs/common';
import type { DoctorSchedulingSettingsRow } from '../../schema/doctor-scheduling-settings.schema';
import type { ActorType } from '../../schema/enums.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { AVAILABILITY_AUDIT_ENTITY_TYPES, AVAILABILITY_CONFIG_FALLBACKS, AVAILABILITY_CONFIG_KEYS, AVAILABILITY_ERROR_CODES } from './availability.constants';
import { AvailabilitySettingsRepository, type SchedulingSettingsUpsert } from './availability-settings.repository';
import type { WindowLimits } from './availability-slot.engine';

const MIN_NOTICE_MINUTES_BOUNDS = { min: 0, max: 10_080 }; // 0 to 1 week
const BOOKING_HORIZON_DAYS_BOUNDS = { min: 1, max: 365 };
/** Reserved for a future feature — see `doctor-scheduling-settings.schema.ts`'s own doc comment. Bounds validated defensively even though the engine doesn't read this column yet. */
const SLOT_INTERVAL_MINUTES_BOUNDS = { min: 5, max: 240 };

export interface PublicSchedulingSettings {
  minNoticeMinutes: number | null;
  bookingHorizonDays: number | null;
  slotIntervalMinutes: number | null;
}

function toPublicSettings(row: DoctorSchedulingSettingsRow | null): PublicSchedulingSettings {
  return {
    minNoticeMinutes: row?.minNoticeMinutes ?? null,
    bookingHorizonDays: row?.bookingHorizonDays ?? null,
    slotIntervalMinutes: row?.slotIntervalMinutes ?? null,
  };
}

/**
 * `doctor_scheduling_settings` CRUD plus the THREE-LEVEL resolution the slot
 * engine depends on: per-doctor override (when the column is non-null) ->
 * `app_config` platform default -> compiled-in fallback
 * (`AVAILABILITY_CONFIG_FALLBACKS`, same discipline `AppConfigService`
 * itself uses).
 */
@Injectable()
export class AvailabilitySettingsService {
  constructor(
    private readonly repo: AvailabilitySettingsRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async getOwnSettings(doctorId: string): Promise<PublicSchedulingSettings> {
    const row = await this.repo.findByDoctor(doctorId);
    return toPublicSettings(row);
  }

  async updateSettings(
    doctorId: string,
    actorType: ActorType,
    actorId: string,
    dto: SchedulingSettingsUpsert,
  ): Promise<PublicSchedulingSettings> {
    const fields = this.definedFieldsOnly(dto);
    this.validate(fields);

    if (Object.keys(fields).length === 0) {
      return this.getOwnSettings(doctorId);
    }

    const before = await this.repo.findByDoctor(doctorId);
    const updated = await this.repo.upsert(doctorId, fields);

    await this.audit.write({
      actorType,
      actorId,
      action: before ? 'update' : 'create',
      entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.SETTINGS,
      entityId: doctorId,
      metadata: { before: toPublicSettings(before), after: fields },
    });

    return toPublicSettings(updated);
  }

  /**
   * THE resolution logic the slot engine calls before every run. `null` (or
   * an absent row) at the per-doctor level means "inherit" — it falls
   * through to `app_config`, which itself falls through to the compiled
   * fallback on a missing/malformed row (`AppConfigService`'s own contract).
   */
  async resolveWindowLimits(doctorId: string): Promise<WindowLimits> {
    const [row, configMinNotice, configHorizonDays] = await Promise.all([
      this.repo.findByDoctor(doctorId),
      this.appConfig.getNumber(AVAILABILITY_CONFIG_KEYS.MIN_NOTICE_MINUTES, AVAILABILITY_CONFIG_FALLBACKS.MIN_NOTICE_MINUTES),
      this.appConfig.getNumber(AVAILABILITY_CONFIG_KEYS.BOOKING_HORIZON_DAYS, AVAILABILITY_CONFIG_FALLBACKS.BOOKING_HORIZON_DAYS),
    ]);

    return {
      minNoticeMinutes: row?.minNoticeMinutes ?? configMinNotice,
      bookingHorizonDays: row?.bookingHorizonDays ?? configHorizonDays,
    };
  }

  private definedFieldsOnly(dto: SchedulingSettingsUpsert): SchedulingSettingsUpsert {
    const fields: SchedulingSettingsUpsert = {};
    if (dto.minNoticeMinutes !== undefined) fields.minNoticeMinutes = dto.minNoticeMinutes;
    if (dto.bookingHorizonDays !== undefined) fields.bookingHorizonDays = dto.bookingHorizonDays;
    if (dto.slotIntervalMinutes !== undefined) fields.slotIntervalMinutes = dto.slotIntervalMinutes;
    return fields;
  }

  /** Defensive re-check of the DTO's own `@Min`/`@Max` bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private validate(fields: SchedulingSettingsUpsert): void {
    this.assertInBounds('minNoticeMinutes', fields.minNoticeMinutes, MIN_NOTICE_MINUTES_BOUNDS);
    this.assertInBounds('bookingHorizonDays', fields.bookingHorizonDays, BOOKING_HORIZON_DAYS_BOUNDS);
    this.assertInBounds('slotIntervalMinutes', fields.slotIntervalMinutes, SLOT_INTERVAL_MINUTES_BOUNDS);
  }

  private assertInBounds(field: string, value: number | null | undefined, bounds: { min: number; max: number }): void {
    if (value === undefined || value === null) return;
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new BadRequestException({
        code: AVAILABILITY_ERROR_CODES.SETTINGS_INVALID,
        message: `${field} must be an integer between ${bounds.min} and ${bounds.max}.`,
      });
    }
  }
}
