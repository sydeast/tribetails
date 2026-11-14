import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { approveBookingRequest } from './bookingRequests';

beforeEach(() => {
  call.mockReset().mockResolvedValue({});
});

describe('approveBookingRequest', () => {
  it('sends exactly the old payload for a request with no Overnight', async () => {
    await approveBookingRequest('fam-1', 'b1');
    expect(call).toHaveBeenCalledWith('manageBookingSeries', {
      action: 'APPROVE',
      kinfolkId: 'fam-1',
      batchId: 'b1',
    });
  });

  it('#1098: carries the start times and the overrides the operator chose', async () => {
    await approveBookingRequest('fam-1', 'b1', {
      startTimes: { 'night-1': 1_791_592_200_000 },
      overrideBusyConflict: true,
      overrideVisitConflict: true,
    });
    expect(call).toHaveBeenCalledWith('manageBookingSeries', {
      action: 'APPROVE',
      kinfolkId: 'fam-1',
      batchId: 'b1',
      startTimes: { 'night-1': 1_791_592_200_000 },
      overrideBusyConflict: true,
      overrideVisitConflict: true,
    });
  });

  it('#2030: carries the note for the household, trimmed', async () => {
    await approveBookingRequest('fam-1', 'b1', { note: '  See you Friday.  ' });
    expect(call).toHaveBeenCalledWith('manageBookingSeries', {
      action: 'APPROVE',
      kinfolkId: 'fam-1',
      batchId: 'b1',
      note: 'See you Friday.',
    });
  });
  it('#2030: withholds a blank note rather than sending an empty one', async () => {
    await approveBookingRequest('fam-1', 'b1', { note: '   ' });
    expect(call).toHaveBeenCalledWith('manageBookingSeries', {
      action: 'APPROVE',
      kinfolkId: 'fam-1',
      batchId: 'b1',
    });
  });
  it('omits an override that was not granted rather than sending false', async () => {
    await approveBookingRequest('fam-1', 'b1', {
      startTimes: { 'night-1': 1 },
      overrideBusyConflict: false,
    });
    expect(call.mock.calls[0]![1]).toEqual({
      action: 'APPROVE',
      kinfolkId: 'fam-1',
      batchId: 'b1',
      startTimes: { 'night-1': 1 },
    });
  });
});
