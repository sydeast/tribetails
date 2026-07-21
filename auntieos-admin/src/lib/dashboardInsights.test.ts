import { describe, it, expect } from 'vitest';
import {
  unreadClientMessages,
  unreadClientMessageCount,
  nextUpcomingSession,
  safeboxAccessLines,
  careFlags,
  upcomingExpirations,
  recentExpenses,
  formatCents,
  lowSupplies,
  formatMiles,
  formatDuration,
  type KinCareInfo,
} from './dashboardInsights';
import type { ConversationSummary } from '../api/inbox';
import type { SessionEntry } from '../api/sessions';
import type { ExpirationRow } from '../api/expirations';
import type { ExpenseRow } from '../api/expenses';
import type { SupplyRow } from '../api/supplies';
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

  it('flags ONLY the codes as secret, so the widget masks them and nothing else', () => {
    const lines = safeboxAccessLines(
      mergeKinfolkProfile('k1', {
        serviceAddress: '12 Oak St',
        gateCode: '4417',
        entryNotes: 'Side door',
        parkingInstructions: 'Driveway',
        wifiName: 'Rivera',
        wifiPassword: 'hunter2',
      }),
    );
    expect(lines.filter((l) => l.secret === true).map((l) => l.label)).toEqual([
      'Gate / door code',
      'WiFi password',
    ]);
    // Address/parking/network name are needed at a glance and stay in the clear.
    expect(lines.find((l) => l.label === 'Address')?.secret).toBeUndefined();
    expect(lines.find((l) => l.label === 'WiFi network')?.secret).toBeUndefined();
  });
});

// ── AO-37 careFlags ─────────────────────────────────────────────────────────
import { sessionDayKey } from './sessionFormat';

function kin(over: Partial<KinCareInfo> = {}): KinCareInfo {
  return { name: 'Biscuit', reactive: false, medicationHealthNotes: '', feedingBrand: '', ...over };
}

describe('careFlags', () => {
  // Derive "today" from a session's own start via the same LOCAL day-key the
  // function uses, so the join is deterministic regardless of the test machine's
  // timezone (no reliance on where the wall clock lands the UTC instant).
  const START = '2026-07-20T15:00:00.000Z';
  const OTHER_DAY = '2026-07-25T15:00:00.000Z';
  const today = sessionDayKey(START);

  it('emits reactive, medication and feeding flags for today, in that order, deduped', () => {
    const kinById = new Map<string, KinCareInfo>([
      ['p1', kin({ name: 'Biscuit', reactive: true, medicationHealthNotes: 'Insulin 2x', feedingBrand: 'Acana' })],
    ]);
    const out = careFlags(
      [
        sess({ _id: 'a', kinfolkName: 'Rivera', kinIds: ['p1'], startTime: START }),
        // Same pet, second visit today: must not double-flag.
        sess({ _id: 'b', kinfolkName: 'Rivera', kinIds: ['p1'], startTime: START }),
      ],
      kinById,
      today,
    );
    expect(out.map((f) => f.kind)).toEqual(['reactive', 'medication', 'feeding']);
    expect(out.map((f) => f.text)).toEqual(['Reactive, handle with care', 'Insulin 2x', 'Acana']);
    expect(out.every((f) => f.household === 'Rivera' && f.kinName === 'Biscuit')).toBe(true);
  });

  it('skips cancelled sessions and sessions that are not today', () => {
    const kinById = new Map<string, KinCareInfo>([['p1', kin({ reactive: true })]]);
    const out = careFlags(
      [
        sess({ _id: 'cx', kinIds: ['p1'], startTime: START, status: 'CANCELLED' }),
        sess({ _id: 'future', kinIds: ['p1'], startTime: OTHER_DAY, status: 'SCHEDULED' }),
      ],
      kinById,
      today,
    );
    expect(out).toEqual([]);
  });

  it('ignores a pet not in the lookup and a pet with no care notes', () => {
    const kinById = new Map<string, KinCareInfo>([['p1', kin()]]); // all blank/false
    const out = careFlags(
      [sess({ kinIds: ['p1', 'unknown'], startTime: START })],
      kinById,
      today,
    );
    expect(out).toEqual([]);
  });
});

// ── AO-39 upcomingExpirations ───────────────────────────────────────────────
function exp(over: Partial<ExpirationRow> = {}): ExpirationRow {
  return { _id: 'e1', label: 'Gate code', dateIso: '2026-08-01', kind: 'gateCode', ...over };
}

