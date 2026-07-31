import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));

import {
  decodeGoogleBusySlot,
  findBookingBusyConflicts,
  formatBookingBusyConflictMessage,
  utcDateRangeForVisits,
  loadGoogleBusySlots,
  guardBookingBusyConflict,
  BOOKING_BUSY_CONFLICT_CODE,
  type DecodedBusySlot,
} from '../src/lib/bookingBusyConflict';

beforeEach(() => {
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

function slot(over: Partial<DecodedBusySlot> & { docId: string; startMs: number; endMs: number }): DecodedBusySlot {
  return { label: `${over.startMs} to ${over.endMs}`, ...over };
}

// ── decodeGoogleBusySlot (pure) ──────────────────────────────────────────────

describe('decodeGoogleBusySlot', () => {
  it('decodes a same-day slot to real UTC instants', () => {
    const d = decodeGoogleBusySlot('s1', { date: '2026-08-07', startTime: '14:00', endTime: '15:30', source: 'GOOGLE_BUSY_IMPORT' });
    expect(d).not.toBeNull();
    expect(d!.startMs).toBe(Date.parse('2026-08-07T14:00:00.000Z'));
    expect(d!.endMs).toBe(Date.parse('2026-08-07T15:30:00.000Z'));
    expect(d!.label).toContain('2026-08-07 14:00 UTC');
  });

  it('rolls the end to the next UTC day when endTime <= startTime (spans midnight)', () => {
    const d = decodeGoogleBusySlot('s1', { date: '2026-08-07', startTime: '22:00', endTime: '02:00' });
    expect(d!.startMs).toBe(Date.parse('2026-08-07T22:00:00.000Z'));
    expect(d!.endMs).toBe(Date.parse('2026-08-08T02:00:00.000Z'));
  });

  it('treats an exactly-equal start/end as a 24h block rather than zero-length', () => {
    const d = decodeGoogleBusySlot('s1', { date: '2026-08-07', startTime: '09:00', endTime: '09:00' });
    expect(d!.endMs - d!.startMs).toBe(24 * 60 * 60 * 1000);
  });

  it('returns null for a malformed date/time triple rather than throwing', () => {
    expect(decodeGoogleBusySlot('s1', { date: 'not-a-date', startTime: '09:00', endTime: '10:00' })).toBeNull();
    expect(decodeGoogleBusySlot('s1', { date: '2026-08-07', startTime: 'xx', endTime: '10:00' })).toBeNull();
    expect(decodeGoogleBusySlot('s1', {})).toBeNull();
    expect(decodeGoogleBusySlot('s1', { date: '2026-08-07', startTime: '09:00' })).toBeNull();
  });
});

// ── findBookingBusyConflicts (pure, timezone-agnostic ms math) ──────────────

describe('findBookingBusyConflicts', () => {
  const busy = slot({ docId: 'b1', startMs: 1_800_000_000_000, endMs: 1_800_003_600_000 }); // 1h window

  it('exact edges do not conflict (half-open interval)', () => {
    // visit ends exactly when the busy block starts
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.startMs - 3600_000, endTimeMs: busy.startMs }], [busy]),
    ).toHaveLength(0);
    // visit starts exactly when the busy block ends
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.endMs, endTimeMs: busy.endMs + 3600_000 }], [busy]),
    ).toHaveLength(0);
  });

  it('a visit starting exactly when the busy block starts DOES conflict', () => {
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.startMs, endTimeMs: busy.startMs + 60_000 }], [busy]),
    ).toHaveLength(1);
  });

  it('a visit entirely contained inside the busy block conflicts', () => {
    const r = findBookingBusyConflicts(
      [{ startTimeMs: busy.startMs + 600_000, endTimeMs: busy.startMs + 900_000 }],
      [busy],
    );
    expect(r).toHaveLength(1);
    expect(r[0].slot.docId).toBe('b1');
  });

  it('a visit that contains the whole busy block conflicts', () => {
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.startMs - 60_000, endTimeMs: busy.endMs + 60_000 }], [busy]),
    ).toHaveLength(1);
  });

  it('a visit spanning only the busy block\'s start edge conflicts', () => {
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.startMs - 60_000, endTimeMs: busy.startMs + 60_000 }], [busy]),
    ).toHaveLength(1);
  });

  it('a visit spanning only the busy block\'s end edge conflicts', () => {
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.endMs - 60_000, endTimeMs: busy.endMs + 60_000 }], [busy]),
    ).toHaveLength(1);
  });

  it('a disjoint visit does not conflict', () => {
    expect(
      findBookingBusyConflicts([{ startTimeMs: busy.startMs - 7_200_000, endTimeMs: busy.startMs - 3_600_000 }], [busy]),
    ).toHaveLength(0);
  });

  it('a point-in-time visit (no endTimeMs) landing inside a slot conflicts', () => {
    expect(findBookingBusyConflicts([{ startTimeMs: busy.startMs + 100 }], [busy])).toHaveLength(1);
  });

  it('a point-in-time visit landing outside a slot does not conflict', () => {
    expect(findBookingBusyConflicts([{ startTimeMs: busy.endMs + 100 }], [busy])).toHaveLength(0);
  });

  it('is pure epoch-ms math: works identically for values far apart in time / any offset', () => {
    // A slot and visit chosen with no relationship to any calendar/timezone
    // boundary at all, just raw integers, to prove nothing here reaches for
    // Date-local getters (getHours etc.) that would vary by TZ.
    const bigSlot = slot({ docId: 'far', startMs: 4_102_444_800_001, endMs: 4_102_448_400_001 });
    expect(
      findBookingBusyConflicts([{ startTimeMs: 4_102_446_000_000, endTimeMs: 4_102_447_000_000 }], [bigSlot]),
    ).toHaveLength(1);
  });

  it('checks every visit against every slot and reports each conflict with its own visitIndex', () => {
    const slotA = slot({ docId: 'a', startMs: 1000, endMs: 2000 });
    const slotB = slot({ docId: 'b', startMs: 5000, endMs: 6000 });
    const r = findBookingBusyConflicts(
      [
        { startTimeMs: 1500, endTimeMs: 1600 }, // conflicts with slotA
        { startTimeMs: 3000, endTimeMs: 3100 }, // conflicts with nothing
        { startTimeMs: 5500, endTimeMs: 5600 }, // conflicts with slotB
      ],
      [slotA, slotB],
    );
    expect(r).toHaveLength(2);
    expect(r[0].visitIndex).toBe(0);
    expect(r[0].slot.docId).toBe('a');
    expect(r[1].visitIndex).toBe(2);
    expect(r[1].slot.docId).toBe('b');
  });

  it('skips a visit whose startTimeMs is not a finite number, rather than throwing', () => {
    expect(() =>
      findBookingBusyConflicts([{ startTimeMs: Number.NaN, endTimeMs: 100 }], [busy]),
    ).not.toThrow();
    expect(findBookingBusyConflicts([{ startTimeMs: Number.NaN }], [busy])).toHaveLength(0);
  });

  it('no busy slots at all means no conflicts', () => {
    expect(findBookingBusyConflicts([{ startTimeMs: 1000, endTimeMs: 2000 }], [])).toHaveLength(0);
  });
});

