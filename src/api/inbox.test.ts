import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listConversations } from './inbox';

beforeEach(() => call.mockReset());

describe('inbox api', () => {
  it('listConversations unwraps the { conversations } envelope', async () => {
    const conversations = [
      {
        kinfolkId: 'k1',
        kinfolkName: 'The Alvarez Household',
        lastMessagePreview: 'Thanks for the update!',
        lastMessageAtMs: 1_752_600_000_000,
        lastSenderRole: 'kinfolk',
        unreadForAdmin: true,
        messageCount: 4,
      },
    ];
    call.mockResolvedValue({ ok: true, conversations });
    const result = await listConversations();
    expect(call).toHaveBeenCalledWith('listConversations', {});
    expect(result).toEqual(conversations);
  });

  it('defaults to [] when the callable returns no conversations field', async () => {
    call.mockResolvedValue({ ok: true });
    expect(await listConversations()).toEqual([]);
  });

  it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(listConversations()).rejects.toThrow('permission-denied');
  });
});
