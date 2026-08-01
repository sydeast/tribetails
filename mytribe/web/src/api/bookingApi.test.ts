import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { addBookingNote, requestBooking, requestBookingCancellation } from './bookingApi';

// Replace the single callables choke point so each test asserts the exact
// payload the wrapper builds, without touching the network. Mirrors
// api/portal.test.ts's convention.
vi.mock('../lib/fns', () => ({ call: vi.fn() }));

describe('requestBookingCancellation wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false } as never);
  });

  it('sends kinfolkId/batchId/visitId, omitting reason when blank', async () => {
    await requestBookingCancellation('fam1', 'b1', 'v1');
    expect(call).toHaveBeenCalledWith('requestBookingCancellation', { kinfolkId: 'fam1', batchId: 'b1', visitId: 'v1' });
  });

  it('trims and includes a non-blank reason', async () => {
    await requestBookingCancellation('fam1', 'b1', 'v1', '  trip moved  ');
    expect(call).toHaveBeenCalledWith('requestBookingCancellation', {
      kinfolkId: 'fam1',
      batchId: 'b1',
      visitId: 'v1',
      reason: 'trip moved',
    });
  });

  it('omits a whitespace-only reason (same as no reason)', async () => {
    await requestBookingCancellation('fam1', 'b1', 'v1', '   ');
    expect(call).toHaveBeenCalledWith('requestBookingCancellation', { kinfolkId: 'fam1', batchId: 'b1', visitId: 'v1' });
  });

  it('returns the callable result verbatim, including alreadyPending', async () => {
    vi.mocked(call).mockResolvedValueOnce({ ok: true, visitId: 'v1', alreadyPending: true } as never);
    await expect(requestBookingCancellation('fam1', 'b1', 'v1')).resolves.toEqual({
      ok: true,
      visitId: 'v1',
      alreadyPending: true,
    });
  });

  it('does not swallow a rejection (fail loud)', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('failed-precondition'));
    await expect(requestBookingCancellation('fam1', 'b1', 'v1')).rejects.toThrow('failed-precondition');
  });
});

describe('addBookingNote wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ noteId: 'n1' } as never);
  });

  it('always sends kinfolkId (required by the handler despite the optional zod type)', async () => {
    await addBookingNote('fam1', 'b1', 'v1', 'Please use the back door.');
    expect(call).toHaveBeenCalledWith('addBookingNote', {
      kinfolkId: 'fam1',
      batchId: 'b1',
      visitId: 'v1',
      body: 'Please use the back door.',
    });
  });

  it('returns the callable result', async () => {
    await expect(addBookingNote('fam1', 'b1', 'v1', 'hi')).resolves.toEqual({ noteId: 'n1' });
  });

  it('surfaces the note-cutoff rejection message rather than swallowing it', async () => {
    vi.mocked(call).mockRejectedValueOnce(
      new Error('Notes cannot be edited within 3 hours of booking start window.'),
    );
    await expect(addBookingNote('fam1', 'b1', 'v1', 'too late')).rejects.toThrow(/3 hours/);
  });
});

describe('requestBooking wrapper (pre-existing, unchanged)', () => {
  it('still rejects an empty visits array client-side', () => {
    expect(() => requestBooking({ visits: [] })).toThrow('No visits to book. Check the days and weeks.');
  });
});
