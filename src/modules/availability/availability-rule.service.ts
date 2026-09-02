import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { DoctorAvailabilityRow } from '../../schema/doctor-availability.schema';
import type { ActorType } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { AVAILABILITY_AUDIT_ENTITY_TYPES, AVAILABILITY_ERROR_CODES } from './availability.constants';
import {
  AvailabilityRuleRepository,
  type BlockRuleInput,
  type OverrideRuleInput,
  type WeeklyRuleInput,
} from './availability-rule.repository';
import { parseTimeToMinutes } from './availability-time.util';

interface TimeRange {
  startTime: string;
  endTime: string;
}

export function invalidRuleShape(message: string): BadRequestException {
  return new BadRequestException({ code: AVAILABILITY_ERROR_CODES.INVALID_RULE_SHAPE, message });
}

export function overlappingRule(message: string): ConflictException {
  return new ConflictException({ code: AVAILABILITY_ERROR_CODES.OVERLAPPING_RULE, message });
}

export function ruleNotFound(): NotFoundException {
  return new NotFoundException({ code: AVAILABILITY_ERROR_CODES.RULE_NOT_FOUND, message: 'Availability rule not found.' });
}

/**
 * `doctor_availability` entity operations: the atomic weekly-schedule
 * replace, single override/block add+remove, and the shape/overlap
 * validation backing all of them. Overlap prevention is enforced HERE, not
 * as a DB constraint (`doctor-availability.schema.ts`'s own doc comment
 * explains why: it would need `btree_gist`, awkward for this rule shape).
 *
 * Every write is audited — schedules gate bookings which gate payment, so
 * this counts as "touching... financial data" under `backend/README.md`'s
 * cross-module audit rule, same reasoning `doctor-specialty.service.ts`
 * already applies to specialty assignment.
 */
