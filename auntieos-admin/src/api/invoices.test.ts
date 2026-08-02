import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import {
  INVOICE_STATES,
  INVOICES_QUERY,
  INVOICES_PAGE_SIZE,
  invoiceMatchesSearch,
  invoicesPageQuery,
  invoiceStamp,
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

  it('does NOT invent a status, and reading the absent one through the stamp cannot crash', () => {
    // This used to assert `status: ''` was filled in, guarding the classifier's
    // `.trim()` crash. The classifier is gone (ADR-0002) and '' is not a member
    // of the stamped union, so inventing it would be worse than leaving the
    // field absent: `invoiceStamp` is the one reader, and it answers "no stamp"
    // without touching a method on the missing value.
    expect(normalizeInvoice(REAL_SANDBOX_DOC).status).toBeUndefined();
    expect(() => invoiceStamp(normalizeInvoice(REAL_SANDBOX_DOC))).not.toThrow();
    expect(invoiceStamp(normalizeInvoice(REAL_SANDBOX_DOC))).toEqual({ state: null, editScope: 'none' });
  });

  it('does NOT invent money it was not given', () => {
    // Defaulting an absent total to 0 would assert a financial fact the document
    // never made.
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

/**
 * The read side of ADR-0002's stamp: this is the ONE place the app decides
 * whether a doc carries a stamp, so it is the one place the fail-soft is
 * pinned. The rule everywhere: recognized stamp -> render it verbatim; anything
 * else -> state null + editScope 'none' (the safe affordance), NEVER a state
 * re-derived from the money fields.
 */
describe('invoiceStamp', () => {
  function stamped(status: unknown, editScope: unknown) {
    return invoiceStamp({ status, editScope } as unknown as Pick<InvoiceEntry, 'status' | 'editScope'>);
  }

  it('passes every canonical state through verbatim', () => {
    for (const state of INVOICE_STATES) {
      expect(stamped(state, 'all')).toEqual({ state, editScope: 'all' });
    }
  });

  it('passes each of the three editScope values through verbatim', () => {
    expect(stamped('open', 'all').editScope).toBe('all');
    expect(stamped('open', 'metadataOnly').editScope).toBe('metadataOnly');
    expect(stamped('paid', 'none').editScope).toBe('none');
  });

  it('reads an absent status as "no stamp", with the safe affordance', () => {
    expect(stamped(undefined, 'all')).toEqual({ state: null, editScope: 'none' });
  });

  it('reads a legacy free-text status as "no stamp", never normalizing it into a state', () => {
    // The stamp writes lowercase, exactly. 'PAID' is not "obviously paid": it
    // is evidence the doc was never stamped, and lowercasing it here would be
    // re-classification through the back door.
    expect(stamped('PAID', 'none').state).toBeNull();
    expect(stamped(' open ', 'all').state).toBeNull();
    expect(stamped('sent', 'all').state).toBeNull();
    expect(stamped('', 'all').state).toBeNull();
  });

  it('answers editScope none for an unrecognized state even when the stored scope looks valid', () => {
    // A half-recognizable stamp is not a stamp. Offering money controls off the
    // scope of a doc whose state cannot be read would be a guess.
    expect(stamped('PAID', 'all')).toEqual({ state: null, editScope: 'none' });
  });

  it('answers editScope none when the stored scope itself is junk or absent', () => {
    expect(stamped('open', undefined).editScope).toBe('none');
    expect(stamped('open', 'everything').editScope).toBe('none');
    expect(stamped('open', 42).editScope).toBe('none');
  });

  it('never throws on a wholly malformed doc', () => {
    expect(() => stamped(42, { nested: true })).not.toThrow();
    expect(stamped(42, { nested: true })).toEqual({ state: null, editScope: 'none' });
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
  const row = {
    invoiceNumber: '1042',
    kinfolkName: 'The Whitfields',
    client: 'Dana Ruiz',
    total: 40,
  };

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
  /**
   * THE AMOUNT, matched as the text the row prints. Android's search does the
   * same, and it is what makes "the forty dollar one" a findable thing.
   */
  it('finds an invoice by the amount as it is written on the row', () => {
    expect(invoiceMatchesSearch(row, '$40.00')).toBe(true);
    expect(invoiceMatchesSearch(row, '40.00')).toBe(true);
    expect(invoiceMatchesSearch(row, '$40')).toBe(true);
  });
  it('does not match an amount this invoice is not worth', () => {
    expect(invoiceMatchesSearch(row, '$41')).toBe(false);
    expect(invoiceMatchesSearch(row, '400.00')).toBe(false);
  });
  it('matches a negative amount with its sign, the way the row shows it', () => {
    const credit = { ...row, total: -12.5 };
    expect(invoiceMatchesSearch(credit, '-$12.50')).toBe(true);
    expect(invoiceMatchesSearch(credit, '$12.50')).toBe(true);
  });
  it('reads a non-finite total as $0.00 rather than matching "nan"', () => {
    const broken = { ...row, total: Number.NaN };
    expect(invoiceMatchesSearch(broken, 'nan')).toBe(false);
    expect(invoiceMatchesSearch(broken, '$0.00')).toBe(true);
  });
  it('reads a missing total as $0.00 rather than throwing', () => {
    const missing = { invoiceNumber: '1042' } as unknown as InvoiceEntry;
    expect(invoiceMatchesSearch(missing, '$0.00')).toBe(true);
  });
});
