import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import {
  INVOICE_STATES,
  INVOICES_QUERY,
  INVOICES_PAGE_SIZE,
  invoiceMatchesSearch,
  invoicesPageQuery,
  invoiceDispute,
  invoiceDisputeDeadline,
  invoiceDisputeReasonGloss,
  invoiceDisputeTimeLeft,
  invoiceStamp,
  invoiceDayMs,
  invoiceWithinWindow,
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
 * THE WINDOW, RUN AGAINST DOCUMENTS INSTEAD OF INSPECTED AS AN ARRAY.
 *
 * Every assertion above this one describes the SHAPE of the filter tuple, and
 * every one of them passed while "Last 30 days" listed invoices six months old.
 * They could not have caught it: `['date','>=','2026-07-05']` is the correct
 * tuple, and the bug lives entirely in what Firestore does with it.
 *
 * So this block applies the predicate. `firestoreStringGte` is not a model of
 * Firestore, it IS the comparison Firestore performs on two string values:
 * UTF-8 byte order, which for these inputs is `<` on a JS string. Running
 * it over a real stored value is what makes the failure visible.
 */
describe('the last-30-days window, applied to documents', () => {
  /** What `where('date','>=',bound)` admits: a byte-order comparison, nothing more. */
  const firestoreStringGte = (stored: string, bound: string): boolean => stored >= bound;

  /** A cutoff 30 days before 2026-08-04, the shape `Invoices.tsx` computes. */
  const THIRTY_DAYS_AGO = '2026-07-05';

  it('THE BUG: the server predicate admits a six-month-old letter-leading date', () => {
    // 'F' is 0x46. Every digit is 0x30-0x39. The comparison is decided on the
    // first character and never reaches either year, so this invoice (dated
    // nearly six months before the cutoff) satisfies it, and would satisfy any
    // ISO cutoff that could ever be written.
    expect(firestoreStringGte('Feb 12, 2026', THIRTY_DAYS_AGO)).toBe(true);
    expect(firestoreStringGte('Feb 12, 2026', '2099-12-31')).toBe(true);

    // And it is worse than a stray row: the same ordering puts it ABOVE every
    // real date under `orderBy('date','desc')`, so it arrives at the TOP of the
    // first page.
    expect(['2026-08-01', 'Feb 12, 2026', '2026-07-30'].sort().reverse()[0]).toBe('Feb 12, 2026');
  });

  it('THE FIX: a document dated "Feb 12, 2026" does not satisfy a last-30-days window', () => {
    const row = { date: 'Feb 12, 2026' };
    expect(invoiceWithinWindow(row, THIRTY_DAYS_AGO)).toBe(false);
  });

  it('drops every legacy free-text spelling the collection is known to hold', () => {
    // These are the exact fixtures this repo carries for the field:
    // normalizeInvoice's own row above, functions/test/invoicePdf.test.ts, and
    // functions/test/enrichTemplateData.test.ts.
    for (const stored of ['August 11, 2025', 'Sep 1, 2025', 'Jul 1, 2026', 'Net 14', '']) {
      expect(invoiceWithinWindow({ date: stored }, THIRTY_DAYS_AGO)).toBe(false);
    }
  });

  it('keeps the real dates inside the window and refuses the ones outside it', () => {
    expect(invoiceWithinWindow({ date: '2026-07-30' }, THIRTY_DAYS_AGO)).toBe(true);
    // The bound day itself is inside: "last 30 days" includes its first day.
    expect(invoiceWithinWindow({ date: THIRTY_DAYS_AGO }, THIRTY_DAYS_AGO)).toBe(true);
    expect(invoiceWithinWindow({ date: '2026-07-04' }, THIRTY_DAYS_AGO)).toBe(false);
    expect(invoiceWithinWindow({ date: '2025-12-31' }, THIRTY_DAYS_AGO)).toBe(false);
  });

  it('narrows nothing under "All (archive)", including the undated rows', () => {
    for (const stored of ['', 'Net 14', '2026-07-30', 'Feb 12, 2026']) {
      expect(invoiceWithinWindow({ date: stored }, null)).toBe(true);
    }
  });

  it('does not empty the screen when the BOUND itself is unreadable', () => {
    // A malformed bound is a caller bug. Excluding every row would be the silent
    // blank screen this whole guard exists to prevent, so it narrows nothing.
    expect(invoiceWithinWindow({ date: '2026-07-30' }, 'last month')).toBe(true);
  });
});

describe('invoiceDayMs: the stored day as an instant', () => {
  it('reads a real day as its UTC midnight', () => {
    expect(invoiceDayMs('2026-07-05')).toBe(Date.parse('2026-07-05T00:00:00.000Z'));
  });

  it('refuses a day that does not exist, rather than relabelling it', () => {
    // Date.parse resolves this to March 2. A window that silently moves an
    // invoice to another month is the same class of lie as one that admits the
    // wrong rows, so it is refused instead.
    expect(invoiceDayMs('2026-02-30')).toBeNull();
    expect(invoiceDayMs('2026-13-01')).toBeNull();
  });

  it('refuses everything that is not exactly a day', () => {
    for (const raw of ['', 'Net 14', 'Feb 12, 2026', '2026-7-5', '2026-07-05T12:00:00Z']) {
      expect(invoiceDayMs(raw)).toBeNull();
    }
  });

  it('orders as the calendar does, which is the whole point', () => {
    const feb = invoiceDayMs('2026-02-12');
    const jul = invoiceDayMs('2026-07-05');
    expect(feb).not.toBeNull();
    expect(jul).not.toBeNull();
    expect((feb as number) < (jul as number)).toBe(true);
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
describe('invoiceDispute', () => {
  const clean: Pick<
    InvoiceEntry,
    'disputeStatus' | 'disputeFundsState' | 'disputeAmountCents' | 'disputeId'
  > = {};
  it('is null on an invoice that has never been disputed', () => {
    expect(invoiceDispute(clean)).toBeNull();
  });
  it('reads an open chargeback as open, keeping the raw Stripe status', () => {
    const d = invoiceDispute({ disputeStatus: 'needs_response', disputeId: 'dp_1', disputeAmountCents: 4000 });
    expect(d).not.toBeNull();
    expect(d!.open).toBe(true);
    expect(d!.status).toBe('needs_response');
    expect(d!.amountCents).toBe(4000);
  });
  /**
   * THE OPERATOR RULE. Nothing ever clears `disputeStatus` (the contest did
   * happen), so a won dispute stays on the doc forever. It is history, not an
   * open problem, and the screens key their alarm off THIS flag.
   */
  it('reads `won` as closed history, not as an open problem', () => {
    expect(invoiceDispute({ disputeStatus: 'won', disputeId: 'dp_1' })!.open).toBe(false);
  });
  it('reads `lost` and `under_review` as open: both still want the operator', () => {
    expect(invoiceDispute({ disputeStatus: 'lost' })!.open).toBe(true);
    expect(invoiceDispute({ disputeStatus: 'under_review' })!.open).toBe(true);
  });
  /**
   * Fail loud, never guess. `won` is the ONLY value proven to be a closed,
   * good outcome; a status this build does not know about is shown raw and
   * treated as wanting attention rather than quietly downgraded.
   */
  it('treats an unrecognized status as open and keeps it readable', () => {
    const d = invoiceDispute({ disputeStatus: 'warning_needs_response' })!;
    expect(d.open).toBe(true);
    expect(d.status).toBe('warning_needs_response');
  });
  /**
   * The funds lane writes `disputeFundsState` WITHOUT `disputeStatus` (see
   * stripeDispute.ts: "the balance moving says nothing about where the contest
   * stands"), and Stripe guarantees no ordering between the lanes. So an
   * invoice really can hold withdrawn funds and no status at all.
   */
  it('shows a dispute whose funds moved before any status landed', () => {
    const d = invoiceDispute({ disputeFundsState: 'withdrawn', disputeId: 'dp_1' })!;
    expect(d.status).toBeNull();
    expect(d.fundsState).toBe('withdrawn');
    expect(d.open).toBe(true);
  });
  it('shows a dispute known only by its id', () => {
    expect(invoiceDispute({ disputeId: 'dp_1' })!.open).toBe(true);
  });
  it('keeps a won dispute closed even while the funds are still out', () => {
    const d = invoiceDispute({ disputeStatus: 'won', disputeFundsState: 'withdrawn' })!;
    expect(d.open).toBe(false);
    expect(d.fundsState).toBe('withdrawn');
  });
  /** An unrecognized funds state is not a state. Absent, never invented. */
  it('drops a funds state outside the two the webhook writes', () => {
    expect(invoiceDispute({ disputeStatus: 'lost', disputeFundsState: 'pending' as never })!.fundsState).toBeNull();
  });
  /**
   * Money rule: the disputed amount is null when the event did not carry one.
   * A 0 here would claim the bank pulled nothing back.
   */
  it('reports an absent or non-numeric disputed amount as null, never as zero', () => {
    expect(invoiceDispute({ disputeStatus: 'lost' })!.amountCents).toBeNull();
    expect(invoiceDispute({ disputeStatus: 'lost', disputeAmountCents: null })!.amountCents).toBeNull();
    expect(
      invoiceDispute({ disputeStatus: 'lost', disputeAmountCents: Number.NaN })!.amountCents,
    ).toBeNull();
  });
  it('ignores a blank status string rather than treating it as a dispute', () => {
    expect(invoiceDispute({ disputeStatus: '' })).toBeNull();
    expect(invoiceDispute({ disputeStatus: null })).toBeNull();
  });
  /**
   * THE ZERO TRAP, on the client side of the wire.
   *
   * `stripeDispute.ts#evidenceDueByMsOf` already maps Stripe's deliberate
   * `due_by: 0` ("the issuing bank allows no response at all", pinned SDK
   * Disputes.d.ts:210) to null, so the backend never writes one. This is the
   * second lock, because `InvoiceEntry` is a cast over raw document data rather
   * than a validation of it: a 0 that ever reached this doc must come out null,
   * never as midnight on 1 January 1970 and a chargeback fifty-five years
   * overdue on a countdown whose only job is to be right about time.
   */
  it('reads a stored deadline of 0 as no deadline, never as the epoch', () => {
    const d = invoiceDispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: 0 })!;
    expect(d.evidenceDueByMs).toBeNull();
  });
  it('reads an absent, null or non-finite deadline as no deadline', () => {
    expect(invoiceDispute({ disputeStatus: 'needs_response' })!.evidenceDueByMs).toBeNull();
    expect(
      invoiceDispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: null })!.evidenceDueByMs,
    ).toBeNull();
    expect(
      invoiceDispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: Number.NaN })!
        .evidenceDueByMs,
    ).toBeNull();
  });
  it('carries a real deadline through in epoch milliseconds, untouched', () => {
    const ms = Date.UTC(2026, 7, 20, 17, 0, 0);
    expect(
      invoiceDispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: ms })!.evidenceDueByMs,
    ).toBe(ms);
  });
  /**
   * The reason is a raw snake_case Stripe token and it travels verbatim. The
   * SDK types `reason` as a plain `string` (Disputes.d.ts:89), not a union, and
   * the docstring's category list is prose; Stripe adds categories on its own
   * schedule and one this build has never seen must reach the operator as sent.
   */
  it('carries the raw Stripe reason token through without normalizing it', () => {
    expect(
      invoiceDispute({ disputeStatus: 'needs_response', disputeReason: 'product_not_received' })!.reason,
    ).toBe('product_not_received');
    expect(
      invoiceDispute({ disputeStatus: 'needs_response', disputeReason: 'a_category_from_2027' })!.reason,
    ).toBe('a_category_from_2027');
  });
  it('reads an absent or blank reason as no reason', () => {
    expect(invoiceDispute({ disputeStatus: 'needs_response' })!.reason).toBeNull();
    expect(invoiceDispute({ disputeStatus: 'needs_response', disputeReason: '' })!.reason).toBeNull();
    expect(invoiceDispute({ disputeStatus: 'needs_response', disputeReason: null })!.reason).toBeNull();
  });
  /**
   * PRESENCE IS UNCHANGED, and deliberately so. The webhook writes the reason
   * and the deadline on the same lifecycle write as `disputeStatus`, so a doc
   * carrying one of them and none of status, funds state or dispute id is a
   * corrupt document rather than a dispute. Widening presence here would change
   * the contract the cases above pin.
   */
  it('does not turn a reason or a deadline alone into a dispute', () => {
    expect(invoiceDispute({ disputeReason: 'fraudulent' })).toBeNull();
    expect(invoiceDispute({ disputeEvidenceDueByMs: 1_786_000_000_000 })).toBeNull();
  });
});
/**
 * THE COUNTDOWN, and the three ways it must refuse to count.
 *
 * A chargeback you fail to answer by the deadline is lost by default, which is
 * why the date is on the screen at all. That also makes it the most dangerous
 * thing on the screen to get wrong, so every branch here is a refusal to state
 * something the document does not support.
 */
