import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import {
  INVOICES_QUERY,
  INVOICES_PAGE_SIZE,
  invoiceMatchesSearch,
  invoicesPageQuery,
  isArchivedInvoice,
  normalizeInvoice,
  type InvoiceEntry,
} from './invoices';

describe('INVOICES_QUERY', () => {
  it('streams the flat top-level invoices collection', () => {
    expect(INVOICES_QUERY.path).toBe('invoices');
  });

  it('is bounded and server-ordered by createdAt desc (AO-29: never an unbounded listen)', () => {
    expect(INVOICES_QUERY.order).toEqual(['createdAt', 'desc']);
    expect(INVOICES_QUERY.max).toBe(200);
  });

  it('carries no filters of its own; the sandbox scope is added centrally', () => {
    // See lib/testScope.ts. A test admin gets `kinfolkId == testTribeId`
    // injected by useCollection, which is why the composite indexes
    // (kinfolkId, createdAt) exist in MyTribe/firestore.indexes.json.
    expect(INVOICES_QUERY.filters).toBeUndefined();
  });
});

describe('normalizeInvoice (live-data crash guards, 2026-07-20)', () => {
  // The exact production shape of `test-kinfolk-001-invoice-1`: no status, no
  // sessionIds, no client, no invoiceNumber. Rendering it blanked the ENTIRE
  // invoices page twice through the error boundary before this existed.
  const REAL_SANDBOX_DOC = {
    _id: 'test-kinfolk-001-invoice-1',
    kinfolkId: 'test-kinfolk-001',
    total: 60,
    amountDue: 0,
    createdAt: null,
  } as unknown as InvoiceEntry;

  it('fills the array field that crashed on .length', () => {
    expect(normalizeInvoice(REAL_SANDBOX_DOC).sessionIds).toEqual([]);
  });

  it('fills the string field that crashed on .trim', () => {
    expect(normalizeInvoice(REAL_SANDBOX_DOC).status).toBe('');
  });

  it('does NOT invent money it was not given', () => {
    // Defaulting an absent total to 0 would assert a financial fact the document
    // never made. invoiceState reads a non-finite number as "no evidence".
    const noMoney = normalizeInvoice({ _id: 'x' } as unknown as InvoiceEntry);
    expect(noMoney.total).toBeUndefined();
    expect(noMoney.amountDue).toBeUndefined();
  });

  it('leaves a fully-populated row untouched', () => {
    const full = {
      _id: 'a', kinfolkId: 'k', kinfolkName: 'N', client: 'C', invoiceNumber: '1001',
      date: 'August 11, 2025', dueDate: 'September 17, 2025', total: 315, amountDue: 0,
      status: 'paid', sessionIds: ['s1'], createdAt: null,
    } as unknown as InvoiceEntry;
    expect(normalizeInvoice(full)).toEqual(full);
  });
});

describe('invoicesPageQuery: the list screen own paged window', () => {
  it('pages the invoices collection by invoice date, newest first', () => {
    const spec = invoicesPageQuery({ startDay: null });
    expect(spec.path).toBe('invoices');
    expect(spec.order).toEqual(['date', 'desc']);
    expect(spec.pageSize).toBe(INVOICES_PAGE_SIZE);
  });

  it('windows on `date`, NOT on the Timestamp `createdAt`', () => {
    // This is the load-bearing assertion of this file. `createdAt` is a real
    // Firestore Timestamp; Firestore orders every timestamp before every string,
    // so `where('createdAt', '>=', '<iso>')` matches nothing at all and does it
    // WITHOUT erroring. Windowing on the string `date` field is what keeps the
    // preset chips from silently emptying the screen.
    const spec = invoicesPageQuery({ startDay: '2026-07-18' });
    expect(spec.filters).toEqual([['date', '>=', '2026-07-18']]);
    expect(spec.order[0]).toBe('date');
  });

  it('takes a DAY bound, not an instant, because that is what the field holds', () => {
    const bound = invoicesPageQuery({ startDay: '2026-07-18' }).filters?.[0]?.[2];
    expect(bound).toBe('2026-07-18');
  });

  it('adds NO predicate at all for the archive, rather than an always-true one', () => {
    expect(invoicesPageQuery({ startDay: null }).filters).toBeUndefined();
  });

  it('composes the household facet with the window, in the deployed index order', () => {
    // Deployed: invoices (kinfolkId ASC, date DESC).
    expect(invoicesPageQuery({ startDay: '2026-07-18', kinfolkId: 'kf1' }).filters).toEqual([
      ['kinfolkId', '==', 'kf1'],
      ['date', '>=', '2026-07-18'],
    ]);
  });

  it('treats a blank facet as "every household", never as an empty-string id', () => {
    expect(invoicesPageQuery({ startDay: null, kinfolkId: '' }).filters).toBeUndefined();
  });

  it('carries NO archivedAt predicate, which would return zero invoices today', () => {
    // Firestore `== null` matches only docs that HAVE the field. Nothing writes
    // archivedAt until Task 5.1, so a server-side exclusion would empty the
    // screen silently. The exclusion is a presence check over loaded rows.
    const named = (invoicesPageQuery({ startDay: '2026-07-18', kinfolkId: 'kf1' }).filters ?? []).map(
      (f) => f[0],
    );
    expect(named).not.toContain('archivedAt');
  });
});

describe('isArchivedInvoice', () => {
  const stamp = { toDate: () => new Date('2026-07-20T00:00:00Z') } as unknown as Timestamp;

  it('is false for the absent field every invoice carries today', () => {
    expect(isArchivedInvoice({})).toBe(false);
  });

  it('is true only once a real archive stamp is present', () => {
    expect(isArchivedInvoice({ archivedAt: stamp })).toBe(true);
  });

  it('reads an explicit null as not archived, so an unarchive either way works', () => {
    expect(isArchivedInvoice({ archivedAt: null as unknown as Timestamp })).toBe(false);
  });
});

describe('invoiceMatchesSearch', () => {
  const row = { invoiceNumber: '1042', kinfolkName: 'The Whitfields', client: 'Dana Ruiz' };

  it('matches everything on a blank query', () => {
    expect(invoiceMatchesSearch(row, '  ')).toBe(true);
  });

  it('finds an invoice by number, household, or client, case-insensitively', () => {
    expect(invoiceMatchesSearch(row, '104')).toBe(true);
    expect(invoiceMatchesSearch(row, 'whitfield')).toBe(true);
    expect(invoiceMatchesSearch(row, 'RUIZ')).toBe(true);
  });

  it('refuses a match that only exists ACROSS two fields', () => {
    expect(invoiceMatchesSearch(row, 'whitfields dana')).toBe(false);
  });

  it('never throws on the missing fields a real doc genuinely has', () => {
    expect(invoiceMatchesSearch({} as InvoiceEntry, 'anything')).toBe(false);
  });
});
