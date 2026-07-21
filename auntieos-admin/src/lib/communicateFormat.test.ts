import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  sendTimeOf,
  sendDayKey,
  sendClock,
  sendMachineTime,
  sendDayLabel,
  sendChannelOf,
  channelLabel,
  sendStateOf,
  sendStateInfo,
  engagementSummary,
  sendCountsOf,
  sendSubject,
  sendRecipient,
  groupSendsByDay,
  localDateIso,
  type SendCounts,
} from './communicateFormat';

// File-scope TZ pin: several suites below (sendDayKey/sendClock,
// groupSendsByDay) assert LOCAL day/time derived from a UTC-instant epoch ms.
// Without a fixed zone these pass on a US runner and fail east of UTC; pin
// the whole file to a known zone (the inboxFormat.test.ts / sessionFormat.test.ts
// convention) so the AO-18 local-day guarantee is tested meaningfully
// everywhere, not just on the author's machine.
let fileOriginalTz: string | undefined;
beforeAll(() => {
  fileOriginalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (fileOriginalTz === undefined) delete process.env.TZ;
  else process.env.TZ = fileOriginalTz;
});

const zeroCounts: SendCounts = { delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 };

describe('sendTimeOf', () => {
  it('degrades honestly on non-finite/non-positive/NaN input, never fabricating a date', () => {
    expect(sendTimeOf(0)).toBeNull();
    expect(sendTimeOf(-1)).toBeNull();
    expect(sendTimeOf(Number.NaN)).toBeNull();
    expect(sendTimeOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('wraps a real epoch-ms value into a Date-backed fake Timestamp', () => {
    const ms = Date.parse('2026-07-16T09:03:00.000Z');
    const wrapped = sendTimeOf(ms);
    expect(wrapped).not.toBeNull();
    expect(wrapped?.toDate().getTime()).toBe(ms);
  });
});

describe('sendDayKey / sendClock (AO-18, applied to epoch-ms sentAtMs)', () => {
  it('Undated / (no time) for a non-finite ms value, same fallback lib/time.ts uses for a missing Timestamp', () => {
    expect(sendDayKey(0)).toBe('Undated');
    expect(sendClock(0)).toBe('(no time)');
  });

  // The AO-18 bug, reproduced for THIS field's shape: a naive
  // `new Date(ms).toISOString().slice(0, 10)` reads the UTC calendar day. A
  // send stamped as epoch ms for "2026-07-17T01:00:00.000Z" (8pm CDT, the
  // next calendar day in UTC) must still group under 2026-07-16 and show
  // 20:00, not 01:00, because sendDayKey/sendClock parse the real instant
  // and ask the LOCAL clock what day/time it fell on.
  it('groups an 8pm-CDT send under its LOCAL day, not the UTC-next day a raw ISO slice would give', () => {
    const eightPmCdtAsUtcMs = Date.parse('2026-07-17T01:00:00.000Z'); // 2026-07-16 20:00 America/Chicago (CDT, UTC-5)
    expect(sendDayKey(eightPmCdtAsUtcMs)).toBe('2026-07-16');
    // The naive approach this replaces, spelled out so the regression is legible:
    expect(new Date(eightPmCdtAsUtcMs).toISOString().slice(0, 10)).toBe('2026-07-17');
  });

  it('shows the LOCAL clock time too, not the UTC hour (five hours off in CDT)', () => {
    expect(sendClock(Date.parse('2026-07-17T01:00:00.000Z'))).toBe('20:00');
  });
});

describe('sendMachineTime', () => {
  it('is undefined for a non-finite ms value, never a fabricated attribute', () => {
    expect(sendMachineTime(0)).toBeUndefined();
  });

  it('renders a LOCAL machine-readable datetime for a real ms value', () => {
    expect(sendMachineTime(Date.parse('2026-07-17T01:00:00.000Z'))).toBe('2026-07-16T20:00');
  });
});

describe('sendDayLabel (re-exported from sessionFormat, not re-derived)', () => {
  it('labels today/tomorrow/yesterday relative to a given local today', () => {
    expect(sendDayLabel('2026-07-16', '2026-07-16')).toBe('Today');
    expect(sendDayLabel('2026-07-17', '2026-07-16')).toBe('Tomorrow');
    expect(sendDayLabel('2026-07-15', '2026-07-16')).toBe('Yesterday');
  });

  it('passes Undated through verbatim rather than folding it into Today', () => {
    expect(sendDayLabel('Undated', '2026-07-16')).toBe('Undated');
  });
});

describe('sendChannelOf / channelLabel (positive enumeration, unknown bucket, no negation)', () => {
  it('matches the two real channels sendExternalMessage ever writes', () => {
    expect(sendChannelOf('email')).toBe('email');
    expect(sendChannelOf('sms')).toBe('sms');
    expect(sendChannelOf('push')).toBe('push');
  });

  it('is case-insensitive and trims whitespace, mirroring sessionState/threadSender', () => {
    expect(sendChannelOf('  Email  ')).toBe('email');
    expect(sendChannelOf('SMS')).toBe('sms');
  });

  it('an unrecognized or blank channel is honestly "unknown", never silently folded into email or sms', () => {
    expect(sendChannelOf('')).toBe('unknown');
    // 'push' used to live here, back when the compose UI shipped only email and
    // sms. It is a first-class broadcast channel now (the backend always sent
    // it; the admin just could not ask for it), so the unknown bucket needs a
    // genuinely unrecognized value to prove it still catches one.
    expect(sendChannelOf('carrier_pigeon')).toBe('unknown');
  });

  it('channelLabel maps each channel to its display label', () => {
    expect(channelLabel('email')).toBe('Email');
    expect(channelLabel('sms')).toBe('Text');
    expect(channelLabel('push')).toBe('Push');
  });

  it('channelLabel falls back to the raw value for an unknown non-blank channel, and "Send" for blank', () => {
    expect(channelLabel('carrier_pigeon')).toBe('carrier_pigeon');
    expect(channelLabel('')).toBe('Send');
  });
});

describe('sendStateOf / sendStateInfo (positive enumeration, priority order, no negation)', () => {
  it('is "awaiting" when nothing has been reported yet', () => {
    expect(sendStateOf(zeroCounts, 'email')).toBe('awaiting');
    expect(sendStateInfo('awaiting')).toEqual({ label: 'Sent', tone: 'muted' });
  });

  it('is "delivered" once delivery is reported, with no further event', () => {
    expect(sendStateOf({ ...zeroCounts, delivered: 1 }, 'sms')).toBe('delivered');
  });

  it('is "opened" once opened, outranking a mere delivered count', () => {
    expect(sendStateOf({ ...zeroCounts, delivered: 1, opened: 1 }, 'email')).toBe('opened');
  });

  it('is "clicked" for email once clicked, outranking opened/delivered', () => {
    expect(sendStateOf({ ...zeroCounts, delivered: 1, opened: 1, clicked: 1 }, 'email')).toBe('clicked');
  });

  it('never reports "clicked" for sms even if a clicked count is present (Twilio has no link-click webhook)', () => {
    expect(sendStateOf({ ...zeroCounts, opened: 1, clicked: 1 }, 'sms')).toBe('opened');
  });

  it('is "bounced" when bounced, outranking any positive engagement count', () => {
    expect(sendStateOf({ ...zeroCounts, delivered: 1, opened: 1, bounced: 1 }, 'email')).toBe('bounced');
  });

  it('is "failed" when failed, the highest-priority state of all', () => {
    expect(sendStateOf({ ...zeroCounts, delivered: 1, bounced: 1, failed: 1 }, 'email')).toBe('failed');
  });

  it('sendStateInfo maps every state to a DenTone-vocabulary label, not an invented colour', () => {
    expect(sendStateInfo('failed').tone).toBe('error');
    expect(sendStateInfo('bounced').tone).toBe('warning');
    expect(sendStateInfo('clicked').tone).toBe('success');
    expect(sendStateInfo('opened').tone).toBe('orange');
    expect(sendStateInfo('delivered').tone).toBe('teal');
  });
});

describe('engagementSummary (honest, measured-only, ports the wasm helper)', () => {
  it('reports "awaiting delivery events" when nothing has landed yet', () => {
    expect(engagementSummary('email', zeroCounts)).toBe('Sent · awaiting delivery events');
  });

  it('joins only the measured, non-zero counts', () => {
    expect(engagementSummary('email', { ...zeroCounts, delivered: 3, opened: 2 })).toBe('3 delivered · 2 opened');
  });

  it('includes clicked only for email, never for sms', () => {
    expect(engagementSummary('email', { ...zeroCounts, clicked: 1 })).toBe('1 clicked');
    expect(engagementSummary('sms', { ...zeroCounts, clicked: 1 })).toBe('Sent · awaiting delivery events');
  });

  it('includes bounced and failed when present', () => {
    expect(engagementSummary('email', { ...zeroCounts, bounced: 1, failed: 2 })).toBe('1 bounced · 2 failed');
  });
});

describe('sendCountsOf (defensive read)', () => {
  it('defaults every field to 0 for a missing/null/undefined counts object', () => {
    expect(sendCountsOf(undefined)).toEqual(zeroCounts);
    expect(sendCountsOf(null)).toEqual(zeroCounts);
    expect(sendCountsOf({})).toEqual(zeroCounts);
  });

  it('defaults a non-finite individual field to 0 without discarding the rest (legacy/partial doc)', () => {
    expect(sendCountsOf({ delivered: 3, opened: Number.NaN })).toEqual({ ...zeroCounts, delivered: 3 });
  });

  it('passes real finite counts through unchanged', () => {
    const counts = { delivered: 5, opened: 3, clicked: 1, bounced: 0, failed: 0 };
    expect(sendCountsOf(counts)).toEqual(counts);
  });
});

describe('sendSubject / sendRecipient (defensive field reads)', () => {
  it('sendSubject defensively trims and defaults a missing subject to blank', () => {
    expect(sendSubject(undefined)).toBe('');
    expect(sendSubject(null)).toBe('');
    expect(sendSubject('  Your visit recap  ')).toBe('Your visit recap');
  });

  it('sendRecipient falls back to an honest placeholder when missing/blank, never a blank line', () => {
    expect(sendRecipient(undefined)).toBe('(recipient not on file)');
    expect(sendRecipient(null)).toBe('(recipient not on file)');
    expect(sendRecipient('   ')).toBe('(recipient not on file)');
    expect(sendRecipient('j***@example.com')).toBe('j***@example.com');
  });
});

describe('groupSendsByDay', () => {
  interface Row {
    id: string;
    sentAtMs: number;
  }

  it('groups rows by LOCAL day, newest day first, newest row first within a day', () => {
    const rows: Row[] = [
      { id: 'earlier-today', sentAtMs: Date.parse('2026-07-16T09:00:00.000Z') },
      { id: 'later-today', sentAtMs: Date.parse('2026-07-16T20:00:00.000Z') },
      { id: 'yesterday', sentAtMs: Date.parse('2026-07-15T09:00:00.000Z') },
    ];
    const groups = groupSendsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', '2026-07-15']);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['later-today', 'earlier-today']);
  });

  it('Undated rows get their own group, sorted last', () => {
    const rows: Row[] = [
      { id: 'dated', sentAtMs: Date.parse('2026-07-16T09:00:00.000Z') },
      { id: 'undated', sentAtMs: 0 },
    ];
    const groups = groupSendsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', 'Undated']);
  });

  it('an empty input produces no groups, never a fabricated placeholder', () => {
    expect(groupSendsByDay([])).toEqual([]);
  });
});

describe('localDateIso re-export', () => {
  it('is the same lib/invoiceFormat helper (via sessionFormat), not a re-derived duplicate', () => {
    expect(typeof localDateIso).toBe('function');
    expect(localDateIso(new Date(2026, 6, 16))).toBe('2026-07-16');
  });
});
