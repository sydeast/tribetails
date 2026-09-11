import { describe, it, expect } from 'vitest';
import type { KinTaleEntry } from '../api/kinTales';
import type { SessionEntry } from '../api/sessions';
import type { InvoiceEntry } from '../api/invoices';
import {
  recentTalesFor,
  upcomingVisitsFor,
  horizonIso,
  UPCOMING_HORIZON_DAYS,
  invoicesForKinfolk,
  kinfolkInvoiceFeedLabel,
  invoiceIsOutstanding,
  invoiceRowAmount,
  outstandingTotal,
  feedCountMeta,
  tenureLabel,
  coversKin,
} from './kinfolkProfileFeeds';

function tale(over: Partial<KinTaleEntry> = {}): KinTaleEntry {
  return { _id: 't1', kinfolkId: 'k1', status: 'SENT', sentAt: '2026-08-01T09:00:00Z', ...over };
}
function session(over: Partial<SessionEntry> = {}): SessionEntry {
  return { _id: 's1', kinfolkId: 'k1', status: 'SCHEDULED', startTime: '2026-08-20T09:00:00Z', ...over } as SessionEntry;
}
function invoice(over: Partial<InvoiceEntry> = {}): InvoiceEntry {
  return {
    _id: 'i1',
    kinfolkId: 'k1',
    kinfolkName: '',
    client: '',
    invoiceNumber: 'TT-2048',
    date: '2026-08-01',
    dueDate: '',
    total: 280,
    amountDue: 0,
    status: 'paid',
    editScope: 'none',
    sessionIds: [],
    createdAt: null,
    ...over,
  } as InvoiceEntry;
}

describe('recentTalesFor', () => {
  it('keeps only this household', () => {
    const rows = recentTalesFor([tale(), tale({ _id: 't2', kinfolkId: 'other' })], 'k1');
    expect(rows.map((r) => r._id)).toEqual(['t1']);
  });

  it('keeps only SENT, whatever the casing', () => {
    const rows = recentTalesFor(
      [tale({ _id: 'a', status: 'sent' }), tale({ _id: 'b', status: 'DRAFT' })],
      'k1',
    );
    expect(rows.map((r) => r._id)).toEqual(['a']);
  });

  it('orders newest first and falls back to visitDate when sentAt is blank', () => {
    const rows = recentTalesFor(
      [
        tale({ _id: 'old', sentAt: '2026-07-01T00:00:00Z' }),
        tale({ _id: 'newest', sentAt: '2026-08-10T00:00:00Z' }),
        tale({ _id: 'byVisit', sentAt: '', visitDate: '2026-08-05T00:00:00Z' }),
      ],
      'k1',
    );
    expect(rows.map((r) => r._id)).toEqual(['newest', 'byVisit', 'old']);
  });

  it('survives a legacy row with no status and no dates', () => {
    expect(recentTalesFor([{ _id: 'bare' } as KinTaleEntry], 'k1')).toEqual([]);
  });

  it('caps at the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => tale({ _id: `t${i}`, sentAt: `2026-08-0${i}T00:00:00Z` }));
    expect(recentTalesFor(many, 'k1')).toHaveLength(5);
    expect(recentTalesFor(many, 'k1', 2)).toHaveLength(2);
  });

  it('does not mutate the source array', () => {
    const src = [tale({ _id: 'a', sentAt: '2026-07-01T00:00:00Z' }), tale({ _id: 'b', sentAt: '2026-08-01T00:00:00Z' })];
    recentTalesFor(src, 'k1');
    expect(src.map((r) => r._id)).toEqual(['a', 'b']);
  });
});

