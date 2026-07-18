import { describe, it, expect } from 'vitest';
import {
  unreadClientMessages,
  unreadClientMessageCount,
  nextUpcomingSession,
  safeboxAccessLines,
} from './dashboardInsights';
import type { ConversationSummary } from '../api/inbox';
import type { SessionEntry } from '../api/sessions';
import { mergeKinfolkProfile } from '../api/kinfolkProfile';

function sess(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 's1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    kinIds: [],
    serviceType: 'Drop-in',
    startTime: '2026-07-20T09:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-20T09:30:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

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

describe('nextUpcomingSession', () => {
  const now = '2026-07-19T12:00:00.000Z';

  it('picks the earliest future non-cancelled, non-completed visit', () => {
    const next = nextUpcomingSession(
      [
        sess({ _id: 'later', startTime: '2026-07-21T09:00:00.000Z' }),
        sess({ _id: 'soon', startTime: '2026-07-20T08:00:00.000Z' }),
        sess({ _id: 'past', startTime: '2026-07-18T09:00:00.000Z' }),
      ],
      now,
    );
    expect(next?._id).toBe('soon');
  });

  it('skips cancelled and completed visits even when they are the soonest', () => {
    const next = nextUpcomingSession(
      [
        sess({ _id: 'cx', startTime: '2026-07-20T07:00:00.000Z', status: 'CANCELLED' }),
        sess({ _id: 'done', startTime: '2026-07-20T07:30:00.000Z', status: 'COMPLETED' }),
        sess({ _id: 'real', startTime: '2026-07-20T09:00:00.000Z', status: 'SCHEDULED' }),
      ],
      now,
    );
    expect(next?._id).toBe('real');
  });

  it('ignores a blank start time and returns null when nothing is upcoming', () => {
    expect(nextUpcomingSession([sess({ startTime: '' })], now)).toBeNull();
    expect(nextUpcomingSession([sess({ startTime: '2026-07-18T09:00:00.000Z' })], now)).toBeNull();
  });
});

describe('safeboxAccessLines', () => {
  it('emits only the non-blank access fields, in arrival order, codes flagged mono', () => {
    const p = mergeKinfolkProfile('k1', {
      serviceAddress: '12 Oak St',
      gateCode: '4417',
      entryNotes: 'Side door',
      parkingInstructions: '',
      wifiName: 'Rivera',
      wifiPassword: 'hunter2',
    });
    const lines = safeboxAccessLines(p);
    expect(lines.map((l) => l.label)).toEqual([
      'Address',
      'Gate / door code',
      'Entry notes',
      'WiFi network',
      'WiFi password',
    ]);
    expect(lines.find((l) => l.label === 'Gate / door code')?.mono).toBe(true);
    expect(lines.find((l) => l.label === 'Address')?.mono).toBeUndefined();
  });

  it('is empty for a household with no access notes', () => {
    expect(safeboxAccessLines(mergeKinfolkProfile('k1', {}))).toEqual([]);
  });
});