describe('invoiceDisputeDeadline', () => {
  const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
  const DAY = 86_400_000;
  const dispute = (over: Partial<Pick<InvoiceEntry, 'disputeStatus' | 'disputeEvidenceDueByMs'>>) =>
    invoiceDispute({ disputeId: 'dp_1', ...over })!;

  it('counts down an open deadline the operator can still meet', () => {
    const d = invoiceDisputeDeadline(
      dispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: NOW + 3 * DAY }),
      NOW,
    );
    expect(d.state).toBe('due');
    expect(d.state === 'due' && d.dueByMs).toBe(NOW + 3 * DAY);
    expect(d.state === 'due' && d.msRemaining).toBe(3 * DAY);
  });
  /**
   * A DEADLINE IN THE PAST IS ITS OWN STATE. It is not a negative countdown and
   * it is not a verdict: `disputeStatus` is a webhook mirror, so it can still
   * read `needs_response` after Stripe has closed the window. The screen says
   * the window shut and sends the operator to Stripe rather than guessing which.
   */
  it('reports a deadline already gone as passed, never as a negative countdown', () => {
    const d = invoiceDisputeDeadline(
      dispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: NOW - 2 * DAY }),
      NOW,
    );
    expect(d.state).toBe('passed');
    expect(d.state === 'passed' && d.dueByMs).toBe(NOW - 2 * DAY);
    expect(d).not.toHaveProperty('msRemaining');
  });
  it('reads the exact instant of the deadline as passed rather than as zero left', () => {
    expect(
      invoiceDisputeDeadline(
        dispute({ disputeStatus: 'needs_response', disputeEvidenceDueByMs: NOW }),
        NOW,
      ).state,
    ).toBe('passed');
  });
  /**
   * NULL IS NEITHER ZERO NOR AN ERROR. Stripe sends `due_by: 0` on purpose to
   * mean the issuing bank allows NO response at all, and the webhook maps that
   * and a genuinely absent value both to null. Neither is a date, so there is
   * nothing to count down to — and the banner still renders.
   */
  it('says a needed response has no stated deadline rather than inventing one', () => {
    expect(invoiceDisputeDeadline(dispute({ disputeStatus: 'needs_response' }), NOW).state).toBe(
      'unstated',
    );
  });
  /**
   * THE ONE THE OPERATOR ASKED FOR, at the pure-function level. A won dispute
   * keeps its deadline on the document forever, because nothing ever clears any
   * of these fields. Counting down to it would send the operator to fight a
   * contest that is already over.
   */
  it('shows no countdown for a WON dispute, deadline on the document or not', () => {
    expect(
      invoiceDisputeDeadline(
        dispute({ disputeStatus: 'won', disputeEvidenceDueByMs: NOW + 5 * DAY }),
        NOW,
      ).state,
    ).toBe('none');
  });
  /**
   * `lost` is still open per #309 — where contested money ends up is the
   * operator's call — but it is not answerable, so it gets the alarm without a
   * countdown. Same for `under_review`, where the evidence is already in.
   */
  it('shows no countdown for a settled or in-review dispute that still wants a human', () => {
    for (const status of ['lost', 'under_review', 'prevented', 'warning_closed']) {
      expect(
        invoiceDisputeDeadline(
          dispute({ disputeStatus: status, disputeEvidenceDueByMs: NOW + 5 * DAY }),
          NOW,
        ).state,
      ).toBe('none');
    }
  });
  /**
   * The gate is an exact match on the one status Stripe defines as answerable.
   * `warning_needs_response` is the known candidate for widening it and is
   * deliberately left out: an inquiry is not a chargeback, and adding it is an
   * operator ruling rather than this change's to make.
   */
  it('does not count down a status it cannot prove is answerable', () => {
    expect(
      invoiceDisputeDeadline(
        dispute({ disputeStatus: 'warning_needs_response', disputeEvidenceDueByMs: NOW + DAY }),
        NOW,
      ).state,
    ).toBe('none');
    expect(
      invoiceDisputeDeadline(
        dispute({ disputeStatus: 'a_status_from_2027', disputeEvidenceDueByMs: NOW + DAY }),
        NOW,
      ).state,
    ).toBe('none');
  });
  /** The funds lane can land first, leaving moved money and no status to gate on. */
  it('shows no countdown when no status has arrived at all', () => {
    expect(invoiceDisputeDeadline(dispute({ disputeStatus: null }), NOW).state).toBe('none');
  });
});
/**
 * How long is left, in words. A duration and never a calendar computation: the
 * arithmetic is on elapsed milliseconds, so no timezone or daylight-saving
 * boundary can move the answer.
 */