describe('upcomingVisitsFor', () => {
  const now = '2026-08-17T12:00:00Z';

  it('keeps SCHEDULED and CONFIRMED only', () => {
    const rows = upcomingVisitsFor(
      [
        session({ _id: 'sched', status: 'SCHEDULED' }),
        session({ _id: 'conf', status: 'confirmed', startTime: '2026-08-21T09:00:00Z' }),
        session({ _id: 'done', status: 'COMPLETED', startTime: '2026-08-22T09:00:00Z' }),
        session({ _id: 'cancelled', status: 'CANCELLED', startTime: '2026-08-23T09:00:00Z' }),
      ],
      'k1',
      now,
    );
    expect(rows.map((r) => r._id)).toEqual(['sched', 'conf']);
  });

  it('drops anything already started and anything undated', () => {
    const rows = upcomingVisitsFor(
      [
        session({ _id: 'past', startTime: '2026-08-01T09:00:00Z' }),
        session({ _id: 'undated', startTime: '' }),
        session({ _id: 'future' }),
      ],
      'k1',
      now,
    );
    expect(rows.map((r) => r._id)).toEqual(['future']);
  });

  it('orders soonest first', () => {
    const rows = upcomingVisitsFor(
      [
        session({ _id: 'sat', startTime: '2026-08-22T10:00:00Z' }),
        session({ _id: 'wed', startTime: '2026-08-19T09:00:00Z' }),
      ],
      'k1',
      now,
    );
    expect(rows.map((r) => r._id)).toEqual(['wed', 'sat']);
  });

  it('scopes to the household', () => {
    expect(upcomingVisitsFor([session({ kinfolkId: 'other' })], 'k1', now)).toEqual([]);
  });
  it('honours a far edge when one is given, and looks past it when one is not', () => {
    const rows = [
      session({ _id: 'inside', startTime: '2026-08-19T09:00:00Z' }),
      session({ _id: 'beyond', startTime: '2026-09-30T09:00:00Z' }),
    ];
    const through = horizonIso(new Date('2026-08-17T12:00:00Z'), UPCOMING_HORIZON_DAYS);
    expect(upcomingVisitsFor(rows, 'k1', now, through).map((r) => r._id)).toEqual(['inside']);
    expect(upcomingVisitsFor(rows, 'k1', now, null).map((r) => r._id)).toEqual(['inside', 'beyond']);
  });
});

describe('coversKin', () => {
  it('keeps a legacy row that names no pets at all', () => {
    expect(coversKin(undefined, 'p1')).toBe(true);
  });

  it('drops a row whose writer found no pets, since that is a fact and not a gap', () => {
    expect(coversKin([], 'p1')).toBe(false);
  });

  it('matches on the id, never on position', () => {
    expect(coversKin(['p2', 'p1'], 'p1')).toBe(true);
    expect(coversKin(['p2'], 'p1')).toBe(false);
  });
});

describe('horizonIso', () => {
  it('lands the requested number of days out', () => {
    expect(horizonIso(new Date('2026-08-17T12:00:00Z'), 7).slice(0, 10)).toBe('2026-08-24');
  });
  it('crosses a month boundary rather than clamping inside it', () => {
    expect(horizonIso(new Date('2026-08-28T12:00:00Z'), 7).slice(0, 10)).toBe('2026-09-04');
  });
});

describe('invoicesForKinfolk', () => {
  it('scopes, orders newest first, and caps', () => {
    const rows = invoicesForKinfolk(
      [
        invoice({ _id: 'old', date: '2026-06-01' }),
        invoice({ _id: 'new', date: '2026-08-01' }),
        invoice({ _id: 'theirs', kinfolkId: 'other', date: '2026-09-01' }),
      ],
      'k1',
    );
    expect(rows.map((r) => r._id)).toEqual(['new', 'old']);
  });
});

describe('kinfolkInvoiceFeedLabel', () => {
  it('formats a readable date onto the number', () => {
    expect(kinfolkInvoiceFeedLabel({ invoiceNumber: 'TT-2048', date: '2026-08-01' })).toBe(
      'TT-2048 · Aug 1, 2026',
    );
  });

  it('drops the separator entirely when there is no date', () => {
    expect(kinfolkInvoiceFeedLabel({ invoiceNumber: 'TT-2048', date: '' })).toBe('TT-2048');
  });

  it('prints an unreadable stored date exactly as stored, never "Invalid Date"', () => {
    expect(kinfolkInvoiceFeedLabel({ invoiceNumber: 'TT-2048', date: '07/24/2026' })).toBe(
      'TT-2048 · 07/24/2026',
    );
  });

  it('names a numberless invoice rather than rendering a bare separator', () => {
    expect(kinfolkInvoiceFeedLabel({ invoiceNumber: '', date: '' })).toBe('Invoice');
  });
});

