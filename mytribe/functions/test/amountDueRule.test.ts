import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  amountDueCentsOf,
  amountDueDollarsOf,
  legacyOverpaidCentsOf,
  statedAmountDueCents,
  statesNoBalance,
} from '../src/lib/amountDueRule';
import {
  invoiceStateOf,
  invoiceEditRefusal,
  invoiceEditScope,
  paymentStandingOf,
} from '../src/lib/invoiceEditPolicy';
import { collectableForAutoApply } from '../src/triggers/onInvoiceAutoApply';
import { chaseRefusalOf } from '../src/lib/invoiceChase';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/**
 * #902. THE LEGACY SHAPE, and the rule that now decides what it owes.
 *
 * A migrated invoice carries a `total` and no `amountDue` at all. Two readers
 * used to disagree about it — the classifier called it settled, the auto-apply
 * trigger called it collectable — and a household could have their account
 * credit spent on a bill their portal showed as paid.
 *
 * This file pins the rule itself, and then walks EVERY server-side reader
 * through the same two documents. The per-reader sections are the point: the
 * defect was not that one reader was wrong, it was that they were different.
 */
const LEGACY_UNPAID = { status: 'sent', total: 40 };
const LEGACY_SETTLED_BY_ROWS = { status: 'sent', total: 40 };
/** What `paidCentsFromPayments` returns for a row set that covers the $40 bill. */
const ROWS_COVER = 4000;

describe('the rule: a stated balance is untouched, a missing one is derived', () => {
  it('reads a stated balance verbatim, in either field, including zero and negative', () => {
    expect(statedAmountDueCents({ amountDue: 40 })).toBe(4000);
    expect(statedAmountDueCents({ amountDue: 0 })).toBe(0);
    expect(statedAmountDueCents({ amountDue: -25 })).toBe(-2500);
    expect(statedAmountDueCents({ amountDueCents: 1234 })).toBe(1234);
    expect(statedAmountDueCents({ amountDueCents: 1234, amountDue: 99 })).toBe(1234);
  });

  it('treats an absent or non-finite balance as stating nothing', () => {
    expect(statedAmountDueCents({})).toBeNull();
    expect(statedAmountDueCents({ total: 40 })).toBeNull();
    expect(statedAmountDueCents({ amountDue: Number.NaN })).toBeNull();
    expect(statedAmountDueCents({ amountDue: Number.POSITIVE_INFINITY })).toBeNull();
    expect(statesNoBalance({ status: 'sent', total: 40 })).toBe(true);
    expect(statesNoBalance({ status: 'sent', total: 40, amountDue: 0 })).toBe(false);
  });

  it('NEVER RE-DERIVES A STATED ZERO: that is invoicePaymentRepair.ts’s to fix, not this rule’s', () => {
    // The pre-2026-07-25 partial-payment write put `amountDue: 0` on bills that
    // were only half collected. Re-deriving it here would silently re-open every
    // invoice that pass has already repaired, and would do it with no record.
    expect(amountDueCentsOf({ status: 'paid', total: 40, amountDue: 0 }, 2000)).toBe(0);
  });

  it('a missing balance with no rows owes its whole total', () => {
    expect(amountDueCentsOf(LEGACY_UNPAID, null)).toBe(4000);
    expect(amountDueCentsOf(LEGACY_UNPAID, 0)).toBe(4000);
    expect(amountDueDollarsOf(LEGACY_UNPAID, null)).toBe(40);
  });

  it('"no rows" and "rows summing to nothing" are one branch, or the pure readers fork again', () => {
    expect(amountDueCentsOf(LEGACY_UNPAID, null)).toBe(amountDueCentsOf(LEGACY_UNPAID, 0));
  });

  it('a missing balance with rows owes the remainder', () => {
    expect(amountDueCentsOf(LEGACY_UNPAID, 1500)).toBe(2500);
    expect(amountDueCentsOf(LEGACY_SETTLED_BY_ROWS, ROWS_COVER)).toBe(0);
  });

  it('a settled label with no balance owes nothing; every other label owes the total', () => {
    for (const status of ['paid', 'cancelled', 'credit', 'redeemed', 'PAID ']) {
      expect(amountDueCentsOf({ status, total: 40 }, null), status).toBe(0);
    }
    for (const status of ['sent', 'open', 'overdue', 'past_due', 'draft', 'quote', '', 'gibberish']) {
      expect(amountDueCentsOf({ status, total: 40 }, null), status).toBe(4000);
    }
    expect(amountDueCentsOf({ total: 40 }, null)).toBe(4000);
  });

  it('prefers totalCents over the dollar total, the one answer invoiceMath already gives', () => {
    expect(amountDueCentsOf({ status: 'sent', total: 40, totalCents: 1000 }, null)).toBe(1000);
  });

  it('NEVER DERIVES A NEGATIVE BALANCE: an overdraw clamps to zero and is reported instead', () => {
    // A negative amountDue is this codebase's credit signal, read that way by
    // three classifiers. A derivation must not mint a credit nobody issued, and
    // per the standing ruling there are no refunds: an overdraw belongs on the
    // household's account balance, moved there by an operator.
    expect(amountDueCentsOf(LEGACY_UNPAID, 6000)).toBe(0);
    expect(legacyOverpaidCentsOf(LEGACY_UNPAID, 6000)).toBe(2000);
    expect(legacyOverpaidCentsOf(LEGACY_UNPAID, ROWS_COVER)).toBe(0);
    expect(legacyOverpaidCentsOf({ status: 'paid', total: 40, amountDue: 0 }, 6000)).toBe(0);
    expect(amountDueCentsOf({ status: 'sent', total: -40 }, null)).toBe(0);
  });
});

