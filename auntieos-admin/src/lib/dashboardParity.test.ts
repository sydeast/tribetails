import { describe, it, expect } from 'vitest';
import {
  activeKinCount,
  formatRevenue,
  frequentFlyers,
  holidayRunway,
  householdVisitGaps,
  invoiceIsPaidForRevenue,
  mondayOfWeekIso,
  outstandingTotals,
  overdueVisits,
  pendingDraftCount,
  pendingTaleRows,
  speciesBreakdown,
  todayPack,
  usPetCareHolidays,
  weeklyCapacity,
  weeklyRevenue,
} from './dashboardInsights';
import { localDateIso } from './invoiceFormat';
import type { SessionEntry } from '../api/sessions';
import type { InvoiceEntry } from '../api/invoices';
import type { GeneratedDraftRow } from '../api/drafts';

/**
 * The D2 parity port's rules, exercised against the SAME cases android's own
 * `DashboardInsightsTest` / `HouseholdVisitGapsTest` pin down. A number this
 * dashboard shows has to equal the number the phone shows for the same
 * documents, so these are equality tests against a stated expectation rather
 * than snapshots of whatever the implementation happens to do.
 */

function sess(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 's1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    kinIds: [],
    serviceType: 'Drop-in',
    startTime: '2026-07-20T09:00:00.000Z',
    endTime: '2026-07-20T10:00:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

function inv(over: Partial<InvoiceEntry> = {}): InvoiceEntry {
  return {
    _id: 'i1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    client: 'Rivera',
    invoiceNumber: 'INV-1',
    date: '2026-07-20',
    dueDate: '2026-08-01',
    total: 100,
    amountDue: 0,
    status: 'paid',
    editScope: 'none',
    sessionIds: [],
    createdAt: null,
    ...over,
  } as InvoiceEntry;
}

function draft(over: Partial<GeneratedDraftRow> = {}): GeneratedDraftRow {
  return {
    _id: 'd1',
    kinfolk_id: 'k1',
    kinfolkName: 'Sara',
    communicationType: 'visit_report',
    generatedCopy: 'Biscuit had a lovely time.\nSecond line.',
    status: 'pending',
    createdOn: '2026-07-20T08:00:00.000Z',
    ...over,
  };
}

describe('mondayOfWeekIso', () => {
  it('answers the Monday of the week a Wednesday sits in', () => {
    // 2026-07-22 is a Wednesday.
    expect(mondayOfWeekIso('2026-07-22')).toBe('2026-07-20');
  });

  it('treats Sunday as the END of its week, matching android ISO weekdays', () => {
    // 2026-07-26 is a Sunday, so its Monday is six days back, not the next day.
    expect(mondayOfWeekIso('2026-07-26')).toBe('2026-07-20');
  });

  it('is a no-op on a Monday, and null on anything unreadable', () => {
    expect(mondayOfWeekIso('2026-07-20')).toBe('2026-07-20');
    expect(mondayOfWeekIso('next tuesday')).toBeNull();
  });
});

describe('weeklyCapacity', () => {
  it('counts this week against the busiest of the four before it', () => {
    const rows = [
      // This week (Mon 2026-07-20 .. Sun 2026-07-26): two.
      sess({ _id: 'a', startTime: '2026-07-20T09:00:00Z' }),
      sess({ _id: 'b', startTime: '2026-07-26T09:00:00Z' }),
      // Last week: three, the record.
      sess({ _id: 'c', startTime: '2026-07-13T09:00:00Z' }),
      sess({ _id: 'd', startTime: '2026-07-14T09:00:00Z' }),
      sess({ _id: 'e', startTime: '2026-07-15T09:00:00Z' }),
    ];
    const cap = weeklyCapacity(rows, '2026-07-22');
    expect(cap).toEqual({
      booked: 2,
      record: 3,
      capacity: 3,
      fraction: 2 / 3,
      beatingRecord: false,
    });
  });

  it('does not count a cancelled visit as booked capacity', () => {
    const rows = [
      sess({ _id: 'a', startTime: '2026-07-20T09:00:00Z' }),
      sess({ _id: 'b', startTime: '2026-07-21T09:00:00Z', status: 'CANCELLED' }),
      // The American spelling too: android accepts both, so this must.
      sess({ _id: 'c', startTime: '2026-07-21T10:00:00Z', status: 'CANCELED' }),
    ];
    expect(weeklyCapacity(rows, '2026-07-22')?.booked).toBe(1);
  });

  it('calls a first-ever week with visits a record, and never divides by zero', () => {
    const cap = weeklyCapacity([sess({ startTime: '2026-07-20T09:00:00Z' })], '2026-07-22');
    expect(cap).toMatchObject({ booked: 1, record: 0, capacity: 1, beatingRecord: true });
  });

  it('reports an empty week honestly rather than as a missing card', () => {
    expect(weeklyCapacity([], '2026-07-22')).toMatchObject({ booked: 0, fraction: 0 });
  });

  it('is null when the day itself cannot be read', () => {
    expect(weeklyCapacity([sess()], 'sometime')).toBeNull();
  });
});

describe('overdueVisits', () => {
  it('lists a visit that ended before today and was never completed', () => {
    const late = overdueVisits([sess({ endTime: '2026-07-19T10:00:00Z' })], '2026-07-22');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ sessionId: 's1', household: 'Rivera', serviceType: 'Drop-in' });
  });

  it('leaves today alone: the rest of the day is still time to close it out', () => {
    expect(overdueVisits([sess({ endTime: '2026-07-22T01:00:00Z' })], '2026-07-22')).toEqual([]);
  });

  it('ignores completed and cancelled visits', () => {
    const rows = [
      sess({ _id: 'a', endTime: '2026-07-19T10:00:00Z', status: 'COMPLETED' }),
      sess({ _id: 'b', endTime: '2026-07-19T10:00:00Z', status: 'CANCELLED' }),
    ];
    expect(overdueVisits(rows, '2026-07-22')).toEqual([]);
  });

  it('drops a miss older than the staleness horizon', () => {
    const rows = [sess({ endTime: '2026-01-02T10:00:00Z' })];
    expect(overdueVisits(rows, '2026-07-22')).toEqual([]);
    expect(overdueVisits(rows, '2026-07-22', 400)).toHaveLength(1);
  });

  it('falls back to startTime when no end was ever stamped, and sorts newest miss first', () => {
    const rows = [
      sess({ _id: 'older', startTime: '2026-07-10T09:00:00Z', endTime: '' }),
      sess({ _id: 'newer', startTime: '2026-07-18T09:00:00Z', endTime: '' }),
    ];
    expect(overdueVisits(rows, '2026-07-22').map((v) => v.sessionId)).toEqual(['newer', 'older']);
  });
});

