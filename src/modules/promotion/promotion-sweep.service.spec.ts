import { PromotionSweepService } from './promotion-sweep.service';
import { PROMOTION_SWEEP_BATCH_SIZE } from './promotion.constants';

/**
 * *** THE TIERED SWEEP, AND THE ONE RULE THAT MATTERS MOST: `unknown` MEANS
 * KEEP. ***
 *
 * `booking-slot-hold.service.ts` states the principle for slots — "Holding a
 * slot too long is a scheduling annoyance; releasing one under a live payment is
 * a money problem" — and it is harder here. Releasing a reservation returns a
 * redemption to the pool, so a capped coupon that has ALREADY been spent on a
 * live checkout can be spent again while the first patient's bill has already
 * been priced with it.
 *
 * `PROMOTION_BOOKING_LOOKUP_PORT` ships bound to a null object that reports
 * `unknown` for everything, so the tests below are not hypothetical: this is
 * how the sweep behaves in the tree TODAY, before the coordinator rebinds it.
 * An unbound port must not be able to leak a redemption.
 */

const CONFIG = {
  referralProgram: {} as never,
  referralQualifyingStatuses: ['completed'],
  affiliateEnabled: true,
  affiliateAttributionDays: 30,
  reservationGraceMinutes: 5,
  codeAttemptsPerPatientPerHour: 20,
  codeAttemptsPerIpPerHour: 60,
};

function candidate(consultationId: string, id = 'red-1') {
  return {
    redemptionId: id,
    instrumentId: 'inst-1',
    consultationId,
    patientId: 'patient-1',
    expiresAt: new Date('2020-01-01T00:00:00Z'),
  };
}

function build(
  overrides: {
    repo?: Record<string, jest.Mock>;
    referralRepo?: Record<string, jest.Mock>;
    affiliateRepo?: Record<string, jest.Mock>;
    promotions?: Record<string, jest.Mock>;
    referrals?: Record<string, jest.Mock>;
    affiliates?: Record<string, jest.Mock>;
    booking?: Record<string, jest.Mock>;
    config?: Partial<typeof CONFIG>;
  } = {},
) {
  const repo = { findExpiredReservationCandidates: jest.fn().mockResolvedValue([]), ...overrides.repo };
  const referralRepo = { findQualifyingCandidates: jest.fn().mockResolvedValue([]), ...overrides.referralRepo };
  const affiliateRepo = { findPendingCommissions: jest.fn().mockResolvedValue([]), ...overrides.affiliateRepo };

  const promotions = {
    release: jest.fn().mockResolvedValue({ reservationId: 'red-1', status: 'released' }),
    confirmFromSweep: jest.fn().mockResolvedValue(true),
    ...overrides.promotions,
  };

  const referrals = {
    qualify: jest.fn().mockResolvedValue({ qualified: true, mintedRewardIds: ['r1'] }),
    voidEvent: jest.fn().mockResolvedValue(true),
    ...overrides.referrals,
  };

  const affiliates = {
    accrueCommission: jest.fn().mockResolvedValue(true),
    voidPendingCommissionById: jest.fn().mockResolvedValue(true),
    ...overrides.affiliates,
  };

  const config = { getResolved: jest.fn().mockResolvedValue({ ...CONFIG, ...overrides.config }) };

  const booking = {
    getConsultationStatus: jest.fn().mockResolvedValue('unknown'),
    getConsultationStatuses: jest.fn().mockResolvedValue(new Map()),
    countPriorConsultations: jest.fn().mockResolvedValue('unknown'),
    ...overrides.booking,
  };

  const service = new PromotionSweepService(
    repo as never,
    referralRepo as never,
    affiliateRepo as never,
    promotions as never,
    referrals as never,
    affiliates as never,
    config as never,
    booking as never,
  );

  return { service, repo, referralRepo, affiliateRepo, promotions, referrals, affiliates, config, booking };
}

