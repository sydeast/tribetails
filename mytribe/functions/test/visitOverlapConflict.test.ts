import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  decodeOccupiedVisit,
  findVisitOverlapConflicts,
  formatVisitOverlapConflictMessage,
  guardVisitOverlapConflict,
  loadOccupyingVisits,
  occupiedVisitLabel,
  sessionDateRangeForVisits,
  VISIT_OVERLAP_CONFLICT_CODE,
} from '../src/lib/visitOverlapConflict';

beforeEach(() => {
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

describe('decodeOccupiedVisit', () => {
  it('reads a plain start/end pair as the window it occupies', () => {
    const v = decodeOccupiedVisit('s1', {
      startTime: '2026-08-24T15:00:00.000Z',
      endTime: '2026-08-24T16:00:00.000Z',
      kinfolkId: 'kf1',
    });
    expect(v).toMatchObject({
      sessionId: 's1',
      startMs: at('2026-08-24T15:00:00.000Z'),
      endMs: at('2026-08-24T16:00:00.000Z'),
      kinfolkId: 'kf1',
    });
    // #1168: 15:00 UTC is 10:00 AM on the operator's Chicago schedule.
    expect(occupiedVisitLabel(v!, 'America/Chicago')).toBe('Aug 24, 10:00-11:00 AM');
  });

  it.each([['CANCELLED'], ['CANCELED'], ['REJECTED'], ['cancelled']])(
    'a %s visit occupies nothing',
    (status) => {
      expect(
        decodeOccupiedVisit('s1', {
          status,
          startTime: '2026-08-24T15:00:00.000Z',
          endTime: '2026-08-24T16:00:00.000Z',
        }),
      ).toBeNull();
    },
  );

  it('a COMPLETED visit still occupies its window (the time really was used)', () => {
    expect(
      decodeOccupiedVisit('s1', {
        status: 'COMPLETED',
        startTime: '2026-08-24T15:00:00.000Z',
        endTime: '2026-08-24T16:00:00.000Z',
      }),
    ).not.toBeNull();
  });

  it('falls back to serviceDurationMinutes when the stored end is unusable', () => {
    const v = decodeOccupiedVisit('s1', {
      startTime: '2026-08-24T15:00:00.000Z',
      endTime: '2026-08-24T14:00:00.000Z', // before the start: garbage, not a negative visit
      serviceDurationMinutes: 90,
    });
    expect(v?.endMs).toBe(at('2026-08-24T16:30:00.000Z'));
  });

  it('falls back to 30 minutes when neither an end nor a duration can be read', () => {
    const v = decodeOccupiedVisit('s1', { startTime: '2026-08-24T15:00:00.000Z' });
    expect(v?.endMs).toBe(at('2026-08-24T15:30:00.000Z'));
  });

  it('an unparseable start is skipped rather than thrown on', () => {
    expect(decodeOccupiedVisit('s1', { startTime: 'sometime tuesday' })).toBeNull();
    expect(decodeOccupiedVisit('s1', {})).toBeNull();
  });
});

describe('findVisitOverlapConflicts', () => {
  const occupied = [
    {
      sessionId: 's1',
      startMs: at('2026-08-24T15:00:00.000Z'),
      endMs: at('2026-08-24T16:00:00.000Z'),
      kinfolkId: 'kf1',
    },
  ];

  it('flags a window that lands inside an existing visit', () => {
    const found = findVisitOverlapConflicts(
      [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }],
      occupied,
    );
    expect(found).toHaveLength(1);
    expect(found[0].occupied.sessionId).toBe('s1');
  });

  it('back-to-back is not a conflict, on either side', () => {
    expect(
      findVisitOverlapConflicts(
        [{ startTimeMs: at('2026-08-24T16:00:00.000Z'), endTimeMs: at('2026-08-24T17:00:00.000Z') }],
        occupied,
      ),
    ).toHaveLength(0);
    expect(
      findVisitOverlapConflicts(
        [{ startTimeMs: at('2026-08-24T14:00:00.000Z'), endTimeMs: at('2026-08-24T15:00:00.000Z') }],
        occupied,
      ),
    ).toHaveLength(0);
  });

  it('an identical start IS a conflict', () => {
    expect(
      findVisitOverlapConflicts(
        [{ startTimeMs: at('2026-08-24T15:00:00.000Z'), endTimeMs: at('2026-08-24T15:15:00.000Z') }],
        occupied,
      ),
    ).toHaveLength(1);
  });

  it('excludeSessionId keeps a visit from conflicting with where it already is', () => {
    const nudged = [
      { startTimeMs: at('2026-08-24T15:15:00.000Z'), endTimeMs: at('2026-08-24T16:15:00.000Z') },
    ];
    expect(findVisitOverlapConflicts(nudged, occupied)).toHaveLength(1);
    expect(findVisitOverlapConflicts(nudged, occupied, 's1')).toHaveLength(0);
  });

  it('names every colliding window, never only the first', () => {
    const two = [
      ...occupied,
      {
        sessionId: 's2',
        startMs: at('2026-08-24T15:45:00.000Z'),
        endMs: at('2026-08-24T17:00:00.000Z'),
        kinfolkId: null,
      },
    ];
    const found = findVisitOverlapConflicts(
      [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }],
      two,
    );
    expect(found.map((c) => c.occupied.sessionId)).toEqual(['s1', 's2']);
    const message = formatVisitOverlapConflictMessage(found, 'America/Chicago');
    expect(message).toContain('(Aug 24, 10:00-11:00 AM)');
    expect(message).toContain('(Aug 24, 10:45 AM-12:00 PM)');
  });
});