describe('invoiceDisputeTimeLeft', () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  it('counts whole days down, rounding toward the operator having less time', () => {
    expect(invoiceDisputeTimeLeft(6 * DAY)).toBe('6 days left');
    expect(invoiceDisputeTimeLeft(2 * DAY - 1)).toBe('1 day left');
    expect(invoiceDisputeTimeLeft(DAY)).toBe('1 day left');
  });
  it('drops to hours inside the last day', () => {
    expect(invoiceDisputeTimeLeft(DAY - 1)).toBe('23 hours left');
    expect(invoiceDisputeTimeLeft(HOUR)).toBe('1 hour left');
  });
  it('says less than an hour rather than counting minutes at the wire', () => {
    expect(invoiceDisputeTimeLeft(HOUR - 1)).toBe('less than an hour left');
    expect(invoiceDisputeTimeLeft(1)).toBe('less than an hour left');
  });
});
/**
 * PLAIN ENGLISH WHERE WE HAVE IT, THE RAW TOKEN WHERE WE DO NOT.
 *
 * `reason` is a plain `string` in the pinned SDK, not a union, and Stripe adds
 * categories without asking. The gloss is a courtesy over a token that is always
 * shown; a token with no gloss renders alone rather than as "Unknown", which
 * would be this build's ignorance dressed up as Stripe's answer.
 */
