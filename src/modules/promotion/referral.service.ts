import { randomInt } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import type { ReferralEventRow } from '../../schema/referral-events.schema';
import type { ReferralRewardRole } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import {
  CODE_ALLOCATION_ATTEMPTS,
  REFERRAL_CODE_BODY_LENGTH,
  REFERRAL_CODE_PREFIX,
  REWARD_CODE_BODY_LENGTH,
  REWARD_CODE_PREFIX,
  buildGeneratedCode,
} from './promotion-code.util';
import { PromotionConfigService } from './promotion-config.service';
import { PromotionRepository } from './promotion.repository';
import { ReferralRepository } from './referral.repository';
import type { PatientReferralSummary } from './promotion.contract';
import {
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_ERROR_CODES,
  type ReferralProgramConfig,
  type ReferralRewardConfig,
} from './promotion.constants';

/**
 * *** REFER AND EARN. THE TWO HALVES ARE NOT SYMMETRIC. ***
 *
 * ── THE REFEREE'S DISCOUNT IS THE CODE ITSELF ─────────────────────────────
 *
 * They type their friend's referral code at checkout and it comes off THAT
 * bill, through the ordinary `PromotionService.reserve` path — a `kind =
 * 'referral'` instrument is a coupon owned by a patient, and nothing about
 * redeeming it is special. Nothing is minted for the referee unless an admin
 * explicitly turns `refereeReward` on, because minting one by default would pay
 * the same side twice for one referral.
 *
 * ── THE REFERRER'S REWARD MINTS AT THE QUALIFYING STATUS, NEVER AT CAPTURE ──
 *
 * `referral-events.schema.ts` states the attack in full: "Minting at payment
 * capture would be trivially farmable. Refer a burner account, book, pay, take
 * the referee's discount, then cancel inside the free-cancellation window that
 * `booking-policy.engine.ts` already auto-refunds — and the referrer walks away
 * with a reward the platform funded out of nothing."
 *
 * So a `referral_events` row is born `qualifying` at reserve time and becomes
 * `qualified` only when the consultation reaches a status in
 * `promotion.referral_qualifying_statuses`. The reward mints then, and only
 * then.
 *
 * *** THE DEPLOYMENT TRAP. *** The natural qualifying status is `completed`,
 * which is set by M-15 — a module that does not exist. Read
 * `PROMOTION_DEFAULT_QUALIFYING_STATUSES` before assuming any of this fires
 * today: with the compiled-in default, NOTHING in this codebase moves a
 * consultation into a qualifying status, so no reward will EVER mint until
 * either M-15 lands or an admin widens the key from the panel.
 *
 * ── ATTRIBUTION IS EXPLICIT, NEVER INFERRED ───────────────────────────────
 *
 * The referee TYPES the code. No cookie, no window, no device match — a
 * deliberate asymmetry with affiliate LINKS, because a durable inferred
 * patient-to-patient link in a mental-health app is a privacy cost with no
 * product return (`docs/SRS.md` §6.2, minimum necessary).
 *
 * ── IDEMPOTENCY IS AN INDEX, NOT A FLAG ───────────────────────────────────
 *
 * `discount_instruments_referral_reward_once_idx` on
 * `(referral_event_id, referral_reward_role)` is what guarantees at most one
 * reward per side. A replayed event, a sweep pass and a manual retry can all
 * race safely, and the loser's `ON CONFLICT DO NOTHING` returns `null` — a
 * SUCCESS, because the reward exists.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: PromotionRepository,
    private readonly events: ReferralRepository,
    private readonly config: PromotionConfigService,
    private readonly audit: AuditService,
  ) {}

  /* ====================================================================== */
  /* The patient's own referral code — minted LAZILY                        */
  /* ====================================================================== */

  /**
   * A patient's referral code, created on first ask.
   *
   * *** LAZY ON PURPOSE. *** Most patients never refer anyone, and minting a
   * code for every signup would fill `discount_instruments` with rows that are
   * never typed — each of which occupies the ONE shared `code` namespace and
   * makes a real campaign's chosen code slightly likelier to collide. It also
   * keeps the row count of the table that backs every checkout lookup
   * proportional to actual use.
   *
   * `discount_instruments_one_referral_per_patient_idx` guarantees a patient
   * ends up with exactly one live code however many times this races.
   */
  async getOrCreateReferralCode(patientId: string): Promise<PatientReferralSummary> {
    const config = await this.config.getResolved();
    if (!config.referralProgram.enabled) {
      throw new ConflictException({
        code: PROMOTION_ERROR_CODES.REFERRAL_DISABLED,
        message: 'The referral programme is not currently running.',
      });
    }

    const existing = await this.repo.findReferralInstrumentForPatient(patientId);
    const instrument = existing ?? (await this.mintReferralCode(patientId, config.referralProgram));

    const counts = await this.events.countForReferrerGrouped(patientId, ['qualifying', 'qualified']);
    const rewards = await this.repo.listRedeemableForPatient(patientId, new Date());

    return {
      code: instrument.code,
      instrumentId: instrument.id,
      label: instrument.label,
      pendingCount: counts.get('qualifying') ?? 0,
      qualifiedCount: counts.get('qualified') ?? 0,
      availableRewards: rewards
        .filter((row) => row.kind === 'referral_reward')
        .map((row) => ({ code: row.code, label: row.label, validTo: row.validTo?.toISOString() ?? null })),
    };
  }

  /**
   * Mints the instrument itself.
   *
   * The REFEREE-FACING value lives on this instrument — it is what comes off the
   * friend's first bill. It is taken from `referrerReward`'s shape only when
   * `refereeReward` is disabled, because in that configuration the referral code
   * IS the referee's entire benefit and it should be worth something.
   *
   * `maxRedemptionsPerUser: 1` because being referred is a once-ever event
   * anyway (`referral_events_referee_once_idx`); stating it here means
   * `discount_redemptions_single_use_per_user_idx` also guards it, so two
   * defences rather than one.
   */
  private async mintReferralCode(patientId: string, program: ReferralProgramConfig): Promise<DiscountInstrumentRow> {
    const side = program.refereeReward.enabled ? program.refereeReward : program.referrerReward;

    for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const code = buildGeneratedCode(REFERRAL_CODE_PREFIX, REFERRAL_CODE_BODY_LENGTH, randomInt);
      try {
        return await this.db.transaction(async (tx) => {
          const created = await this.repo.insertInstrument(
            {
              code,
              kind: 'referral',
              status: 'active',
              label: 'Referral code',
              description: null,
              // NEVER listed. A referral code belongs to one patient and is
              // shared by them; putting it in a public campaign list would make
              // every patient's code discoverable by every other.
              isPubliclyListed: false,
              valueKind: side.valueKind,
              flatAmount: side.flatAmount,
              percentRate: side.percentRate,
              maxDiscountAmount: side.maxDiscountAmount,
              minOrderAmount: side.minOrderAmount,
              referrerPatientId: patientId,
              maxRedemptionsPerUser: 1,
              // Uncapped in total by design: the per-referrer cap is enforced on
              // QUALIFICATION (`maxQualifiedReferralsPerReferrer`), not on how
              // many friends may type the code. Capping redemptions would refuse
              // the eleventh friend at checkout, which punishes the friend for
              // the referrer's popularity.
              maxTotalRedemptions: null,
              maxDistinctRedeemers: null,
              createdByAdminId: null,
            },
            tx,
          );

          await this.audit.write(
            {
              actorType: 'patient',
              actorId: patientId,
              action: 'create',
              entityType: PROMOTION_AUDIT_ENTITY_TYPES.INSTRUMENT,
              entityId: created.id,
              metadata: { kind: 'referral', code: created.code, source: 'lazy_mint_on_first_request' },
            },
            tx,
          );
          return created;
        });
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;

        // Either the generated code collided, or another request for the SAME
        // patient won the race on
        // `discount_instruments_one_referral_per_patient_idx`. The second case is
        // not a retry — the code now exists and is the right answer.
        const existing = await this.repo.findReferralInstrumentForPatient(patientId);
        if (existing) return existing;
      }
    }

    throw new ConflictException({
      code: PROMOTION_ERROR_CODES.CODE_ALLOCATION_FAILED,
      message: 'Could not allocate a referral code. Please try again.',
    });
  }

  /* ====================================================================== */
  /* Qualification and reward minting                                       */
  /* ====================================================================== */

  /**
   * `qualifying` -> `qualified`, and mint whatever the programme owes.
   *
   * Driven only by the sweep, which is the component that knows a consultation's
   * status. One transaction: lock the event, flip it, mint each enabled side.
   *
   * *** THE PER-REFERRER CAP IS CHECKED UNDER A PER-REFERRER LOCK, NOT THE
   * EVENT'S. *** Counted from `referral_events`, never stored — the same
   * reasoning as the instrument caps. But unlike an instrument cap, the count
   * spans MANY event rows, and locking the one event being qualified serialises
   * nothing: two of this referrer's referrals qualifying at the same moment lock
   * two different rows, each reads a count that excludes the other, and a cap of
   * 1 mints twice. Two instances sweeping concurrently is the documented normal
   * case (`promotion-sweep.service.ts`), so this is a race that happens, not one
   * that could. `ReferralRepository.lockReferrerGuard` closes it; the event's own
   * row lock stays, because it is what stops two callers qualifying the SAME
   * event twice.
   *
   * A referrer over their cap still has the event marked `qualified` (it DID
   * qualify; that is a fact about the consultation) but no reward is minted, and
   * the audit row says why. Recording it as `void` instead would misstate what
   * happened.
   */
  async qualify(eventId: string): Promise<{ qualified: boolean; mintedRewardIds: string[] }> {
    const config = await this.config.getResolved();

    return this.db.transaction(async (tx) => {
      // Read the event first, WITHOUT a lock, only to learn whose referral this
      // is. `referrer_patient_id` is immutable once written.
      const candidate = await this.events.findEventById(eventId, tx);
      if (!candidate || candidate.status !== 'qualifying') return { qualified: false, mintedRewardIds: [] };

      // *** THE PER-REFERRER LOCK, TAKEN BEFORE THE ROW LOCK AND BEFORE THE
      // COUNT. *** Everything below is serialised per referrer, which is the
      // scope `countQualifiedForReferrer` actually counts over.
      await this.events.lockReferrerGuard(candidate.referrerPatientId, tx);

      const locked = await this.events.findEventByIdForUpdate(eventId, tx);
      if (!locked || locked.status !== 'qualifying') return { qualified: false, mintedRewardIds: [] };

      const qualified = await this.events.markQualifiedIfQualifying(eventId, new Date(), tx);
      if (!qualified) return { qualified: false, mintedRewardIds: [] };

      // *** THE TERMS IN FORCE WHEN THE REFERRAL HAPPENED, NOT TODAY'S. ***
      // `referral_events.program_snapshot` is "copied whole" for exactly this
      // moment: a config edit must not change what an in-flight referral is
      // worth. Today's config is the fallback only if the snapshot is unusable.
      const program = this.readSnapshot(qualified) ?? config.referralProgram;

      const cap = program.maxQualifiedReferralsPerReferrer;
      const alreadyQualified = await this.events.countQualifiedForReferrer(qualified.referrerPatientId, tx);
      // `alreadyQualified` includes the row just flipped, so the cap is
      // "> cap", not ">= cap".
      const overCap = cap !== null && alreadyQualified > cap;

      const mintedRewardIds: string[] = [];
      if (!overCap) {
        const referrer = await this.mintReward(qualified, 'referrer', qualified.referrerPatientId, program.referrerReward, tx);
        if (referrer) mintedRewardIds.push(referrer);
        const referee = await this.mintReward(qualified, 'referee', qualified.refereePatientId, program.refereeReward, tx);
        if (referee) mintedRewardIds.push(referee);
      }

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.REFERRAL_EVENT,
          entityId: qualified.id,
          consultationId: qualified.consultationId,
          metadata: {
            change: 'qualified',
            before: 'qualifying',
            after: 'qualified',
            referrerPatientId: qualified.referrerPatientId,
            refereePatientId: qualified.refereePatientId,
            mintedRewardIds,
            perReferrerCap: cap,
            qualifiedForReferrer: alreadyQualified,
            rewardsSuppressedByCap: overCap,
          },
        },
        tx,
      );

      return { qualified: true, mintedRewardIds };
    });
  }

  /** `qualifying` -> `void`. The consultation died, so this referral will never earn anything. */
  async voidEvent(eventId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const voided = await this.events.markVoidIfQualifying(eventId, reason, tx);
      if (!voided) return false;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.REFERRAL_EVENT,
          entityId: voided.id,
          consultationId: voided.consultationId,
          metadata: { change: 'void', before: 'qualifying', after: 'void', reason },
        },
        tx,
      );
      return true;
    });
  }

  /**
   * Mints one side's reward as a `kind = 'referral_reward'` instrument assigned
   * to that patient.
   *
   * *** IDEMPOTENT BY INDEX. *** `insertRewardInstrumentIfAbsent` uses
   * `ON CONFLICT DO NOTHING` against
   * `discount_instruments_referral_reward_once_idx`, so this can be called by a
   * replay, a retry and a concurrent sweep and at most one row exists. `null`
   * back means somebody else minted it, which is a success.
   *
   * The code is generated with retries because the ONE shared `code` namespace
   * makes a collision possible in principle — vanishingly unlikely at 9 body
   * characters over a 32-symbol alphabet, but "unlikely" is not a plan.
   */
  private async mintReward(
    event: ReferralEventRow,
    role: ReferralRewardRole,
    patientId: string,
    reward: ReferralRewardConfig,
    tx: DatabaseTransaction,
  ): Promise<string | null> {
    if (!reward.enabled) return null;

    const validTo = new Date(Date.now() + reward.validityDays * 24 * 60 * 60 * 1000);

    for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const code = buildGeneratedCode(REWARD_CODE_PREFIX, REWARD_CODE_BODY_LENGTH, randomInt);
      const created = await this.repo.insertRewardInstrumentIfAbsent(
        {
          code,
          kind: 'referral_reward',
          status: 'active',
          label: reward.label,
          description: null,
          isPubliclyListed: false,
          valueKind: reward.valueKind,
          flatAmount: reward.flatAmount,
          percentRate: reward.percentRate,
          maxDiscountAmount: reward.maxDiscountAmount,
          minOrderAmount: reward.minOrderAmount,
          validTo,
          assignedPatientId: patientId,
          referralEventId: event.id,
          referralRewardRole: role,
          maxRedemptionsPerUser: 1,
          maxTotalRedemptions: 1,
          createdByAdminId: null,
        },
        tx,
      );

      if (created) {
        await this.audit.write(
          {
            actorType: 'system',
            actorId: null,
            action: 'create',
            entityType: PROMOTION_AUDIT_ENTITY_TYPES.INSTRUMENT,
            entityId: created.id,
            consultationId: event.consultationId,
            metadata: {
              kind: 'referral_reward',
              role,
              code: created.code,
              assignedPatientId: patientId,
              referralEventId: event.id,
              validTo: validTo.toISOString(),
            },
          },
          tx,
        );
        return created.id;
      }

      // `ON CONFLICT DO NOTHING` swallowed it. Two constraints could have fired:
      // the reward-once index (already minted — stop, that is the point) or the
      // code's own unique (a collision — retry with a new code). Telling them
      // apart costs a read; doing it is what stops a code collision from being
      // silently reported as "already minted".
      const already = await this.repo.findInstrumentByCode(code, tx);
      if (already === null) return null;
    }

    this.logger.error(
      `Could not allocate a reward code for referral event ${event.id} (${role}) in ${CODE_ALLOCATION_ATTEMPTS} attempts. The sweep will retry.`,
    );
    return null;
  }

  /**
   * Reads the programme terms frozen onto the event.
   *
   * Tolerant: a snapshot written by an older release, or by hand, may not have
   * today's shape. `null` back means "use the current config", which is a
   * defensible degradation — the alternative is a sweep that throws forever on
   * one bad row and stops qualifying everybody else's referrals.
   */
  private readSnapshot(event: ReferralEventRow): ReferralProgramConfig | null {
    const snapshot = event.programSnapshot;
    if (typeof snapshot !== 'object' || snapshot === null) return null;
    const candidate = snapshot as Partial<ReferralProgramConfig>;
    if (typeof candidate.referrerReward !== 'object' || candidate.referrerReward === null) return null;
    if (typeof candidate.refereeReward !== 'object' || candidate.refereeReward === null) return null;
    return candidate as ReferralProgramConfig;
  }
}