describe('PromotionSweepService', () => {
  describe('sweepOneReservation — the tiers', () => {
    it('*** `unknown` MEANS KEEP. An unbound port cannot leak a redemption. ***', async () => {
      const { service, promotions } = build();
      expect(await service.sweepOneReservation('consult-1', 'unknown')).toBe('kept');
      expect(promotions.release).not.toHaveBeenCalled();
      expect(promotions.confirmFromSweep).not.toHaveBeenCalled();
    });

    it('*** `pending_payment` MEANS KEEP, however long the reservation has been expired ***', async () => {
      // The patient may be mid-3-D-Secure at the exact moment the timer fires.
      // Releasing a discount under a live payment that has ALREADY been priced
      // with it lets the code be spent twice: this checkout still charges the
      // discounted amount, and the freed capacity lets somebody else take the
      // last redemption of a capped coupon. NEVER RELEASE ON A BLIND TIMER.
      const { service, promotions } = build();
      expect(await service.sweepOneReservation('consult-1', 'pending_payment')).toBe('kept');
      expect(promotions.release).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'no_show', 'expired'])('releases on a TERMINAL consultation (%s)', async (status) => {
      const { service, promotions } = build();
      expect(await service.sweepOneReservation('consult-1', status)).toBe('released');
      expect(promotions.release).toHaveBeenCalledWith({ consultationId: 'consult-1', reason: `consultation_${status}` });
    });

    it.each(['scheduled', 'awaiting_doctor', 'in_progress', 'awaiting_documentation', 'completed'])(
      'CONFIRMS on a paid/live consultation (%s) — the durable backstop for a lost payment.captured',
      async (status) => {
        const { service, promotions } = build();
        expect(await service.sweepOneReservation('consult-1', status)).toBe('confirmed');
        expect(promotions.confirmFromSweep).toHaveBeenCalledWith('consult-1', status);
      },
    );

    it('*** KEEPS on a status this module does not recognise ***', async () => {
      // The `keep` branch is the DEFAULT, not the exception. A new consultation
      // status added by a later module behaves conservatively rather than
      // releasing money-adjacent state.
      const { service, promotions } = build();
      expect(await service.sweepOneReservation('consult-1', 'some_future_status')).toBe('kept');
      expect(promotions.release).not.toHaveBeenCalled();
      expect(promotions.confirmFromSweep).not.toHaveBeenCalled();
    });

    it('reports `kept` when a release loses the race to a confirm', async () => {
      // `release` returns null when the row is already `consumed`, and the sweep
      // must count that honestly rather than claiming a release it did not make.
      const { service } = build({ promotions: { release: jest.fn().mockResolvedValue(null) } });
      expect(await service.sweepOneReservation('consult-1', 'cancelled')).toBe('kept');
    });
  });

  describe('sweepExpiredReservations', () => {
    it('asks the port ONCE for the whole batch, not once per candidate', async () => {
      // A hundred candidates must not become a hundred round trips — the port
      // becomes a TCP client the day this module is extracted.
      const candidates = Array.from({ length: 5 }, (_, i) => candidate(`c-${i}`, `red-${i}`));
      const { service, booking } = build({
        repo: { findExpiredReservationCandidates: jest.fn().mockResolvedValue(candidates) },
      });

      await service.sweepExpiredReservations();
      expect(booking.getConsultationStatuses).toHaveBeenCalledTimes(1);
      expect(booking.getConsultationStatuses).toHaveBeenCalledWith(['c-0', 'c-1', 'c-2', 'c-3', 'c-4']);
    });

    it('BOUNDS one pass, so a backlog drains steadily instead of in one spike', async () => {
      const { service, repo } = build();
      await service.sweepExpiredReservations();
      expect(repo.findExpiredReservationCandidates).toHaveBeenCalledWith(expect.any(Date), PROMOTION_SWEEP_BATCH_SIZE);
    });

    it('treats an id ABSENT from the port’s map as `unknown`, which means keep', async () => {
      // The contract says an absent id and an `unknown` id mean the same thing;
      // a caller that only handled one would release on the other.
      const { service, promotions } = build({
        repo: { findExpiredReservationCandidates: jest.fn().mockResolvedValue([candidate('c-1')]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map()) },
      });

      const result = await service.sweepExpiredReservations();
      expect(result).toMatchObject({ examined: 1, kept: 1, released: 0, confirmed: 0 });
      expect(promotions.release).not.toHaveBeenCalled();
    });

    it('*** KEEPS EVERYTHING when the port THROWS, rather than aborting the pass ***', async () => {
      // The contract says the port never throws and this module's null object
      // does not — but post-merge the binding is somebody else's adapter, and
      // eventually a TCP client. Degrading to "everything is unknown" keeps the
      // referral and commission halves running too.
      const { service, promotions } = build({
        repo: { findExpiredReservationCandidates: jest.fn().mockResolvedValue([candidate('c-1')]) },
        booking: { getConsultationStatuses: jest.fn().mockRejectedValue(new Error('port exploded')) },
      });

      const result = await service.sweepExpiredReservations();
      expect(result).toMatchObject({ examined: 1, kept: 1 });
      expect(promotions.release).not.toHaveBeenCalled();
    });

    it('counts a per-candidate failure and CARRIES ON with the rest', async () => {
      const { service } = build({
        repo: {
          findExpiredReservationCandidates: jest.fn().mockResolvedValue([candidate('c-1', 'r1'), candidate('c-2', 'r2')]),
        },
        booking: {
          getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'cancelled'], ['c-2', 'cancelled']])),
        },
        promotions: {
          release: jest.fn().mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce({ status: 'released' }),
        },
      });

      const result = await service.sweepExpiredReservations();
      expect(result).toMatchObject({ examined: 2, failed: 1, released: 1 });
    });

    it('does no port work at all when there are no candidates', async () => {
      const { service, booking } = build();
      const result = await service.sweepExpiredReservations();
      expect(result).toEqual({ examined: 0, released: 0, confirmed: 0, kept: 0, failed: 0 });
      expect(booking.getConsultationStatuses).not.toHaveBeenCalled();
    });
  });

  describe('sweepQualifications — one sweep serves both consumers', () => {
    it('qualifies a referral whose consultation reached a CONFIGURED qualifying status', async () => {
      const { service, referrals } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'completed']])) },
      });

      const result = await service.sweepQualifications();
      expect(referrals.qualify).toHaveBeenCalledWith('e1');
      expect(result.referralsQualified).toBe(1);
    });

    it('*** DOES NOTHING while the qualifying set names a status nothing reaches ***', async () => {
      // The deployment trap, made visible. With the compiled-in default
      // (`awaiting_documentation`/`completed`, both set by M-15, which does not
      // exist), the sweep examines rows and qualifies none. That is the safe
      // direction and it is one app_config edit from changing.
      const { service, referrals, affiliates } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        affiliateRepo: { findPendingCommissions: jest.fn().mockResolvedValue([{ id: 'm1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'scheduled']])) },
        config: { referralQualifyingStatuses: ['completed'] },
      });

      const result = await service.sweepQualifications();
      expect(referrals.qualify).not.toHaveBeenCalled();
      expect(affiliates.accrueCommission).not.toHaveBeenCalled();
      expect(result).toMatchObject({ referralsExamined: 1, referralsQualified: 0, commissionsAccrued: 0 });
    });

    it('honours a WIDENED qualifying set from config, with no code change', async () => {
      // The whole reason the key exists. An admin widens it from the panel the
      // day M-15 lands — or before it, if the client accepts the trade.
      const { service, referrals } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'scheduled']])) },
        config: { referralQualifyingStatuses: ['scheduled', 'completed'] },
      });

      await service.sweepQualifications();
      expect(referrals.qualify).toHaveBeenCalledWith('e1');
    });

    it('voids a referral whose consultation died', async () => {
      const { service, referrals } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'cancelled']])) },
      });

      const result = await service.sweepQualifications();
      expect(referrals.voidEvent).toHaveBeenCalledWith('e1', 'consultation_cancelled');
      expect(result.referralsVoided).toBe(1);
    });

    it('*** ACCRUES A COMMISSION ONLY AT THE QUALIFYING STATUS — the anti-clawback design ***', async () => {
      // Accruing at capture would need a "payment refunded" signal to claw back,
      // and no such event exists on payment.contract.ts today. Gating here means
      // a booking cancelled and refunded before completion NEVER BECOMES PAYABLE.
      const { service, affiliates } = build({
        affiliateRepo: { findPendingCommissions: jest.fn().mockResolvedValue([{ id: 'm1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'completed']])) },
      });

      const result = await service.sweepQualifications();
      expect(affiliates.accrueCommission).toHaveBeenCalledWith('m1', 'c-1');
      expect(result.commissionsAccrued).toBe(1);
    });

    it('voids a pending commission whose consultation died, so it never becomes payable', async () => {
      const { service, affiliates } = build({
        affiliateRepo: { findPendingCommissions: jest.fn().mockResolvedValue([{ id: 'm1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'no_show']])) },
      });

      const result = await service.sweepQualifications();
      expect(affiliates.voidPendingCommissionById).toHaveBeenCalledWith('m1', 'c-1', 'consultation_no_show');
      expect(result.commissionsVoided).toBe(1);
    });

    it('leaves BOTH halves alone on `unknown`', async () => {
      const { service, referrals, affiliates } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        affiliateRepo: { findPendingCommissions: jest.fn().mockResolvedValue([{ id: 'm1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map()) },
      });

      await service.sweepQualifications();
      expect(referrals.qualify).not.toHaveBeenCalled();
      expect(referrals.voidEvent).not.toHaveBeenCalled();
      expect(affiliates.accrueCommission).not.toHaveBeenCalled();
      expect(affiliates.voidPendingCommissionById).not.toHaveBeenCalled();
    });

    it('counts a failure in one half and still runs the other', async () => {
      const { service, affiliates } = build({
        referralRepo: { findQualifyingCandidates: jest.fn().mockResolvedValue([{ id: 'e1', consultationId: 'c-1' }]) },
        affiliateRepo: { findPendingCommissions: jest.fn().mockResolvedValue([{ id: 'm1', consultationId: 'c-1' }]) },
        booking: { getConsultationStatuses: jest.fn().mockResolvedValue(new Map([['c-1', 'completed']])) },
        referrals: { qualify: jest.fn().mockRejectedValue(new Error('boom')) },
      });

      const result = await service.sweepQualifications();
      expect(result.failed).toBe(1);
      expect(affiliates.accrueCommission).toHaveBeenCalled();
    });
  });

  describe('scheduling', () => {
    /**
     * `@nestjs/schedule` is NOT installed and this module does not add it — see
     * the `SWEEP_SCHEDULING` comment. The two things a naive `setInterval` gets
     * wrong are both asserted here rather than assumed.
     */
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('*** CALLS `.unref()`, so a timer never holds the process open ***', async () => {
      // Without this, Jest workers and CLI processes would not exit cleanly.
      const timer = { unref: jest.fn() };
      const spy = jest.spyOn(global, 'setInterval').mockReturnValue(timer as never);

      const { service } = build();
      service.onModuleInit();

      expect(spy).toHaveBeenCalled();
      expect(timer.unref).toHaveBeenCalledTimes(1);
      service.onApplicationShutdown();
    });

    it('clears the timer on shutdown', () => {
      const timer = { unref: jest.fn() };
      jest.spyOn(global, 'setInterval').mockReturnValue(timer as never);
      const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

      const { service } = build();
      service.onModuleInit();
      service.onApplicationShutdown();

      expect(clear).toHaveBeenCalledWith(timer);
    });

    it('starts at most one timer, however many times init runs', () => {
      const timer = { unref: jest.fn() };
      const spy = jest.spyOn(global, 'setInterval').mockReturnValue(timer as never);

      const { service } = build();
      service.onModuleInit();
      service.onModuleInit();

      expect(spy).toHaveBeenCalledTimes(1);
      service.onApplicationShutdown();
    });

    it('*** IS RE-ENTRANCY GUARDED, so a slow pass cannot overlap the next tick ***', async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });

      const { service, repo } = build({
        repo: {
          findExpiredReservationCandidates: jest.fn().mockImplementation(async () => {
            await blocked;
            return [];
          }),
        },
      });

      const timers: Array<() => void> = [];
      jest.spyOn(global, 'setInterval').mockImplementation((handler: TimerHandler) => {
        timers.push(handler as () => void);
        return { unref: jest.fn() } as never;
      });

      service.onModuleInit();
      timers[0]();
      // Second tick arrives while the first pass is still in flight.
      timers[0]();
      await Promise.resolve();

      release();
      await new Promise((resolve) => setImmediate(resolve));

      // The second tick was skipped rather than running concurrently.
      expect(repo.findExpiredReservationCandidates).toHaveBeenCalledTimes(1);
      service.onApplicationShutdown();
    });
  });
});