describe('formatBookingBusyConflictMessage', () => {
  it('names every conflicting visit and its window, 1-indexed for the reader', () => {
    const msg = formatBookingBusyConflictMessage([
      { visitIndex: 0, visitLabel: 'X', slot: slot({ docId: 's1', startMs: 0, endMs: 1, label: '2026-08-07 14:00 UTC to 2026-08-07 15:00 UTC' }) },
      { visitIndex: 2, visitLabel: 'Y', slot: slot({ docId: 's2', startMs: 0, endMs: 1, label: '2026-08-08 09:00 UTC to 2026-08-08 10:00 UTC' }) },
    ]);
    expect(msg).toContain('visit 1');
    expect(msg).toContain('visit 3');
    expect(msg).toContain('2026-08-07 14:00 UTC to 2026-08-07 15:00 UTC');
    expect(msg).toContain('2026-08-08 09:00 UTC to 2026-08-08 10:00 UTC');
  });
});

// ── utcDateRangeForVisits (pure) ─────────────────────────────────────────────

describe('utcDateRangeForVisits', () => {
  it('pads a single visit\'s day by one on each side', () => {
    const r = utcDateRangeForVisits([
      { startTimeMs: Date.parse('2026-08-07T14:00:00.000Z'), endTimeMs: Date.parse('2026-08-07T15:00:00.000Z') },
    ]);
    expect(r).toEqual({ fromDate: '2026-08-06', toDate: '2026-08-08' });
  });

  it('spans the min start to the max end across multiple visits', () => {
    const r = utcDateRangeForVisits([
      { startTimeMs: Date.parse('2026-08-07T14:00:00.000Z') },
      { startTimeMs: Date.parse('2026-08-20T14:00:00.000Z') },
    ]);
    expect(r!.fromDate).toBe('2026-08-06');
    expect(r!.toDate).toBe('2026-08-21');
  });

  it('returns null when no visit has a resolvable window', () => {
    expect(utcDateRangeForVisits([{ startTimeMs: Number.NaN }])).toBeNull();
    expect(utcDateRangeForVisits([])).toBeNull();
  });
});

// ── loadGoogleBusySlots (Firestore query shape, against the query-enforcing mockDb) ──

