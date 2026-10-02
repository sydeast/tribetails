import { describe, it, expect, vi } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock('../lib/fns', () => ({ call: callMock }));

import { listMessageSuppressions, clearMessageSuppression } from './messageSuppressions';

describe('listMessageSuppressions', () => {
  it('sends the filter, page size and cursor, and decodes every field', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      items: [
        {
          recipient: 'gone@example.com',
          recipientRedacted: 'g***@example.com',
          channel: 'email',
          reason: 'hard_bounce',
          source: 'smtp2go',
          suppressedAtMs: 1759400000000,
          eventId: 'evt-9',
          optedOut: true,
        },
      ],
      nextCursor: 'abc',
    });
    const res = await listMessageSuppressions({ reason: 'hard_bounce', cursor: 'prev', limit: 25 });
    expect(callMock).toHaveBeenCalledWith(
      'listMessageSuppressions',
      { reason: 'hard_bounce', cursor: 'prev', limit: 25 },
      { idempotent: true },
    );
    expect(res).toEqual({
      items: [
        {
          recipient: 'gone@example.com',
          recipientRedacted: 'g***@example.com',
          channel: 'email',
          reason: 'hard_bounce',
          source: 'smtp2go',
          suppressedAtMs: 1759400000000,
          eventId: 'evt-9',
          optedOut: true,
        },
      ],
      nextCursor: 'abc',
    });
  });

  it('omits the optional arguments it was not given', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ items: [], nextCursor: null });
    await listMessageSuppressions({});
    expect(callMock).toHaveBeenCalledWith('listMessageSuppressions', {}, { idempotent: true });
  });

  it('survives a thin row from an older deploy', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ items: [{ recipient: 'a@b.co' }, { nope: 1 }] });
    const res = await listMessageSuppressions({});
    expect(res.items).toEqual([
      {
        recipient: 'a@b.co',
        recipientRedacted: '',
        channel: 'email',
        reason: 'opt_out',
        source: 'admin',
        suppressedAtMs: 0,
        eventId: null,
        optedOut: true,
      },
    ]);
    expect(res.nextCursor).toBeNull();
  });
});

describe('clearMessageSuppression', () => {
  it('sends the full address, trimmed, and reads the redacted form back', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'email', recipientRedacted: 'g***@example.com', optOutKept: true });
    const res = await clearMessageSuppression('  gone@example.com ');
    expect(callMock).toHaveBeenCalledWith('clearMessageSuppression', { recipient: 'gone@example.com' });
    expect(res).toEqual({ ok: true, channel: 'email', recipientRedacted: 'g***@example.com', optOutKept: true });
  });

  it('lets a server refusal reach the caller', async () => {
    callMock.mockReset();
    callMock.mockImplementation(() => Promise.reject(new Error('That address is not on the do-not-send list.')));
    await expect(clearMessageSuppression('x@y.co')).rejects.toThrow(/not on the do-not-send list/);
  });
});
