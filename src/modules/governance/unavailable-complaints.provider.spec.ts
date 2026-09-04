/**
 * `UnavailableComplaintsProvider` — the null object bound to
 * `GOVERNANCE_COMPLAINTS_PORT` until M-19 (Feedback and Complaints) merges.
 */
import { Logger } from '@nestjs/common';
import { COMPLAINT_STATUSES } from '../../schema/enums.schema';
import { UnavailableComplaintsProvider } from './unavailable-complaints.provider';

describe('UnavailableComplaintsProvider', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports zero for every status COMPLAINT_STATUSES names, and nothing else', async () => {
    const provider = new UnavailableComplaintsProvider();

    const counts = await provider.countComplaintsByStatus();

    expect(Object.keys(counts).sort()).toEqual([...COMPLAINT_STATUSES].sort());
    for (const status of COMPLAINT_STATUSES) {
      expect(counts[status]).toBe(0);
    }
  });

});