/**
 * READER 1: the classifier (lib/invoiceEditPolicy.ts#invoiceStateOf). Everything
 * downstream of the state stamp reads its answer.
 */
describe('reader 1 — invoiceStateOf', () => {
  it('reads an unpaid legacy bill as OPEN (it read it as `paid` before #902)', () => {
    expect(invoiceStateOf(LEGACY_UNPAID)).toBe('open');
  });

  it('reads it as PAID once its own payment rows cover the total', () => {
    expect(invoiceStateOf(LEGACY_SETTLED_BY_ROWS, ROWS_COVER)).toBe('paid');
    expect(invoiceStateOf(LEGACY_UNPAID, 1500)).toBe('open');
  });

  it('says nothing new about an invoice that states its own balance', () => {
    expect(invoiceStateOf({ status: 'open', amountDue: 40, total: 40 })).toBe('open');
    expect(invoiceStateOf({ status: 'open', amountDue: 0, total: 40 })).toBe('paid');
    expect(invoiceStateOf({ amountDue: -25, total: -25 })).toBe('credit');
    expect(invoiceStateOf({})).toBe('zero');
  });

  it('and the state stamp stays a fixpoint on the shape, with rows and without', () => {
    const open = invoiceStateStampOf(LEGACY_UNPAID, 0);
    expect(open).toEqual({ status: 'open', editScope: 'all' });
    expect(invoiceStateStampOf({ ...LEGACY_UNPAID, ...open }, 0)).toEqual(open);
    const paid = invoiceStateStampOf(LEGACY_SETTLED_BY_ROWS, ROWS_COVER);
    expect(paid.status).toBe('paid');
    expect(invoiceStateStampOf({ ...LEGACY_SETTLED_BY_ROWS, ...paid }, ROWS_COVER)).toEqual(paid);
  });
});

/**
 * READER 2: the edit policy (lib/invoiceEditPolicy.ts#invoiceEditScope and
 * #invoiceEditRefusal). It used to freeze a migrated bill outright, so the
 * operator could not correct the invoice OR collect it.
 */
describe('reader 2 — invoiceEditPolicy', () => {
  const standing = paymentStandingOf(4000, 0);

  it('leaves an unpaid legacy bill FULLY EDITABLE (it was frozen `none` before #902)', () => {
    expect(invoiceEditScope(invoiceStateOf(LEGACY_UNPAID), standing, 'undecided')).toBe('all');
    expect(invoiceEditRefusal(invoiceStateOf(LEGACY_UNPAID), standing, true, 'undecided')).toBeNull();
  });

  it('freezes its money once the rows settle it, exactly as for any other paid bill', () => {
    const settled = paymentStandingOf(4000, ROWS_COVER);
    const state = invoiceStateOf(LEGACY_SETTLED_BY_ROWS, ROWS_COVER);
    expect(invoiceEditScope(state, settled, 'undecided')).toBe('none');
    expect(invoiceEditRefusal(state, settled, true, 'undecided')?.code).toBe('invoice_not_editable');
  });
});