describe('speciesBreakdown', () => {
  it('groups by species, biggest first then alphabetically', () => {
    expect(
      speciesBreakdown([
        { species: 'Dog' },
        { species: 'dog' },
        { species: 'Cat' },
        { species: 'Bird' },
      ]),
    ).toEqual([
      { species: 'Dog', count: 2 },
      { species: 'Bird', count: 1 },
      { species: 'Cat', count: 1 },
    ]);
  });

  it('counts a pet with no species as Unknown rather than dropping it', () => {
    expect(speciesBreakdown([{ species: '   ' }, {}])).toEqual([{ species: 'Unknown', count: 2 }]);
  });

  it('leaves archived pets out of the pack', () => {
    expect(speciesBreakdown([{ species: 'Dog', status: 'archived' }])).toEqual([]);
  });
});

describe('frequentFlyers', () => {
  const done = (id: string, day: string, over: Partial<SessionEntry> = {}) =>
    sess({ _id: id, status: 'COMPLETED', completedAt: `${day}T10:00:00Z`, ...over });

  it('ranks households by completed visits in the window', () => {
    const rows = [
      done('a', '2026-07-01'),
      done('b', '2026-07-02'),
      done('c', '2026-07-03', { kinfolkId: 'k2', kinfolkName: 'Walls' }),
    ];
    expect(frequentFlyers(rows, '2026-07-22')).toEqual([
      { household: 'Rivera', visits: 2 },
      { household: 'Walls', visits: 1 },
    ]);
  });

  it('counts only COMPLETED visits, so cancellations never flatter a household', () => {
    const rows = [done('a', '2026-07-01'), sess({ _id: 'b', status: 'CANCELLED' })];
    expect(frequentFlyers(rows, '2026-07-22')).toEqual([{ household: 'Rivera', visits: 1 }]);
  });

  it('drops a visit that fell outside the window', () => {
    expect(frequentFlyers([done('a', '2026-01-01')], '2026-07-22')).toEqual([]);
  });

  it('falls back to startTime when completedAt was never stamped', () => {
    const rows = [
      sess({ _id: 'a', status: 'COMPLETED', completedAt: '', startTime: '2026-07-01T09:00:00Z' }),
    ];
    expect(frequentFlyers(rows, '2026-07-22')).toEqual([{ household: 'Rivera', visits: 1 }]);
  });

  it('drops a group with no readable name rather than listing an anonymous count', () => {
    expect(frequentFlyers([done('a', '2026-07-01', { kinfolkName: '' })], '2026-07-22')).toEqual([]);
  });
});

