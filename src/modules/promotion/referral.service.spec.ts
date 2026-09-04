import { ConflictException } from '@nestjs/common';
import type { ReferralEventRow } from '../../schema/referral-events.schema';
import { ReferralService } from './referral.service';
import { PROMOTION_DEFAULT_REFERRAL_PROGRAM, type ReferralProgramConfig } from './promotion.constants';

/**
 * *** THE REFER-AND-EARN RULES. THE TWO HALVES ARE NOT SYMMETRIC. ***
 *
 * The referee's discount IS the referral code — it comes off their bill through
 * the ordinary reserve path, and nothing special happens. The REFERRER's reward
 * mints only when the referee's consultation reaches a QUALIFYING STATUS, which
 * is the whole anti-farming design: mint-at-capture is trivially farmable
 * (refer a burner account, book, pay, take the discount, cancel inside the
 * free-cancellation window that already auto-refunds).
 *
 * Hand-rolled `jest.fn()` mocks and `new ReferralService(...)`. The abuse cases
 * that depend on a real index — repeat referee, circular referral — are proved
 * in `promotion.redemption-race.integration.spec.ts`, because they are facts
 * about the migration rather than about this class.
 */

const REFERRER = 'ref-patient-1';
const REFEREE = 'ref-patient-2';

function event(overrides: Partial<ReferralEventRow> = {}): ReferralEventRow {
  return {
    id: 'event-1',
    referralInstrumentId: 'inst-1',
    referrerPatientId: REFERRER,
    refereePatientId: REFEREE,
    consultationId: 'consult-1',
    redemptionId: 'red-1',
    status: 'qualifying',
    programSnapshot: PROMOTION_DEFAULT_REFERRAL_PROGRAM,
    qualifiedAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as ReferralEventRow;
}

function build(
  overrides: {
    repo?: Record<string, jest.Mock>;
    events?: Record<string, jest.Mock>;
    program?: Partial<ReferralProgramConfig>;
  } = {},
) {
  const repo = {
    findReferralInstrumentForPatient: jest.fn().mockResolvedValue(null),
    insertInstrument: jest.fn(),
    insertRewardInstrumentIfAbsent: jest.fn().mockResolvedValue({ id: 'reward-1', code: 'RWABC' }),
    findInstrumentByCode: jest.fn().mockResolvedValue(null),
    listRedeemableForPatient: jest.fn().mockResolvedValue([]),
    ...overrides.repo,
  };

  const events = {
    findEventById: jest.fn().mockResolvedValue(event()),
    // The per-referrer advisory lock `qualify` takes before it counts. A no-op
    // here — a mock cannot demonstrate `pg_advisory_xact_lock` serialising two
    // transactions, which is why that guarantee is proved against a real
    // database in `promotion.redemption-race.integration.spec.ts` instead.
    lockReferrerGuard: jest.fn().mockResolvedValue(undefined),
    findEventByIdForUpdate: jest.fn().mockResolvedValue(event()),
    markQualifiedIfQualifying: jest.fn().mockResolvedValue(event({ status: 'qualified' })),
    markVoidIfQualifying: jest.fn().mockResolvedValue(event({ status: 'void' })),
    countQualifiedForReferrer: jest.fn().mockResolvedValue(1),
    countForReferrerGrouped: jest.fn().mockResolvedValue(new Map()),
    ...overrides.events,
  };

  const program: ReferralProgramConfig = { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, ...overrides.program };
  const config = { getResolved: jest.fn().mockResolvedValue({ referralProgram: program }) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const db = { transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) };

  const service = new ReferralService(db as never, repo as never, events as never, config as never, audit as never);
  return { service, repo, events, config, audit, db, program };
}

describe('ReferralService', () => {
  describe('getOrCreateReferralCode — LAZY, because most patients never refer anyone', () => {
    it('returns the existing code without minting a second one', async () => {
      const existing = { id: 'inst-1', code: 'REFEXISTS', label: 'Referral code', kind: 'referral' };
      const { service, repo } = build({
        repo: { findReferralInstrumentForPatient: jest.fn().mockResolvedValue(existing) },
      });

      const summary = await service.getOrCreateReferralCode(REFERRER);
      expect(summary.code).toBe('REFEXISTS');
      expect(repo.insertInstrument).not.toHaveBeenCalled();
    });

    it('mints on first ask, NEVER publicly listed', async () => {
      // A referral code belongs to one patient and is shared by them. Listing it
      // publicly would make every patient's code discoverable by every other.
      const { service, repo } = build({
        repo: { insertInstrument: jest.fn().mockResolvedValue({ id: 'inst-9', code: 'REFNEW', label: 'Referral code' }) },
      });

      await service.getOrCreateReferralCode(REFERRER);
      expect(repo.insertInstrument).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'referral',
          status: 'active',
          isPubliclyListed: false,
          referrerPatientId: REFERRER,
          maxRedemptionsPerUser: 1,
          // Uncapped in TOTAL by design: the per-referrer cap is enforced on
          // QUALIFICATION, not on how many friends may type the code. Capping
          // redemptions would refuse the eleventh friend at checkout, punishing
          // the friend for the referrer's popularity.
          maxTotalRedemptions: null,
        }),
        expect.anything(),
      );
    });

    it('generates a code that would satisfy the CHECK constraint', async () => {
      const { service, repo } = build({
        repo: { insertInstrument: jest.fn().mockResolvedValue({ id: 'i', code: 'X', label: 'l' }) },
      });
      await service.getOrCreateReferralCode(REFERRER);

      const written = repo.insertInstrument.mock.calls[0][0] as { code: string };
      expect(written.code).toMatch(/^REF[A-Z0-9]{8}$/);
    });

    it('*** ON A LOST RACE FOR THE SAME PATIENT, returns the winner rather than retrying ***', async () => {
      // `discount_instruments_one_referral_per_patient_idx` guarantees one live
      // code per patient. A conflict there is not a code collision — the code
      // now EXISTS and is the right answer.
      const winner = { id: 'inst-win', code: 'REFWINNER', label: 'Referral code' };
      const findMock = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      const { service, repo } = build({
        repo: {
          findReferralInstrumentForPatient: findMock,
          insertInstrument: jest.fn().mockRejectedValue({ code: '23505', constraint: 'discount_instruments_one_referral_per_patient_idx' }),
        },
      });

      const summary = await service.getOrCreateReferralCode(REFERRER);
      expect(summary.code).toBe('REFWINNER');
      // Exactly one insert attempt — it did not burn its retry budget.
      expect(repo.insertInstrument).toHaveBeenCalledTimes(1);
    });

    it('refuses when the programme is switched off', async () => {
      const { service } = build({ program: { enabled: false } });
      await expect(service.getOrCreateReferralCode(REFERRER)).rejects.toThrow(ConflictException);
    });

    it('reports COUNTS, never the referees’ identities', async () => {
      // `docs/SRS.md` §6.2, minimum necessary. A referrer learns how many
      // referrals qualified; they never learn which of their friends did or did
      // not attend a consultation.
      const { service } = build({
        repo: { findReferralInstrumentForPatient: jest.fn().mockResolvedValue({ id: 'i', code: 'REFX', label: 'l' }) },
        events: {
          countForReferrerGrouped: jest.fn().mockResolvedValue(new Map([['qualifying', 2], ['qualified', 3]])),
        },
      });

      const summary = await service.getOrCreateReferralCode(REFERRER);
      expect(summary).toMatchObject({ pendingCount: 2, qualifiedCount: 3 });
      expect(JSON.stringify(summary)).not.toContain(REFEREE);
    });
  });

  describe('qualify — the anti-farming gate', () => {
    it('flips the event and mints the REFERRER’s reward', async () => {
      const { service, repo } = build();
      const result = await service.qualify('event-1');

      expect(result.qualified).toBe(true);
      expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'referral_reward',
          referralRewardRole: 'referrer',
          assignedPatientId: REFERRER,
          referralEventId: 'event-1',
          maxTotalRedemptions: 1,
          maxRedemptionsPerUser: 1,
        }),
        expect.anything(),
      );
    });

    it('*** DOES NOT MINT THE REFEREE A SECOND REWARD BY DEFAULT ***', async () => {
      // Their discount was the code itself. Minting again would pay one side
      // twice for one referral.
      const { service, repo } = build();
      await service.qualify('event-1');

      const roles = repo.insertRewardInstrumentIfAbsent.mock.calls.map(
        (call) => (call[0] as { referralRewardRole: string }).referralRewardRole,
      );
      expect(roles).toEqual(['referrer']);
    });

    it('mints BOTH sides when an admin has configured both, independently', async () => {
      const { service, repo } = build({
        program: {
          refereeReward: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.refereeReward, enabled: true, flatAmount: '50.00' },
        },
        events: {
          markQualifiedIfQualifying: jest.fn().mockResolvedValue(
            event({ status: 'qualified', programSnapshot: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, refereeReward: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.refereeReward, enabled: true, flatAmount: '50.00' } } }),
          ),
        },
      });

      await service.qualify('event-1');
      const calls = repo.insertRewardInstrumentIfAbsent.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(calls.map((c) => c.referralRewardRole)).toEqual(['referrer', 'referee']);
      expect(calls[0].assignedPatientId).toBe(REFERRER);
      expect(calls[1].assignedPatientId).toBe(REFEREE);
      expect(calls[1].flatAmount).toBe('50.00');
    });

    it('does nothing when the event is not `qualifying` — a second sweep pass is a no-op', async () => {
      const { service, repo } = build({
        events: { findEventByIdForUpdate: jest.fn().mockResolvedValue(event({ status: 'qualified' })) },
      });

      expect(await service.qualify('event-1')).toEqual({ qualified: false, mintedRewardIds: [] });
      expect(repo.insertRewardInstrumentIfAbsent).not.toHaveBeenCalled();
    });

    it('*** USES THE SNAPSHOT, NOT TODAY’S CONFIG ***', async () => {
      // `referral_events.program_snapshot` is copied whole at reserve time
      // precisely so a config edit cannot change what an in-flight referral is
      // worth — the same reason a consultation pins its follow-up pathway
      // version.
      const oldTerms = {
        ...PROMOTION_DEFAULT_REFERRAL_PROGRAM,
        referrerReward: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward, flatAmount: '250.00', label: 'Launch bonus' },
      };
      const { service, repo } = build({
        program: { referrerReward: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward, flatAmount: '10.00' } },
        events: {
          markQualifiedIfQualifying: jest.fn().mockResolvedValue(event({ status: 'qualified', programSnapshot: oldTerms })),
        },
      });

      await service.qualify('event-1');
      expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ flatAmount: '250.00', label: 'Launch bonus' }),
        expect.anything(),
      );
    });

    it('falls back to current config when the snapshot is unusable, rather than throwing forever', async () => {
      // A sweep that threw on one malformed row would stop qualifying everybody
      // else's referrals too.
      const { service, repo } = build({
        events: {
          markQualifiedIfQualifying: jest.fn().mockResolvedValue(event({ status: 'qualified', programSnapshot: 'garbage' as never })),
        },
      });

      const result = await service.qualify('event-1');
      expect(result.qualified).toBe(true);
      expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalled();
    });

    describe('the per-referrer cap', () => {
      it('*** TAKES THE PER-REFERRER LOCK BEFORE IT COUNTS — the event’s own row lock is the wrong scope ***', async () => {
        // ════════════════════════════════════════════════════════════════════
        // `countQualifiedForReferrer` counts MANY event rows, and the lock on
        // the ONE event being flipped serialises none of them. Two of this
        // referrer's referrals qualifying at the same moment lock two different
        // rows, each reads a count that excludes the other, and a cap of 1 mints
        // twice — proved against a real database in
        // `promotion.redemption-race.integration.spec.ts`, where it happens
        // because two instances sweeping concurrently is the documented normal
        // case.
        //
        // A mock cannot show `pg_advisory_xact_lock` blocking anything. What it
        // CAN pin is the ORDER, and the order is the fix: the referrer guard
        // must be taken before the count it protects.
        // ════════════════════════════════════════════════════════════════════
        const order: string[] = [];
        const { service } = build({
          events: {
            lockReferrerGuard: jest.fn(async () => {
              order.push('lock');
            }),
            countQualifiedForReferrer: jest.fn(async () => {
              order.push('count');
              return 1;
            }),
          },
        });

        await service.qualify('event-1');
        expect(order).toEqual(['lock', 'count']);
      });

      it('locks the REFERRER named on the event, not the event id', async () => {
        const { service, events } = build();
        await service.qualify('event-1');
        expect(events.lockReferrerGuard).toHaveBeenCalledWith(REFERRER, expect.anything());
      });

      it('*** SUPPRESSES THE REWARD BUT STILL MARKS THE EVENT QUALIFIED ***', async () => {
        // It DID qualify — that is a fact about the consultation. Recording it
        // as `void` instead would misstate what happened; the audit row carries
        // the reason the reward was withheld.
        const { service, repo, audit } = build({
          program: { maxQualifiedReferralsPerReferrer: 3 },
          events: {
            markQualifiedIfQualifying: jest.fn().mockResolvedValue(
              event({ status: 'qualified', programSnapshot: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, maxQualifiedReferralsPerReferrer: 3 } }),
            ),
            countQualifiedForReferrer: jest.fn().mockResolvedValue(4),
          },
        });

        const result = await service.qualify('event-1');
        expect(result).toEqual({ qualified: true, mintedRewardIds: [] });
        expect(repo.insertRewardInstrumentIfAbsent).not.toHaveBeenCalled();
        expect(audit.write).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: expect.objectContaining({ rewardsSuppressedByCap: true, perReferrerCap: 3 }) }),
          expect.anything(),
        );
      });

      it('counts the row just flipped, so the cap is "> cap" and the Nth referral still pays', async () => {
        // Off-by-one guard: `countQualifiedForReferrer` runs AFTER the flip, so
        // the third qualifying referral under a cap of 3 reads 3, not 2.
        const { service, repo } = build({
          events: {
            markQualifiedIfQualifying: jest.fn().mockResolvedValue(
              event({ status: 'qualified', programSnapshot: { ...PROMOTION_DEFAULT_REFERRAL_PROGRAM, maxQualifiedReferralsPerReferrer: 3 } }),
            ),
            countQualifiedForReferrer: jest.fn().mockResolvedValue(3),
          },
        });

        await service.qualify('event-1');
        expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalled();
      });

      it('never suppresses when the cap is null', async () => {
        const { service, repo } = build({
          events: { countQualifiedForReferrer: jest.fn().mockResolvedValue(9_999) },
        });
        await service.qualify('event-1');
        expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalled();
      });
    });

    describe('mint idempotency is an INDEX, not a flag', () => {
      it('treats a swallowed conflict on the reward-once index as success', async () => {
        // `ON CONFLICT DO NOTHING` against
        // `discount_instruments_referral_reward_once_idx`. A replayed event, a
        // sweep pass and a manual retry can all race safely, and the loser gets
        // `null` back — which means the reward EXISTS.
        const { service, repo } = build({
          repo: {
            insertRewardInstrumentIfAbsent: jest.fn().mockResolvedValue(null),
            // The code was NOT taken, so the conflict must have been the
            // reward-once index rather than a code collision.
            findInstrumentByCode: jest.fn().mockResolvedValue(null),
          },
        });

        const result = await service.qualify('event-1');
        expect(result.qualified).toBe(true);
        expect(result.mintedRewardIds).toEqual([]);
        // It stopped, rather than burning five retries on a conflict that will
        // never clear.
        expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalledTimes(1);
      });

      it('*** RETRIES A CODE COLLISION, which is a different conflict entirely ***', async () => {
        // Telling the two apart costs one read, and doing it is what stops a
        // code collision from being silently reported as "already minted".
        const { service, repo } = build({
          repo: {
            insertRewardInstrumentIfAbsent: jest
              .fn()
              .mockResolvedValueOnce(null)
              .mockResolvedValueOnce({ id: 'reward-2', code: 'RWOK' }),
            // The code WAS taken — a collision, so try another.
            findInstrumentByCode: jest.fn().mockResolvedValue({ id: 'someone-else' }),
          },
        });

        const result = await service.qualify('event-1');
        expect(repo.insertRewardInstrumentIfAbsent).toHaveBeenCalledTimes(2);
        expect(result.mintedRewardIds).toEqual(['reward-2']);
      });
    });

    it('gives the minted reward an expiry from the configured validity window', async () => {
      const { service, repo } = build();
      await service.qualify('event-1');

      const written = repo.insertRewardInstrumentIfAbsent.mock.calls[0][0] as { validTo: Date };
      const days = (written.validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(Math.round(days)).toBe(PROMOTION_DEFAULT_REFERRAL_PROGRAM.referrerReward.validityDays);
    });
  });

  describe('voidEvent', () => {
    it('voids a qualifying event and audits the transition', async () => {
      const { service, audit } = build();
      expect(await service.voidEvent('event-1', 'consultation_cancelled')).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ change: 'void', reason: 'consultation_cancelled' }) }),
        expect.anything(),
      );
    });

    it('*** NEVER TOUCHES A `qualified` EVENT ***', async () => {
      // Its reward is already minted, and clawing that back is an admin decision
      // with its own trail — not something a sweep does on a timer. The
      // repository's `WHERE status = 'qualifying'` guard is what enforces it.
      const { service, audit } = build({ events: { markVoidIfQualifying: jest.fn().mockResolvedValue(null) } });
      expect(await service.voidEvent('event-1', 'too_late')).toBe(false);
      expect(audit.write).not.toHaveBeenCalled();
    });
  });
});