describe('invoiceDisputeReasonGloss', () => {
  it('glosses every reason the pinned SDK docstring lists', () => {
    for (const reason of [
      'bank_cannot_process',
      'check_returned',
      'credit_not_processed',
      'customer_initiated',
      'debit_not_authorized',
      'duplicate',
      'fraudulent',
      'general',
      'incorrect_account_details',
      'insufficient_funds',
      'noncompliant',
      'product_not_received',
      'product_unacceptable',
      'subscription_canceled',
      'unrecognized',
    ]) {
      expect(invoiceDisputeReasonGloss(reason), reason).toBeTypeOf('string');
    }
  });
  it('returns null for a category Stripe has not shipped to this build', () => {
    expect(invoiceDisputeReasonGloss('a_category_from_2027')).toBeNull();
    expect(invoiceDisputeReasonGloss('')).toBeNull();
  });
  /**
   * The won banner is pinned by InvoiceDetail.test.tsx not to contain the words
   * "respond", "deadline" or "evidence", and the reason renders on that banner
   * too. This keeps the gloss table honest about that rather than leaving a
   * future category to break a test three files away.
   */
  it('never uses the vocabulary the closed-history banner is forbidden', () => {
    for (const reason of ['fraudulent', 'product_not_received', 'general', 'unrecognized']) {
      expect(invoiceDisputeReasonGloss(reason)!).not.toMatch(/respond|deadline|evidence/i);
    }
  });
});