/**
 * READER 3: the auto-apply trigger (triggers/onInvoiceAutoApply.ts). The other
 * half of the disagreement: it drew a household's account credit against a bill
 * reader 1 called paid.
 */
describe('reader 3 — collectableForAutoApply', () => {
  it('still looks at an unpaid legacy bill, and now for the same reason reader 1 calls it open', () => {
    expect(collectableForAutoApply({ kinfolkId: 'fam1', ...LEGACY_UNPAID })).toBe(true);
    expect(invoiceStateOf(LEGACY_UNPAID)).toBe('open');
  });

  it('CHANGED BY #902: an invoice stating neither a balance nor a total is not collectable', () => {
    expect(collectableForAutoApply({ kinfolkId: 'fam1', status: 'sent' })).toBe(false);
  });
});

/**
 * READER 4: the chase gate (lib/invoiceChase.ts), #871's rule for reminders and
 * overdue notices.
 */
describe('reader 4 — chaseRefusalOf', () => {
  it('chases an unpaid legacy bill, which #871 refused as `legacy_balance_unproven`', () => {
    expect(chaseRefusalOf(LEGACY_UNPAID, null)).toBeNull();
  });

  it('refuses one its rows have settled, as `not_open` rather than a special case', () => {
    expect(chaseRefusalOf(LEGACY_SETTLED_BY_ROWS, { rows: 1, paidCents: ROWS_COVER })).toEqual({
      reason: 'not_open',
      state: 'paid',
    });
  });
});

/**
 * READER 5: the portal response builder (portal/getMyInvoices.ts), which is what
 * the web portal and the Android portal render. The clients do not classify —
 * the rule runs here, once, on the raw document, where a missing field can still
 * be told from a zero one. The two client screens are covered by
 * `mytribe/web/src/screens/InvoiceDetail.legacyAmountDue.test.tsx` and
 * `mytribe/src/commonTest/.../LegacyAmountDueDisplayTest.kt`, which assert that
 * the DTO shape proved here renders as an owed bill.
 */
describe('reader 5 — getMyInvoicesHandler, the portal DTO', () => {
  async function dtoFor(data: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: { invoices: [{ id: 'inv-legacy', data: { kinfolkId: '3', ...data } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    return [...res.open, ...res.paid, ...res.credits][0]!;
  }

  it('ships the derived balance, so the household sees the bill they owe instead of $0.00', async () => {
    const dto = await dtoFor(LEGACY_UNPAID);
    expect(dto.amountDue).toBe(40);
    expect(dto.total).toBe(40);
    expect(dto.isPaid).toBe(false);
    expect(dto.partiallyPaid).toBe(false);
  });

  it('and offers a way to pay it: `payMethods` is resolved against a real balance', async () => {
    const dto = await dtoFor(LEGACY_UNPAID);
    expect(dto.payMethods.length).toBeGreaterThan(0);
  });

  it('settles it from the doc’s own paidCents when the settlement pass wrote one', async () => {
    const dto = await dtoFor({ ...LEGACY_SETTLED_BY_ROWS, paidCents: ROWS_COVER });
    expect(dto.amountDue).toBe(0);
    expect(dto.payMethods).toEqual([]);
  });

  it('reports a part payment honestly rather than as a settled bill', async () => {
    const dto = await dtoFor({ ...LEGACY_UNPAID, status: 'open', paidCents: 1500 });
    expect(dto.amountDue).toBe(25);
    expect(dto.partiallyPaid).toBe(true);
  });

  it('leaves an invoice that states its own balance exactly as it was', async () => {
    const dto = await dtoFor({ status: 'open', amountDue: 50, total: 100, paidCents: 5000 });
    expect(dto.amountDue).toBe(50);
    expect(dto.total).toBe(100);
  });
});
