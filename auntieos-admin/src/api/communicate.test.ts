import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listRecentSends } from './communicate';

beforeEach(() => call.mockReset());

describe('communicate api', () => {
  it('listRecentSends unwraps the { sends } envelope', async () => {
    const sends = [
      {
        id: 's1',
        channel: 'email',
        recipientRedacted: 'j***@example.com',
        subject: 'Your visit recap',
        sentAtMs: 1_752_600_000_000,
        counts: { delivered: 1, opened: 1, clicked: 0, bounced: 0, failed: 0 },
        lastEvent: 'open',
      },
    ];
    call.mockResolvedValue({ ok: true, sends });
    const result = await listRecentSends();
    expect(call).toHaveBeenCalledWith('listRecentSends', {});
    expect(result).toEqual(sends);
  });

  it('defaults to [] when the callable returns no sends field', async () => {
    call.mockResolvedValue({ ok: true });
    expect(await listRecentSends()).toEqual([]);
  });

  it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(listRecentSends()).rejects.toThrow('permission-denied');
  });
});