describe('usPetCareHolidays and holidayRunway', () => {
  it('places the moving holidays on the right weekdays', () => {
    const byName = new Map(usPetCareHolidays(2026).map((h) => [h.name, h.dateIso]));
    // Memorial Day 2026 = last Monday in May = 25 May.
    expect(byName.get('Memorial Day')).toBe('2026-05-25');
    // Labor Day 2026 = first Monday in September = 7 September.
    expect(byName.get('Labor Day')).toBe('2026-09-07');
    // Thanksgiving 2026 = fourth Thursday in November = 26 November.
    expect(byName.get('Thanksgiving')).toBe('2026-11-26');
    expect(byName.get('July 4th')).toBe('2026-07-04');
  });

  it('counts the visits booked in the five-day window around each holiday', () => {
    const rows = [
      sess({ _id: 'in-early', startTime: '2026-09-05T09:00:00Z' }),
      sess({ _id: 'on-day', startTime: '2026-09-07T09:00:00Z' }),
      sess({ _id: 'out', startTime: '2026-09-10T09:00:00Z' }),
      sess({ _id: 'cancelled', startTime: '2026-09-06T09:00:00Z', status: 'CANCELLED' }),
    ];
    const runway = holidayRunway(rows, '2026-09-01', 1);
    expect(runway).toEqual([
      { name: 'Labor Day', dateIso: '2026-09-07', daysUntil: 6, bookedVisits: 2 },
    ]);
  });

  it('rolls into next year rather than reporting no holidays in late December', () => {
    const names = holidayRunway([], '2026-12-28', 2).map((h) => h.name);
    expect(names).toEqual(["New Year's Day", 'Memorial Day']);
  });
});

describe('householdVisitGaps', () => {
  it('ranks households by days since their last completed visit', () => {
    const rows = [
      sess({ _id: 'a', status: 'COMPLETED', completedAt: '2026-07-20T10:00:00Z' }),
      sess({
        _id: 'b',
        kinfolkId: 'k2',
        kinfolkName: 'Walls',
        status: 'COMPLETED',
        completedAt: '2026-07-01T10:00:00Z',
      }),
    ];
    expect(householdVisitGaps(rows, '2026-07-22')).toEqual([
      { household: 'Walls', daysSinceLastVisit: 21 },
      { household: 'Rivera', daysSinceLastVisit: 2 },
    ]);
  });

  it('measures from the MOST RECENT completed visit, not the first one seen', () => {
    const rows = [
      sess({ _id: 'old', status: 'COMPLETED', completedAt: '2026-06-01T10:00:00Z' }),
      sess({ _id: 'new', status: 'COMPLETED', completedAt: '2026-07-21T10:00:00Z' }),
    ];
    expect(householdVisitGaps(rows, '2026-07-22')).toEqual([
      { household: 'Rivera', daysSinceLastVisit: 1 },
    ]);
  });

  it('drops a household whose only completed visit is in the future', () => {
    const rows = [sess({ status: 'COMPLETED', completedAt: '2026-08-01T10:00:00Z' })];
    expect(householdVisitGaps(rows, '2026-07-22')).toEqual([]);
  });

  it('has nothing to rank when no visit has been completed', () => {
    expect(householdVisitGaps([sess()], '2026-07-22')).toEqual([]);
  });
});

describe('weeklyRevenue and outstandingTotals', () => {
  it('sums paid invoices dated inside the week window', () => {
    const rows = [
      inv({ _id: 'a', date: '2026-07-20', total: 100 }),
      inv({ _id: 'b', date: '2026-07-22', total: 40 }),
      inv({ _id: 'c', date: '2026-07-19', total: 999 }),
    ];
    expect(weeklyRevenue(rows, '2026-07-20', '2026-07-22')).toBe(140);
  });

  it('never counts a draft, an unpaid balance, or a zero-total invoice', () => {
    expect(invoiceIsPaidForRevenue({ status: 'draft', amountDue: 0, total: 100 })).toBe(false);
    expect(invoiceIsPaidForRevenue({ status: 'open', amountDue: 20, total: 100 })).toBe(false);
    expect(invoiceIsPaidForRevenue({ status: 'zero', amountDue: 0, total: 0 })).toBe(false);
    expect(invoiceIsPaidForRevenue({ status: 'paid', amountDue: 0, total: 100 })).toBe(true);
  });

  it('leaves an ARCHIVED invoice out of both the week and the balance', () => {
    const archived = { toDate: () => new Date() } as unknown as NonNullable<
      InvoiceEntry['archivedAt']
    >;
    const rows = [
      inv({ _id: 'a', date: '2026-07-20', total: 100, archivedAt: archived }),
      inv({ _id: 'b', date: '2026-07-20', total: 25 }),
      inv({ _id: 'c', amountDue: 60, status: 'open', archivedAt: archived }),
      inv({ _id: 'd', amountDue: 15, status: 'open' }),
    ];
    expect(weeklyRevenue(rows, '2026-07-20', '2026-07-22')).toBe(25);
    expect(outstandingTotals(rows)).toEqual({ total: 15, count: 1 });
  });

  it('skips an invoice whose date cannot be placed in a week', () => {
    expect(weeklyRevenue([inv({ date: 'Net 14' })], '2026-07-20', '2026-07-22')).toBe(0);
  });

  it('is zero rather than NaN when the window itself is unreadable', () => {
    expect(weeklyRevenue([inv()], 'whenever', '2026-07-22')).toBe(0);
  });
});

