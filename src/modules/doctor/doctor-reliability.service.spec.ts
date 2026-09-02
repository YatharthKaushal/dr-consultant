import { NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DoctorRow } from '../../schema/doctors.schema';
import { DoctorReliabilityService } from './doctor-reliability.service';
import { DoctorRepository } from './doctor.repository';

/** A drizzle `select().from()...where()` chain that resolves to `rows` at whichever step ends the chain. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(rows);
  return chain;
}

function createDeps() {
  const select = jest.fn();
  const db = { select } as unknown as Database;
  const doctorRepo = { findById: jest.fn().mockResolvedValue({ id: 'doctor-1' } as DoctorRow) } as unknown as jest.Mocked<DoctorRepository>;
  const service = new DoctorReliabilityService(db, doctorRepo);
  return { service, select, doctorRepo };
}

describe('DoctorReliabilityService', () => {
  it('returns null (not NaN, not 0) for every rate when the doctor has zero denominator on all three queries', async () => {
    const { service, select } = createDeps();
    select
      .mockReturnValueOnce(selectChain([{ total: '0', accepted: '0' }]))
      .mockReturnValueOnce(selectChain([{ denominator: '0', noShow: '0' }]))
      .mockReturnValueOnce(selectChain([{ total: '0', finalised: '0' }]));

    const result = await service.getMetrics('doctor-1');

    expect(result).toEqual({ acceptanceRate: null, noShowRate: null, caseSummaryCompletionRate: null });
  });

  it('computes the acceptance rate as accepted/total', async () => {
    const { service, select } = createDeps();
    select
      .mockReturnValueOnce(selectChain([{ total: '4', accepted: '3' }]))
      .mockReturnValueOnce(selectChain([{ denominator: '0', noShow: '0' }]))
      .mockReturnValueOnce(selectChain([{ total: '0', finalised: '0' }]));

    const result = await service.getMetrics('doctor-1');

    expect(result.acceptanceRate).toBe(0.75);
  });

  it('computes the no-show rate as noShow/(completed+no_show)', async () => {
    const { service, select } = createDeps();
    select
      .mockReturnValueOnce(selectChain([{ total: '0', accepted: '0' }]))
      .mockReturnValueOnce(selectChain([{ denominator: '10', noShow: '2' }]))
      .mockReturnValueOnce(selectChain([{ total: '0', finalised: '0' }]));

    const result = await service.getMetrics('doctor-1');

    expect(result.noShowRate).toBe(0.2);
  });

  it('computes case-summary completion as finalised/total', async () => {
    const { service, select } = createDeps();
    select
      .mockReturnValueOnce(selectChain([{ total: '0', accepted: '0' }]))
      .mockReturnValueOnce(selectChain([{ denominator: '0', noShow: '0' }]))
      .mockReturnValueOnce(selectChain([{ total: '5', finalised: '5' }]));

    const result = await service.getMetrics('doctor-1');

    expect(result.caseSummaryCompletionRate).toBe(1);
  });

  it('404s when the doctor does not exist', async () => {
    const { service, doctorRepo } = createDeps();
    doctorRepo.findById.mockResolvedValue(null);

    // Was previously asserted with a loose `.rejects.toBeTruthy()`, which
    // would also pass for e.g. a raw string or a wrong exception type —
    // tightened to confirm it's actually the 404 the caller expects.
    await expect(service.getMetrics('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never even queries the reliability tables when the doctor does not exist', async () => {
    const { service, doctorRepo, select } = createDeps();
    doctorRepo.findById.mockResolvedValue(null);

    await expect(service.getMetrics('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(select).not.toHaveBeenCalled();
  });

  it('treats a completely empty result set (no row at all) the same as an all-zero row — null, not NaN', async () => {
    const { service, select } = createDeps();
    select
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]));

    const result = await service.getMetrics('doctor-1');

    expect(result).toEqual({ acceptanceRate: null, noShowRate: null, caseSummaryCompletionRate: null });
  });
});