@Injectable()
export class AvailabilityRuleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: AvailabilityRuleRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                    */
  /* ---------------------------------------------------------------------- */

  async listWeekly(doctorId: string): Promise<DoctorAvailabilityRow[]> {
    return this.repo.listWeeklyByDoctor(doctorId);
  }

  /** Every rule for this doctor, any type — the admin "view everything" read. */
  async listAll(doctorId: string): Promise<DoctorAvailabilityRow[]> {
    return this.repo.listByDoctor(doctorId);
  }

  /* ---------------------------------------------------------------------- */
  /* Weekly schedule — atomic whole-week replace                             */
  /* ---------------------------------------------------------------------- */

  async replaceWeekly(
    doctorId: string,
    actorType: ActorType,
    actorId: string,
    items: WeeklyRuleInput[],
  ): Promise<DoctorAvailabilityRow[]> {
    this.validateWeeklyItems(items);

    return this.db.transaction(async (tx) => {
      const rows = await this.repo.replaceWeekly(doctorId, items, tx);
      await this.audit.write(
        {
          actorType,
          actorId,
          action: 'update',
          entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.WEEKLY_SCHEDULE,
          entityId: doctorId,
          metadata: { after: items },
        },
        tx,
      );
      return rows;
    });
  }

  private validateWeeklyItems(items: WeeklyRuleInput[]): void {
    for (const item of items) {
      if (!Number.isInteger(item.dayOfWeek) || item.dayOfWeek < 0 || item.dayOfWeek > 6) {
        throw invalidRuleShape('dayOfWeek must be an integer between 0 (Sunday) and 6 (Saturday).');
      }
      this.assertTimeOrder(item.startTime, item.endTime);
    }

    const byDay = new Map<number, TimeRange[]>();
    for (const item of items) {
      const list = byDay.get(item.dayOfWeek) ?? [];
      list.push(item);
      byDay.set(item.dayOfWeek, list);
    }
    for (const [day, dayItems] of byDay) {
      if (this.hasOverlap(dayItems)) {
        throw overlappingRule(`Two weekly rules for day ${day} overlap in time.`);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Date-wise overrides (custom_hours)                                      */
  /* ---------------------------------------------------------------------- */

  async addOverride(doctorId: string, actorType: ActorType, actorId: string, dto: OverrideRuleInput): Promise<DoctorAvailabilityRow> {
    this.assertTimeOrder(dto.startTime, dto.endTime);

    return this.db.transaction(async (tx) => {
      await this.lockDateGuard(tx, doctorId, dto.specificDate);

      const existing = await this.repo.listForRange(doctorId, dto.specificDate, dto.specificDate, tx);
      const sameDateOverrides = existing.filter((r) => r.ruleType === 'custom_hours' && r.specificDate === dto.specificDate);
      this.assertNoOverlapForDate(dto, sameDateOverrides, 'An override for this date already exists and would overlap.');

      const row = await this.repo.addOverride(doctorId, dto, tx);
      await this.audit.write(
        {
          actorType,
          actorId,
          action: 'create',
          entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.OVERRIDE,
          entityId: row.id,
          metadata: { after: dto },
        },
        tx,
      );
      return row;
    });
  }

  async removeOverride(doctorId: string, actorType: ActorType, actorId: string, id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row || row.doctorId !== doctorId || row.ruleType !== 'custom_hours') {
      throw ruleNotFound();
    }

    await this.repo.removeById(id, doctorId);
    await this.audit.write({
      actorType,
      actorId,
      action: 'delete',
      entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.OVERRIDE,
      entityId: id,
      metadata: { before: { specificDate: row.specificDate, startTime: row.startTime, endTime: row.endTime } },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Blocked dates / leave                                                   */
  /* ---------------------------------------------------------------------- */

  async addBlock(doctorId: string, actorType: ActorType, actorId: string, dto: BlockRuleInput): Promise<DoctorAvailabilityRow> {
    this.assertBlockTimesPaired(dto.startTime, dto.endTime);
    if (dto.startTime && dto.endTime) {
      this.assertTimeOrder(dto.startTime, dto.endTime);
    }

    return this.db.transaction(async (tx) => {
      await this.lockDateGuard(tx, doctorId, dto.specificDate);

      const existing = await this.repo.listForRange(doctorId, dto.specificDate, dto.specificDate, tx);
      const sameDateBlocks = existing.filter((r) => r.ruleType === 'blocked' && r.specificDate === dto.specificDate);
      this.assertNoOverlapForDate(
        { startTime: dto.startTime ?? null, endTime: dto.endTime ?? null },
        sameDateBlocks,
        'A block for this date already exists and would overlap.',
      );

      const row = await this.repo.addBlock(doctorId, dto, tx);
      await this.audit.write(
        {
          actorType,
          actorId,
          action: 'create',
          entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.BLOCK,
          entityId: row.id,
          metadata: { after: dto },
        },
        tx,
      );
      return row;
    });
  }

  async removeBlock(doctorId: string, actorType: ActorType, actorId: string, id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row || row.doctorId !== doctorId || row.ruleType !== 'blocked') {
      throw ruleNotFound();
    }

    await this.repo.removeById(id, doctorId);
    await this.audit.write({
      actorType,
      actorId,
      action: 'delete',
      entityType: AVAILABILITY_AUDIT_ENTITY_TYPES.BLOCK,
      entityId: id,
      metadata: { before: { specificDate: row.specificDate, startTime: row.startTime, endTime: row.endTime } },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Shared validation                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Serializes `addOverride`/`addBlock` for one `(doctorId, specificDate)`
   * pair against a single named advisory lock for the lifetime of the
   * caller's transaction — same `pg_advisory_xact_lock` pattern
   * `identity-access.repository.ts#lockSuperAdminGuard` uses. Without this,
   * two concurrent requests adding an override/block for the SAME date could
   * each read "nothing here yet, no overlap" under READ COMMITTED before
   * either commits, and both insert — silently producing two overlapping
   * `doctor_availability` rows despite `assertNoOverlapForDate`'s check, since
   * there is no DB constraint (unique or exclusion) backing overlap-freedom
   * here (see the class doc comment). Call BEFORE reading existing rows for
   * that date, inside the same transaction as the insert.
   */
  private async lockDateGuard(executor: DatabaseTransaction, doctorId: string, specificDate: string): Promise<void> {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${`availability.date_guard:${doctorId}:${specificDate}`}))`);
  }

  private assertTimeOrder(startTime: string, endTime: string): void {
    if (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) {
      throw invalidRuleShape('endTime must be strictly after startTime.');
    }
  }

  /** A `blocked` rule's times must be both present (partial-day) or both absent (full-day) — never just one. Mirrors `doctor_availability_rule_shape_check`. */
  private assertBlockTimesPaired(startTime: string | null | undefined, endTime: string | null | undefined): void {
    const hasStart = startTime !== null && startTime !== undefined;
    const hasEnd = endTime !== null && endTime !== undefined;
    if (hasStart !== hasEnd) {
      throw invalidRuleShape('A block must set both startTime and endTime (a partial-day block) or neither (a full-day block).');
    }
  }

  /**
   * Same-type, same-date overlap check for overrides/blocks: a new full-day
   * entry (`startTime === null`) conflicts with ANY existing entry for that
   * date/type; two partial entries conflict only if their time ranges
   * intersect.
   */
  private assertNoOverlapForDate(
    incoming: { startTime: string | null; endTime: string | null },
    existing: DoctorAvailabilityRow[],
    message: string,
  ): void {
    const incomingIsFullDay = incoming.startTime === null;
    for (const row of existing) {
      const existingIsFullDay = row.startTime === null;
      if (incomingIsFullDay || existingIsFullDay) {
        throw overlappingRule(message);
      }
      if (this.rangesOverlap({ startTime: incoming.startTime as string, endTime: incoming.endTime as string }, { startTime: row.startTime as string, endTime: row.endTime as string })) {
        throw overlappingRule(message);
      }
    }
  }

  private hasOverlap(ranges: TimeRange[]): boolean {
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        if (this.rangesOverlap(ranges[i] as TimeRange, ranges[j] as TimeRange)) {
          return true;
        }
      }
    }
    return false;
  }

  private rangesOverlap(a: TimeRange, b: TimeRange): boolean {
    const aStart = parseTimeToMinutes(a.startTime);
    const aEnd = parseTimeToMinutes(a.endTime);
    const bStart = parseTimeToMinutes(b.startTime);
    const bEnd = parseTimeToMinutes(b.endTime);
    return aStart < bEnd && bStart < aEnd;
  }
}