describe('loadGoogleBusySlots', () => {
  it('queries booking_time_slots by a single date range (no composite filter) and decodes matches', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } },
          // Outside the padded range entirely.
          { id: 'gbi-2', data: { date: '2020-01-01', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    const result = await loadGoogleBusySlots(ctx.db as any, [
      { startTimeMs: Date.parse('2026-08-07T13:00:00.000Z'), endTimeMs: Date.parse('2026-08-07T16:00:00.000Z') },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe('gbi-1');
  });

  it('filters out non-GOOGLE_BUSY_IMPORT rows in the same date window (INTERNAL_MANUAL blocks are out of scope)', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'manual-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'INTERNAL_MANUAL' } },
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '16:00', endTime: '17:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    const result = await loadGoogleBusySlots(ctx.db as any, [
      { startTimeMs: Date.parse('2026-08-07T13:00:00.000Z'), endTimeMs: Date.parse('2026-08-07T18:00:00.000Z') },
    ]);
    expect(result.map((r) => r.docId)).toEqual(['gbi-1']);
  });

  it('skips a GOOGLE_BUSY_IMPORT row with malformed date/time fields rather than throwing', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'bad-1', data: { date: '2026-08-07', startTime: '', endTime: '', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    const result = await loadGoogleBusySlots(ctx.db as any, [
      { startTimeMs: Date.parse('2026-08-07T13:00:00.000Z') },
    ]);
    expect(result).toHaveLength(0);
  });

  it('returns empty with no Firestore read at all when every visit has an unresolvable window', async () => {
    const ctx = buildDbMock({
      queryDocs: { booking_time_slots: [{ id: 'gbi-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } }] },
    });
    const result = await loadGoogleBusySlots(ctx.db as any, [{ startTimeMs: Number.NaN }]);
    expect(result).toHaveLength(0);
  });
});

// ── guardBookingBusyConflict (the one call every write path makes) ──────────

describe('guardBookingBusyConflict', () => {
  it('resolves silently when the collection is empty', async () => {
    const ctx = buildDbMock({});
    await expect(
      guardBookingBusyConflict({
        firestore: ctx.db as any,
        visits: [{ startTimeMs: Date.parse('2026-08-07T14:00:00.000Z'), endTimeMs: Date.parse('2026-08-07T15:00:00.000Z') }],
        actorUid: 'u1',
        actorRole: 'PRIMARY',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('resolves silently when busy slots exist but none overlap the candidate visit', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '09:00', endTime: '10:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    await expect(
      guardBookingBusyConflict({
        firestore: ctx.db as any,
        visits: [{ startTimeMs: Date.parse('2026-08-07T14:00:00.000Z'), endTimeMs: Date.parse('2026-08-07T15:00:00.000Z') }],
        actorUid: 'u1',
        actorRole: 'PRIMARY',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws failed-precondition naming the date/time window when a conflict is found and not overridden', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    let thrown: any;
    try {
      await guardBookingBusyConflict({
        firestore: ctx.db as any,
        visits: [{ startTimeMs: Date.parse('2026-08-07T14:15:00.000Z'), endTimeMs: Date.parse('2026-08-07T14:45:00.000Z') }],
        actorUid: 'u1',
        actorRole: 'PRIMARY',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('failed-precondition');
    expect(thrown.message).toContain('2026-08-07 14:00 UTC');
    expect(thrown.details).toMatchObject({ code: BOOKING_BUSY_CONFLICT_CODE });
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('names EVERY conflicting visit, not just the first', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } },
          { id: 'gbi-2', data: { date: '2026-08-08', startTime: '09:00', endTime: '10:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    await expect(
      guardBookingBusyConflict({
        firestore: ctx.db as any,
        visits: [
          { startTimeMs: Date.parse('2026-08-07T14:15:00.000Z'), endTimeMs: Date.parse('2026-08-07T14:45:00.000Z') },
          { startTimeMs: Date.parse('2026-08-08T09:15:00.000Z'), endTimeMs: Date.parse('2026-08-08T09:45:00.000Z') },
        ],
        actorUid: 'u1',
        actorRole: 'PRIMARY',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('visit 1'),
    });
  });

  it('when overridden, does not throw, writes the visit through, and audits exactly what was overridden', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-08-07', startTime: '14:00', endTime: '15:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    await guardBookingBusyConflict({
      firestore: ctx.db as any,
      visits: [{ startTimeMs: Date.parse('2026-08-07T14:15:00.000Z'), endTimeMs: Date.parse('2026-08-07T14:45:00.000Z') }],
      actorUid: 'admin1',
      actorRole: 'AUNTIE',
      override: true,
      auditContext: { kinfolkId: 'kf1' },
    });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_BUSY_CONFLICT_OVERRIDDEN',
        actorRole: 'AUNTIE',
        actorUid: 'admin1',
        payload: expect.objectContaining({ kinfolkId: 'kf1' }),
      }),
    );
    const call = mocks.writeAuditEntryFn.mock.calls[0][0];
    expect(call.payload.conflicts).toHaveLength(1);
    expect(call.payload.conflicts[0].slotDocId).toBe('gbi-1');
  });

  it('override with no actual conflict never audits (nothing was overridden)', async () => {
    const ctx = buildDbMock({});
    await guardBookingBusyConflict({
      firestore: ctx.db as any,
      visits: [{ startTimeMs: Date.parse('2026-08-07T14:15:00.000Z') }],
      actorUid: 'admin1',
      actorRole: 'AUNTIE',
      override: true,
    });
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });
});