describe('upcomingExpirations', () => {
  const today = '2026-07-20';

  it('keeps today-or-later within the horizon, sorted ascending, with day counts', () => {
    const out = upcomingExpirations(
      [
        exp({ label: 'Far', dateIso: '2026-09-30' }), // 72 days: out of a 60-day window
        exp({ label: 'Soon', dateIso: '2026-07-25' }), // 5 days
        exp({ label: 'Today', dateIso: '2026-07-20' }), // 0 days
        exp({ label: 'Past', dateIso: '2026-07-10' }), // negative: dropped
      ],
      today,
      60,
    );
    expect(out.map((r) => r.label)).toEqual(['Today', 'Soon']);
    expect(out.map((r) => r.daysUntil)).toEqual([0, 5]);
  });

  it('drops a row whose date does not parse rather than guessing', () => {
    const out = upcomingExpirations([exp({ label: 'Vague', dateIso: 'Net 30' })], today, 60);
    expect(out).toEqual([]);
  });
});

// ── AO-40 recentExpenses / formatCents ──────────────────────────────────────
function expense(over: Partial<ExpenseRow> = {}): ExpenseRow {
  return { _id: 'x1', kind: 'gas', amountCents: 1234, note: '', occurredAt: '2026-07-20T09:00:00.000Z', ...over };
}

describe('recentExpenses', () => {
  it('returns newest first, capped at the limit', () => {
    const out = recentExpenses(
      [
        expense({ _id: 'old', occurredAt: '2026-07-01T09:00:00.000Z' }),
        expense({ _id: 'new', occurredAt: '2026-07-18T09:00:00.000Z' }),
        expense({ _id: 'mid', occurredAt: '2026-07-10T09:00:00.000Z' }),
      ],
      2,
    );
    expect(out.map((e) => e._id)).toEqual(['new', 'mid']);
  });

  it('does not mutate the input and treats a non-positive limit as zero rows', () => {
    const rows = [expense({ _id: 'a' }), expense({ _id: 'b' })];
    recentExpenses(rows, 5);
    expect(rows.map((r) => r._id)).toEqual(['a', 'b']);
    expect(recentExpenses(rows, 0)).toEqual([]);
  });
});

describe('formatCents', () => {
  it('formats cents as dollars, with a sign for a negative', () => {
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-500)).toBe('-$5.00');
  });

  it('reads a non-finite amount as $0.00, never "$NaN"', () => {
    expect(formatCents(Number.NaN)).toBe('$0.00');
  });
});

// ── AO-41 lowSupplies ────────────────────────────────────────────────────────
function supply(over: Partial<SupplyRow> = {}): SupplyRow {
  return { _id: 's1', name: 'Poop bags', onHand: 5, par: 10, unit: 'rolls', ...over };
}

describe('lowSupplies', () => {
  it('keeps only at-or-below par, most-depleted first', () => {
    const out = lowSupplies([
      supply({ _id: 'ok', onHand: 20, par: 10 }), // above par: excluded
      supply({ _id: 'edge', onHand: 10, par: 10 }), // at par: included, shortfall 0
      supply({ _id: 'deep', onHand: 1, par: 12 }), // shortfall -11
      supply({ _id: 'mild', onHand: 8, par: 10 }), // shortfall -2
    ]);
    expect(out.map((s) => s._id)).toEqual(['deep', 'mild', 'edge']);
  });

  it('does not mutate the input', () => {
    const rows = [supply({ _id: 'a', onHand: 1, par: 5 }), supply({ _id: 'b', onHand: 2, par: 5 })];
    lowSupplies(rows);
    expect(rows.map((r) => r._id)).toEqual(['a', 'b']);
  });
});

// ── AO-35 formatMiles / formatDuration ──────────────────────────────────────
describe('formatMiles', () => {
  it('shows one decimal, and reads a non-finite value as 0.0 mi', () => {
    expect(formatMiles(12.34)).toBe('12.3 mi');
    expect(formatMiles(0)).toBe('0.0 mi');
    expect(formatMiles(Number.POSITIVE_INFINITY)).toBe('0.0 mi');
  });
});

describe('formatDuration', () => {
  it('formats minutes, padding the minute part inside an hour', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(65)).toBe('1h 05m');
    expect(formatDuration(130)).toBe('2h 10m');
  });

  it('floors a negative at zero and reads non-finite as 0m', () => {
    expect(formatDuration(-10)).toBe('0m');
    expect(formatDuration(Number.NaN)).toBe('0m');
  });
});
