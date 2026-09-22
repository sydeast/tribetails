import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #906: `postInvoiceEvent` used to take `payload: z.record(...)` and merge it
 * onto the invoice verbatim, so an admin payload could mark an invoice paid
 * with no payment behind it and let `onInvoicesWrite` announce
 * `invoice.payment.applied` about money nobody paid.
 *
 * These tests pin the replacement: an explicit payload schema built from the
 * caller inventory (both real callers send `{ status: 'sent' }`), a refusal
 * for every money / lifecycle / owner-stamp key naming where it belongs, and
 * the delegation to `reviewAndSendDraftInvoice`, which already owns the draft
 * send's guards, stamp and audit.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  logEvent: vi.fn(),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  postInvoiceEventHandler,
  refusalForKey,
  payloadRefusals,
  REFUSED_MONEY_KEYS,
  REFUSED_LIFECYCLE_KEYS,
} from '../src/admin/postInvoiceEvent';
import { invoiceWriteNoticeKey } from '../src/triggers/onInvoicesWrite';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const DRAFT = { kinfolkId: '3', status: 'draft', invoiceNumber: 'INV-9', total: 40, amountDue: 40 };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.logEvent.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('recipient-uid');
  (writeAuditEntry as any).mockClear();
});

function call(payload: unknown, invoiceId = 'inv-7', familyId = '3'): CallableRequest<unknown> {
  return {
    data: { familyId, invoiceId, payload },
    auth: { uid: 'admin-uid', token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(invoice: Record<string, unknown> | null = DRAFT) {
  const ctx = buildDbMock({ docs: invoice ? { 'invoices/inv-7': invoice } : {} });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** The refusal message a handler call produced, or '' when it did not throw. */
async function refusalMessage(payload: unknown): Promise<string> {
  seed();
  try {
    await postInvoiceEventHandler(call(payload));
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('#906 refusal table: every money, lifecycle and owner-stamp key', () => {
  it.each(REFUSED_MONEY_KEYS)('refuses money key %s and names the money callables', (key) => {
    const r = refusalForKey(key, 1);
    expect(r).not.toBeNull();
    expect(r!.message).toContain('recordPayment');
    expect(r!.message).toContain('markInvoicePaid');
    expect(r!.message).toContain('updateInvoice');
  });

  it.each(REFUSED_LIFECYCLE_KEYS)('refuses lifecycle key %s and names where it belongs', (key) => {
    // `status` is refused for every value but the one draft send below.
    const r = refusalForKey(key, key === 'status' ? 'paid' : 'x');
    expect(r).not.toBeNull();
    expect(r!.use).toContain('updateInvoice');
  });

  it.each([
    'paymentAppliedNoticeOwner',
    'paymentAppliedNoticePending',
    'paymentAppliedNoticePendingAtMs',
    'paymentAppliedNoticeSentAt',
    'paymentAppliedNoticeSkippedReason',
    'paymentAppliedNoticeAttempts',
    'paymentAppliedNoticeLastError',
    'paymentAppliedNoticeClaim',
    'paymentAppliedNoticeOwnerAtMs',
  ])('refuses owner stamp %s: only the path that took the payment writes one', (key) => {
    const r = refusalForKey(key, 'markInvoicePaid:p1');
    expect(r).not.toBeNull();
    expect(r!.message).toContain('owner stamp');
    expect(r!.use).toBe('recordPayment | markInvoicePaid');
  });

  it('refuses a key nobody classified, pointing at updateInvoice', () => {
    const r = refusalForKey('internalNote', 'called them');
    expect(r!.use).toBe('updateInvoice');
    expect(r!.message).toContain('updateInvoice');
  });

  it('accepts the one pair every real caller sends, and nothing else called status', () => {
    expect(refusalForKey('status', 'sent')).toBeNull();
    for (const bad of ['paid', 'open', 'cancelled', 'credit', 'draft', '', 'SENT', 'Sent']) {
      expect(refusalForKey('status', bad)).not.toBeNull();
    }
  });

  it('reports EVERY refused key in one answer, not just the first', () => {
    const refusals = payloadRefusals({ status: 'paid', amountDue: 0, total: 40 });
    expect(refusals.map((r) => r.key)).toEqual(['status', 'amountDue', 'total']);
  });
});

describe('#906 the defect itself: the paid-with-no-payment payload is refused', () => {
  it('refuses { status: "paid", amountDue: 0 } and writes NOTHING', async () => {
    const ctx = seed();
    await expect(postInvoiceEventHandler(call({ status: 'paid', amountDue: 0 }))).rejects.toThrow(
      /markInvoicePaid/,
    );
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses a total rewrite, and the message sends the caller to updateInvoice', async () => {
    expect(await refusalMessage({ total: 55, amountDue: 55 })).toMatch(/updateInvoice/);
  });

  it('refuses a payload that would silence a real payment notice', async () => {
    expect(await refusalMessage({ paymentAppliedNoticeOwner: 'postInvoiceEvent:forged' })).toMatch(
      /owner stamp/,
    );
  });

  it('refuses an arbitrary merge, which is the whole shape the record type allowed', async () => {
    expect(await refusalMessage({ invoiceNumber: '1042', dueDate: '2026-10-01' })).toMatch(
      /no longer merges arbitrary invoice fields/,
    );
  });

  it('a refusal is logged with the keys, so the office can see what a client still sends', async () => {
    await refusalMessage({ status: 'paid', amountDue: 0 });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invoice.payload.refused',
        extra: expect.objectContaining({ keys: ['status', 'amountDue'] }),
      }),
    );
  });
});

describe('#906 the real callers: { status: "sent" } still works', () => {
  it('accepts the Android and desktop payload and sends the draft', async () => {
    const ctx = seed();
    const res = await postInvoiceEventHandler(call({ status: 'sent' }));
    expect(res).toEqual({ ok: true });
    const write = ctx.writes.find((w) => w.path === 'invoices/inv-7');
    expect(write?.data.status).toBe('open');
    expect(write?.data.invoiceStatus).toBe('open');
    expect(write?.data.sentBy).toBe('admin-uid');
  });

  it('routes through reviewAndSendDraftInvoice: its audit event, its notification', async () => {
    seed();
    await postInvoiceEventHandler(call({ status: 'sent' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_DRAFT_INVOICE_SENT' }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'recipient-uid' }),
    );
  });

  it('a REPEAT send is refused by the draft precondition and tells nobody twice', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv-7': DRAFT }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    await postInvoiceEventHandler(call({ status: 'sent' }));
    await expect(postInvoiceEventHandler(call({ status: 'sent' }))).rejects.toThrow(/not a draft/);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('an incomplete draft is refused by name rather than sent', async () => {
    seed({ kinfolkId: '3', status: 'draft', total: 0 });
    await expect(postInvoiceEventHandler(call({ status: 'sent' }))).rejects.toThrow(
      /missing: total, invoice number/,
    );
  });
});

describe('#906 preconditions this path never had', () => {
  it('no longer CREATES an invoice from a missing doc; it names createInvoice', async () => {
    const ctx = seed(null);
    await expect(postInvoiceEventHandler(call({ status: 'sent' }))).rejects.toThrow(/createInvoice/);
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('no longer reassigns an invoice to the caller’s household', async () => {
    // `kinfolkId: args.familyId` used to ride every merge, so a mismatched id
    // moved the bill to another household silently.
    const ctx = seed({ ...DRAFT, kinfolkId: 'other-household' });
    await expect(postInvoiceEventHandler(call({ status: 'sent' }))).rejects.toThrow(
      /belongs to household 'other-household'/,
    );
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects invalid args', async () => {
    seed();
    await expect(
      postInvoiceEventHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});

describe('#906 the trigger: no invoice.payment.applied can come from this path', () => {
  /** The doc as the delegated write leaves it, from the write the mock recorded. */
  async function sendAndRead(before: Record<string, unknown>) {
    const ctx = buildDbMock({ docs: { 'invoices/inv-7': before } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await postInvoiceEventHandler(call({ status: 'sent' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv-7')!;
    return { ...before, ...write.data } as Record<string, unknown>;
  }

  it('a normal draft send announces nothing about a payment', async () => {
    const before = { ...DRAFT };
    const after = await sendAndRead(before);
    expect(invoiceWriteNoticeKey(before as any, after as any)).toBeNull();
  });

  /**
   * FIXED BY #902, from the angle #906 found it. Sending a legacy draft used to
   * stamp it `paid` — `{ total, no amountDue }` classified paid because a
   * missing balance read as zero — so the office's own Send button marked an
   * owed bill settled, with no payment row anywhere and no way back
   * (`alreadySettledRefusal` then blocks every payment path and scope `none`
   * blocks the edit). The shared rule reads it as owing its total, so a sent
   * draft becomes an ordinary `open` bill. It still announces no payment,
   * because a draft send is not one.
   */
  it('#902: sending a legacy total-only draft stamps it open, not paid, and announces no payment', async () => {
    const before = { kinfolkId: '3', status: 'draft', invoiceNumber: 'INV-9', total: 40 };
    const after = await sendAndRead(before);
    expect(after.status).toBe('open');
    expect(after.editScope).toBe('all');
    expect(invoiceWriteNoticeKey(before as any, after as any)).toBeNull();
  });

  it('a long-overdue draft announces nothing from this trigger at all', async () => {
    // #871 moved `invoice.overdue` off this trigger and onto `invoiceOverdueCron`,
    // so `invoiceWriteNoticeKey` now answers only about a payment. A draft sent
    // past its due date is the office's to chase on the cron's schedule, and it
    // is certainly not a payment, so this write announces nothing.
    const before = { ...DRAFT, status: 'draft', dueDate: '2020-01-01' };
    const after = await sendAndRead(before);
    expect(invoiceWriteNoticeKey(before as any, after as any)).toBeNull();
  });

  it('the refused paid payload never reaches the trigger at all', async () => {
    const ctx = seed();
    await expect(postInvoiceEventHandler(call({ status: 'paid', amountDue: 0 }))).rejects.toThrow();
    // No write means no trigger event. This is the #906 fix stated as the
    // trigger sees it: the only doc change this path can make is draft -> open.
    expect(ctx.writes).toHaveLength(0);
  });
});