describe('sessionDateRangeForVisits', () => {
  it('pads a day back and two days forward, so an offset writer is still read', () => {
    expect(
      sessionDateRangeForVisits([
        { startTimeMs: at('2026-08-24T15:00:00.000Z'), endTimeMs: at('2026-08-24T16:00:00.000Z') },
      ]),
    ).toEqual({ fromDate: '2026-08-23', toDateExclusive: '2026-08-26' });
  });

  it('is null when no candidate has a resolvable window', () => {
    expect(sessionDateRangeForVisits([{ startTimeMs: Number.NaN }])).toBeNull();
  });
});

describe('loadOccupyingVisits', () => {
  it('reads the padded date window and drops the rows that occupy nothing', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          {
            id: 'in-window',
            data: { startTime: '2026-08-24T15:00:00.000Z', endTime: '2026-08-24T16:00:00.000Z' },
          },
          {
            id: 'cancelled',
            data: {
              status: 'CANCELLED',
              startTime: '2026-08-24T15:00:00.000Z',
              endTime: '2026-08-24T16:00:00.000Z',
            },
          },
          { id: 'far-future', data: { startTime: '2027-01-01T15:00:00.000Z' } },
        ],
      },
    });

    const out = await loadOccupyingVisits(ctx.db, [
      { startTimeMs: at('2026-08-24T15:00:00.000Z'), endTimeMs: at('2026-08-24T16:00:00.000Z') },
    ]);
    expect(out.map((o) => o.sessionId)).toEqual(['in-window']);
  });
});

