import { describe, it, expect } from 'vitest';
import { unreadClientMessages, unreadClientMessageCount } from './dashboardInsights';
import type { ConversationSummary } from '../api/inbox';

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    lastMessagePreview: 'Hi Auntie',
    lastMessageAtMs: 1_000,
    lastSenderRole: 'kinfolk',
    unreadForAdmin: true,
    messageCount: 3,
    ...over,
  };
}

describe('unreadClientMessages', () => {
  it('keeps only unread threads, newest first', () => {
    const rows = [
      conv({ kinfolkId: 'a', lastMessageAtMs: 100, unreadForAdmin: true }),
      conv({ kinfolkId: 'b', lastMessageAtMs: 300, unreadForAdmin: true }),
      conv({ kinfolkId: 'c', lastMessageAtMs: 200, unreadForAdmin: false }),
    ];
    const out = unreadClientMessages(rows);
    expect(out.map((m) => m.kinfolkId)).toEqual(['b', 'a']);
  });

  it('caps at the limit but leaves the total count untouched', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      conv({ kinfolkId: `k${i}`, lastMessageAtMs: i, unreadForAdmin: true }),
    );
    expect(unreadClientMessages(rows, 3)).toHaveLength(3);
    expect(unreadClientMessageCount(rows)).toBe(8);
  });

  it('does not mutate the input array order', () => {
    const rows = [
      conv({ kinfolkId: 'a', lastMessageAtMs: 100 }),
      conv({ kinfolkId: 'b', lastMessageAtMs: 300 }),
    ];
    unreadClientMessages(rows);
    expect(rows.map((r) => r.kinfolkId)).toEqual(['a', 'b']);
  });

  it('falls back to the id for a blank name and empties a blank preview', () => {
    const [m] = unreadClientMessages([
      conv({ kinfolkId: 'k9', kinfolkName: '   ', lastMessagePreview: '  ' }),
    ]);
    expect(m?.household).toBe('k9');
    expect(m?.preview).toBe('');
  });

  it('treats a non-positive limit as zero rows', () => {
    expect(unreadClientMessages([conv()], 0)).toHaveLength(0);
    expect(unreadClientMessages([conv()], -2)).toHaveLength(0);
  });
});

describe('unreadClientMessageCount', () => {
  it('counts unread rows only', () => {
    expect(
      unreadClientMessageCount([
        conv({ unreadForAdmin: true }),
        conv({ unreadForAdmin: false }),
        conv({ unreadForAdmin: true }),
      ]),
    ).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(unreadClientMessageCount([])).toBe(0);
  });
});
