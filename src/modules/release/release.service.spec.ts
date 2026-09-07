import type { ReleaseConfigService } from './release-config.service';
import { ReleaseService } from './release.service';
import type { ReleasePolicy } from './release.types';

function policy(overrides: Partial<ReleasePolicy['patient']['android']> = {}): ReleasePolicy {
  const entry = { minimumSupportedVersion: '1.0.0', latestVersion: '1.2.0', storeUrl: 'https://store', message: null, ...overrides };
  return { patient: { ios: entry, android: entry }, doctor: { ios: entry, android: entry } };
}

describe('ReleaseService.getReleaseStatus', () => {
  function build(resolved: ReleasePolicy) {
    const config = { getResolved: jest.fn().mockResolvedValue(resolved) } as unknown as jest.Mocked<ReleaseConfigService>;
    return { service: new ReleaseService(config), config };
  }

  it('requires an update below the minimum', async () => {
    const { service } = build(policy());
    const status = await service.getReleaseStatus({ app: 'patient', platform: 'android', version: '0.9.0' });
    expect(status.updateRequired).toBe(true);
    expect(status.updateAvailable).toBe(true);
  });

  it('does not require, but does flag available, when at the minimum but below latest', async () => {
    const { service } = build(policy());
    const status = await service.getReleaseStatus({ app: 'patient', platform: 'android', version: '1.0.0' });
    expect(status.updateRequired).toBe(false);
    expect(status.updateAvailable).toBe(true);
  });

  it('flags neither when already current', async () => {
    const { service } = build(policy());
    const status = await service.getReleaseStatus({ app: 'patient', platform: 'android', version: '1.2.0' });
    expect(status.updateRequired).toBe(false);
    expect(status.updateAvailable).toBe(false);
  });

  it('reads the exact app/platform cell requested, not a shared default', async () => {
    const mixed = policy();
    mixed.doctor.ios = { minimumSupportedVersion: '5.0.0', latestVersion: '5.0.0', storeUrl: null, message: 'Critical fix' };
    const { service } = build(mixed);

    const status = await service.getReleaseStatus({ app: 'doctor', platform: 'ios', version: '1.0.0' });
    expect(status.updateRequired).toBe(true);
    expect(status.message).toBe('Critical fix');
  });
});