describe('guardVisitOverlapConflict', () => {
  function ctxWith(startTime: string, endTime: string, settings: Record<string, unknown> = { timeZone: 'America/Chicago' }) {
    return buildDbMock({
      docs: { 'business_settings/business_settings': settings },
      queryDocs: {
        kin_care_sessions: [{ id: 'existing', data: { startTime, endTime, kinfolkId: 'kf9' } }],
      },
    });
  }

  it('resolves silently when nothing overlaps', async () => {
    const ctx = ctxWith('2026-08-24T09:00:00.000Z', '2026-08-24T10:00:00.000Z');
    await expect(
      guardVisitOverlapConflict({
        firestore: ctx.db,
        visits: [{ startTimeMs: at('2026-08-24T15:00:00.000Z'), endTimeMs: at('2026-08-24T16:00:00.000Z') }],
        actorUid: 'admin1',
        actorRole: 'AUNTIE',
        attempt: 'create_visit',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('refuses with failed-precondition, a machine code, and the colliding session id', async () => {
    const ctx = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z');
    await expect(
      guardVisitOverlapConflict({
        firestore: ctx.db,
        visits: [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }],
        actorUid: 'admin1',
        actorRole: 'AUNTIE',
        attempt: 'block_time',
      }),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: {
        code: VISIT_OVERLAP_CONFLICT_CODE,
        attempt: 'block_time',
        conflicts: [{ sessionId: 'existing' }],
      },
    });
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  // #1168: the operator reads 10:00 AM on the schedule, so the refusal must not say 15:00.
  it('words the refusal and details.window in the business zone, never UTC', async () => {
    const ctx = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z');
    const err = await guardVisitOverlapConflict({
      firestore: ctx.db,
      visits: [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }],
      actorUid: 'admin1',
      actorRole: 'AUNTIE',
      attempt: 'block_time',
    }).catch((e) => e);
    expect(err.message).toBe(
      'That time is already taken: visit 1 (Aug 24, 10:30-11:30 AM) overlaps a visit already booked (Aug 24, 10:00-11:00 AM).',
    );
    expect(err.details.conflicts[0].window).toBe('Aug 24, 10:00-11:00 AM');
    expect(err.message).not.toMatch(/UTC|15:00/);
  });

  it('follows the zone the operator set, and falls back to the Chicago default when none is stored', async () => {
    const la = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z', { timeZone: 'America/Los_Angeles' });
    const visits = [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }];
    const base = { visits, actorUid: 'admin1', actorRole: 'AUNTIE' as const, attempt: 'block_time' };
    const laErr = await guardVisitOverlapConflict({ ...base, firestore: la.db }).catch((e) => e);
    expect(laErr.details.conflicts[0].window).toBe('Aug 24, 8:00-9:00 AM');
    const none = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z', {});
    const noneErr = await guardVisitOverlapConflict({ ...base, firestore: none.db }).catch((e) => e);
    expect(noneErr.details.conflicts[0].window).toBe('Aug 24, 10:00-11:00 AM');
  });

  it('an explicit override writes it through, and audits exactly what was written over', async () => {
    const ctx = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z');
    await expect(
      guardVisitOverlapConflict({
        firestore: ctx.db,
        visits: [{ startTimeMs: at('2026-08-24T15:30:00.000Z'), endTimeMs: at('2026-08-24T16:30:00.000Z') }],
        actorUid: 'admin1',
        actorRole: 'AUNTIE',
        override: true,
        attempt: 'create_visit',
        auditContext: { kinfolkId: 'kf1' },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.writeAuditEntryFn).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryFn.mock.calls[0][0]).toMatchObject({
      event: 'VISIT_OVERLAP_CONFLICT_OVERRIDDEN',
      severity: 'warn',
      actorUid: 'admin1',
      payload: { kinfolkId: 'kf1', attempt: 'create_visit', conflicts: [{ sessionId: 'existing' }] },
    });
    // #1168: the audit sentence reads on the operator's clock too.
    const description = mocks.writeAuditEntryFn.mock.calls[0][0].description as string;
    expect(description).toContain('(Aug 24, 10:30-11:30 AM)');
    expect(description).toContain('(Aug 24, 10:00-11:00 AM)');
    expect(description).not.toContain('UTC');
  });

  it('a candidate an hour clear of the only visit on file is never even considered', async () => {
    const ctx = ctxWith('2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z');
    await expect(
      guardVisitOverlapConflict({
        firestore: ctx.db,
        visits: [
          {
            startTimeMs: at('2026-08-24T16:00:00.000Z') + HOUR,
            endTimeMs: at('2026-08-24T16:00:00.000Z') + 2 * HOUR,
          },
        ],
        actorUid: 'admin1',
        actorRole: 'AUNTIE',
        attempt: 'reschedule',
      }),
    ).resolves.toBeUndefined();
  });
});