describe('invoice money', () => {
  it('counts only an open invoice with a balance as outstanding', () => {
    expect(invoiceIsOutstanding({ status: 'open', amountDue: 40 })).toBe(true);
    expect(invoiceIsOutstanding({ status: 'open', amountDue: 0 })).toBe(false);
    expect(invoiceIsOutstanding({ status: 'paid', amountDue: 0 })).toBe(false);
  });

  it('does not read a quote, a draft or a cancelled bill as money owed', () => {
    for (const status of ['quote', 'draft', 'cancelled', 'credit', 'redeemed', 'zero'] as const) {
      expect(invoiceIsOutstanding({ status, amountDue: 99 })).toBe(false);
    }
  });

  it('shows the balance while one is owed, else the total', () => {
    expect(invoiceRowAmount({ total: 280, amountDue: 40 })).toBe(40);
    expect(invoiceRowAmount({ total: 280, amountDue: 0 })).toBe(280);
  });

  it('sums only the outstanding balances', () => {
    const total = outstandingTotal([
      invoice({ status: 'open', amountDue: 40 }),
      invoice({ status: 'open', amountDue: 60 }),
      invoice({ status: 'paid', amountDue: 0 }),
      invoice({ status: 'quote', amountDue: 500 }),
    ]);
    expect(total).toBe(100);
  });
});

describe('feedCountMeta', () => {
  it('says "total" while the read is under its cap', () => {
    expect(feedCountMeta(3, 3, false)).toBe('3 total');
  });

  it('says how many of the total are shown when the card is truncated', () => {
    expect(feedCountMeta(5, 12, false)).toBe('5 of 12 total');
  });

  it('refuses to call a capped read a total', () => {
    expect(feedCountMeta(5, 200, true)).toBe('5 of 200+ loaded');
  });
  /**
   * The count a card shows is often a SUBSET of what it read: the KinTales card
   * counts the sent ones out of every report on the household. So cappedness has
   * to come from the raw read, or 150 sent rows out of a read capped at 200 would
   * announce themselves as the household's total.
   */
  it('trusts the caller about cappedness rather than inferring it from the subset', () => {
    expect(feedCountMeta(5, 150, true)).toBe('5 of 150+ loaded');
    expect(feedCountMeta(5, 150, false)).toBe('5 of 150 total');
  });
});

describe('tenureLabel', () => {
  const now = new Date(2026, 7, 17); // 2026-08-17, local

  it('counts whole months', () => {
    expect(tenureLabel('2025-06-17', now)).toBe('14 months');
  });

  it('does not credit a month that has not completed', () => {
    expect(tenureLabel('2025-06-18', now)).toBe('13 months');
  });

  it('says "new" inside the first month rather than "0 months"', () => {
    expect(tenureLabel('2026-08-01', now)).toBe('new');
  });

  it('singularizes one month', () => {
    expect(tenureLabel('2026-07-17', now)).toBe('1 month');
  });

  it('switches to years past two', () => {
    expect(tenureLabel('2023-01-17', now)).toBe('3 years');
  });

  it('reads the day off a full ISO instant', () => {
    expect(tenureLabel('2025-06-17T12:34:56.789Z', now)).toBe('14 months');
  });

  it('claims nothing for a blank, an unparseable, or an impossible stored date', () => {
    expect(tenureLabel('', now)).toBeNull();
    expect(tenureLabel('07/24/2026', now)).toBeNull();
    expect(tenureLabel('2026-02-30', now)).toBeNull();
    expect(tenureLabel('sometime in 2025', now)).toBeNull();
  });

  it('claims nothing for a join date in the future', () => {
    expect(tenureLabel('2027-01-01', now)).toBeNull();
  });
});