describe('formatRevenue', () => {
  it('rounds to the dollar and groups thousands', () => {
    expect(formatRevenue(1280)).toBe('$1,280');
    expect(formatRevenue(1280.6)).toBe('$1,281');
    expect(formatRevenue(999)).toBe('$999');
    expect(formatRevenue(1234567)).toBe('$1,234,567');
  });

  it('keeps a minus rather than printing a negative as positive', () => {
    expect(formatRevenue(-1280)).toBe('-$1,280');
  });

  it('reads a non-finite amount as $0, never "$NaN"', () => {
    expect(formatRevenue(Number.NaN)).toBe('$0');
  });
});

describe('todayPack', () => {
  const today = localDateIso(new Date());
  const at = (clock: string) => `${today}T${clock}`;

  it('keeps today in time order, counting done and in-flight', () => {
    const rows = [
      sess({ _id: 'late', startTime: at('15:00:00'), status: 'SCHEDULED' }),
      sess({ _id: 'early', startTime: at('08:00:00'), status: 'COMPLETED' }),
      sess({ _id: 'mid', startTime: at('11:00:00'), status: 'ARRIVED' }),
      sess({ _id: 'yesterday', startTime: '2020-01-01T09:00:00' }),
    ];
    const pack = todayPack(rows, today);
    expect(pack.visits.map((v) => v._id)).toEqual(['early', 'mid', 'late']);
    expect(pack.done).toBe(1);
    expect(pack.onTheWay).toBe(1);
  });

  it('counts ON_MY_WAY as on the way, same as the phone trend line', () => {
    const pack = todayPack([sess({ startTime: at('09:00:00'), status: 'ON_MY_WAY' })], today);
    expect(pack.onTheWay).toBe(1);
  });

  it('includes a cancelled visit in the run, matching the phone day query', () => {
    const pack = todayPack([sess({ startTime: at('09:00:00'), status: 'CANCELLED' })], today);
    expect(pack.visits).toHaveLength(1);
    expect(pack.done).toBe(0);
  });

  it('is an honest empty run on a quiet day', () => {
    expect(todayPack([], today)).toEqual({ visits: [], done: 0, onTheWay: 0 });
  });
});

describe('pendingTaleRows and pendingDraftCount', () => {
  it('builds title, blurb and meta, naming the household exactly once', () => {
    const rows = pendingTaleRows([draft({ status: 'generated' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('visit report');
    expect(rows[0]?.blurb).toBe('Biscuit had a lovely time.');
    expect(rows[0]?.meta).toBe('GENERATED · Sara · 2026-07-20');
    // The Sara-Sara defect: the name must not also be the blurb.
    expect(rows[0]?.blurb).not.toContain('Sara');
  });

  it('drops a content-less shell draft rather than showing an empty row', () => {
    expect(pendingTaleRows([draft({ generatedCopy: '   ' })])).toEqual([]);
  });

  it('skips blank leading lines to find the real first line of copy', () => {
    const rows = pendingTaleRows([draft({ generatedCopy: '\n\n  Real opening line\nmore' })]);
    expect(rows[0]?.blurb).toBe('Real opening line');
  });

  it('falls back to a readable title and omits a missing timestamp', () => {
    const rows = pendingTaleRows([draft({ communicationType: '', createdOn: '', status: '' })]);
    expect(rows[0]?.title).toBe('Visit report');
    expect(rows[0]?.meta).toBe('DRAFT · Sara');
  });

  it('caps the rows at the display limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => draft({ _id: `d${String(i)}` }));
    expect(pendingTaleRows(many, 4)).toHaveLength(4);
  });

  it('counts pending drafts by a positive match on the status', () => {
    const rows = [
      draft({ _id: 'a', status: 'pending' }),
      draft({ _id: 'b', status: 'approved' }),
      draft({ _id: 'c', status: 'PENDING' }),
      draft({ _id: 'd' }),
    ];
    expect(pendingDraftCount(rows)).toBe(3);
    expect(pendingDraftCount([])).toBe(0);
  });
});

describe('activeKinCount', () => {
  it('counts the roster minus the archived', () => {
    expect(activeKinCount([{ status: 'active' }, {}, { status: 'archived' }])).toBe(2);
  });
});
