import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #2090: archiving is only tidying; writing off a balance is its own owner-only
 * action. These run the real handlers against the shared Firestore mock, in
 * `writeThrough` mode where a test needs one handler to see what another wrote.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), enqueueNotification: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueueNotification,
  enqueueNotificationDetailed: mocks.enqueueNotification,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => ({ __increment: n }), delete: () => undefined },
  };
});

import { archiveInvoiceHandler, writeOffInvoiceHandler } from '../src/admin/archiveInvoice';
import { markInvoicePaidHandler, refusedLifecycle } from '../src/admin/markInvoicePaid';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { SERVER_ONLY_AUDIT_EVENTS, AUDIT_EVENTS } from '../src/lib/auditEvents';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import { chaseRefusalOf } from '../src/lib/invoiceChase';
import { invoiceStateOf } from '../src/lib/invoiceEditPolicy';
import { openBalanceCentsOf, statusFromStamp } from '../src/portal/getMyInvoices';
import { collectableForAutoApply } from '../src/lib/invoiceCollectable';
import { creditInvoiceRefusal } from '../src/lib/accountCredit';
import { planApply } from '../src/lib/paymentApply';
import { repairPlanFor } from '../src/lib/invoicePaymentRepair';
import { duplicateCheckoutReason } from '../src/lib/invoiceCheckoutDedupe';
import { sessionsToClose } from '../src/lib/checkoutSessionSweep';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueueNotification.mockReset().mockResolvedValue([]);
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'owner1', token: Record<string, unknown> = { admin: true }): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const OPEN = {
  kinfolkId: 'fam1',
  invoiceNumber: '1027',
  status: 'open',
  total: 9,
  totalCents: 900,
  amountDue: 9,
  amountDueCents: 900,
};

function seed(invoice: Record<string, unknown> | null, payments: Array<Record<string, unknown>> = [], writeThrough = false) {
  return buildDbMock({
    writeThrough,
    docs: { 'invoices/inv1': invoice },
    queryDocs: { 'invoices/inv1/payments': payments.map((data, i) => ({ id: `p${i}`, data })) },
  });
}

const invoiceWrite = (ctx: ReturnType<typeof buildDbMock>) => ctx.writes.find((w) => w.path === 'invoices/inv1');
const entryWrite = (ctx: ReturnType<typeof buildDbMock>) => ctx.writes.find((w) => w.path.startsWith('invoices/inv1/writeOffs/'));

describe('writeOffInvoice: the happy path', () => {
  it('writes its own ledger entry and stamps the invoice written off with nothing owed', async () => {
    const ctx = seed(OPEN);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
    expect(res).toMatchObject({ ok: true, invoiceId: 'inv1', writtenOffCents: 900 });

    const entry = entryWrite(ctx)!;
    expect(entry.path).toBe(`invoices/inv1/writeOffs/${res.writeOffId}`);
    expect(entry.data).toMatchObject({ amountCents: 900, paidCents: 0, totalCents: 900, writtenOffBy: 'owner1', invoiceNumber: '1027' });

    expect(invoiceWrite(ctx)!.data).toMatchObject({
      status: 'written_off',
      editScope: 'none',
      amountDue: 0,
      amountDueCents: 0,
      writtenOffCents: 900,
      writtenOffBy: 'owner1',
      writeOffId: res.writeOffId,
    });
  });

  it('is not a payment and not credit: nothing lands in payments, and no balance moves', async () => {
    const ctx = seed(OPEN);
    mocks.dbFn.mockReturnValue(ctx.db);
    await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
    expect(ctx.writes.filter((w) => w.path.includes('/payments/') || w.path.startsWith('payments/'))).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toEqual([]);
    const paths = ctx.writes.map((w) => w.path);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(expect.arrayContaining(['invoices/inv1', expect.stringMatching(/^invoices\/inv1\/writeOffs\//)]));
  });

  it('writes off only what the payments left on a part-paid invoice', async () => {
    const ctx = seed(
      { ...OPEN, total: 40, totalCents: 4000, amountDue: 15, amountDueCents: 1500, paidCents: 2500 },
      [{ amountCents: 2500 }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 1500 }));
    expect(res.writtenOffCents).toBe(1500);
    expect(entryWrite(ctx)!.data).toMatchObject({ amountCents: 1500, paidCents: 2500, totalCents: 4000 });
  });

  it('logs a server-only audit line naming the invoice number and the amount, and sends the household nothing', async () => {
    const ctx = seed(OPEN);
    mocks.dbFn.mockReturnValue(ctx.db);
    await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
    expect(SERVER_ONLY_AUDIT_EVENTS.has(AUDIT_EVENTS.BILLING_INVOICE_WRITTEN_OFF)).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_INVOICE_WRITTEN_OFF',
        familyId: 'fam1',
        description: 'Invoice 1027 balance of $9.00 written off',
        payload: expect.objectContaining({ writtenOffCents: 900 }),
      }),
    );
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('writeOffInvoice: refusals, every one before any write', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['a draft', { ...OPEN, status: 'draft' }, 'write_off_draft'],
    ['a quote', { ...OPEN, status: 'quote' }, 'write_off_quote'],
    ['a paid invoice', { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0 }, 'write_off_paid'],
    ['a $0 invoice', { ...OPEN, total: 0, totalCents: 0, amountDue: 0, amountDueCents: 0 }, 'write_off_paid'],
    ['an archived invoice', { ...OPEN, archivedAt: 'ts' }, 'invoice_archived'],
    ['a cancelled invoice', { ...OPEN, status: 'cancelled' }, 'write_off_cancelled'],
    ['a credit', { ...OPEN, status: 'credit', amountDue: -9, amountDueCents: -900 }, 'write_off_credit'],
    [
      'an invoice already written off',
      { ...OPEN, status: 'written_off', amountDue: 0, amountDueCents: 0, writtenOffAt: 'ts' },
      'write_off_already',
    ],
  ];
  it.each(cases)('refuses %s', async (_label, doc, code) => {
    const ctx = seed(doc);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code },
    });
    expect(ctx.writes).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses when the balance is not the amount the confirm showed, and names the new figure', async () => {
    const ctx = seed({ ...OPEN, amountDue: 4, amountDueCents: 400 });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 })).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: 'write_off_amount_changed', owedCents: 400 } });
    expect(err.message).toBe('The balance on this invoice is now $4.00, not $9.00. Check it and try again.');
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a missing invoice, bad arguments and a signed-out caller', async () => {
    const ctx = seed(null);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }))).rejects.toMatchObject({ code: 'not-found' });
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 0 }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 9.5 }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('is owner-only: an Auntie is refused by the staff gate', async () => {
    expect(AUNTIE_ALLOWED_CALLABLES.has('writeOffInvoice')).toBe(false);
    const ctx = seed(OPEN);
    mocks.dbFn.mockReturnValue(ctx.db);
    const wrapped = wrapAdminCallable('writeOffInvoice', writeOffInvoiceHandler);
    await expect(
      wrapped(req({ invoiceId: 'inv1', amountCents: 900 }, 'auntie-1', { staffRole: 'auntie' }) as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });
});

describe('#2090: archive refuses money owed; write off, then archive', () => {
  it('archive is refused on the owed invoice, the write-off goes through, and then archive is allowed', async () => {
    const ctx = seed(OPEN, [], true);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      details: { code: 'invoice_still_owing' },
    });
    await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
    await expect(archiveInvoiceHandler(req({ invoiceId: 'inv1' }))).resolves.toMatchObject({ ok: true });

    const doc = (await ctx.db.doc('invoices/inv1').get()).data();
    expect(doc).toMatchObject({ status: 'written_off', amountDueCents: 0, writtenOffCents: 900, archivedAt: '__TS__' });
  });
});

describe('#2090: one winner when a payment lands during the write-off', () => {
  it('a payment that read the invoice before the write-off committed is refused in its own transaction', async () => {
    // markInvoicePaid decides on a read taken OUTSIDE its transaction. The
    // write-off commits between that read and the transaction, which is the
    // exact window that used to overwrite it with the old balance.
    const ctx = seed(OPEN, [], true);
    mocks.dbFn.mockReturnValue(ctx.db);
    const realTx = ctx.db.runTransaction;
    let interleaved = false;
    ctx.db.runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (!interleaved) {
        interleaved = true;
        ctx.db.runTransaction = realTx;
        await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
      }
      return realTx(fn);
    });

    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 9, idempotencyKey: 'ipay_1763000000000_abc123' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_written_off' } });

    expect(interleaved).toBe(true);
    const doc = (await ctx.db.doc('invoices/inv1').get()).data();
    expect(doc).toMatchObject({ status: 'written_off', amountDueCents: 0, writtenOffCents: 900 });
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/payments/'))).toEqual([]);
  });

  it('a payment that committed first moves the balance, so the write-off of the old figure is refused', async () => {
    const ctx = seed({ ...OPEN, total: 40, totalCents: 4000, amountDue: 40, amountDueCents: 4000 }, [], true);
    mocks.dbFn.mockReturnValue(ctx.db);

    // The owner opened the confirm at $40.00; a $25 payment lands first.
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 25, idempotencyKey: 'ipay_1763000000001_def456' }));
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 4000 }))).rejects.toMatchObject({
      details: { code: 'write_off_amount_changed', owedCents: 1500 },
    });
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/writeOffs/'))).toEqual([]);

    // Confirmed again at the figure she is now shown, it writes off the rest only.
    const res = await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 1500 }));
    expect(res.writtenOffCents).toBe(1500);
    expect(entryWrite(ctx)!.data).toMatchObject({ amountCents: 1500, paidCents: 2500 });
  });

  it('a payment after the write-off is refused, and so is a second write-off', async () => {
    const ctx = seed(OPEN, [], true);
    mocks.dbFn.mockReturnValue(ctx.db);
    await writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }));
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 9, idempotencyKey: 'ipay_1763000000002_ghi789' })),
    ).rejects.toMatchObject({ details: { code: 'invoice_written_off' } });
    await expect(writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 900 }))).rejects.toMatchObject({
      details: { code: 'write_off_already' },
    });
  });
});

const WRITTEN_OFF = {
  ...OPEN,
  status: 'written_off',
  editScope: 'none',
  amountDue: 0,
  amountDueCents: 0,
  writtenOffCents: 900,
  writtenOffAt: 'ts',
  dueDate: '2026-11-01',
};

describe('#2090: nothing asks the household for a written-off balance', () => {
  it('classifies as written_off, never paid and never open', () => {
    expect(invoiceStateOf(WRITTEN_OFF)).toBe('written_off');
    expect(invoiceStateOf(WRITTEN_OFF, 0)).toBe('written_off');
  });

  it('reminders and overdue notices skip it (the rule both crons and the Send reminder press use)', () => {
    expect(chaseRefusalOf(WRITTEN_OFF, { paidCents: 0 } as never)).toMatchObject({ reason: 'not_open', state: 'written_off' });
    expect(chaseRefusalOf(OPEN, { paidCents: 0 } as never)).toBeNull();
  });

  it('the portal and Home count nothing owed on it, and ship it under its own state', () => {
    expect(statusFromStamp(WRITTEN_OFF)).toEqual({ status: 'written_off', stamped: true });
    expect(openBalanceCentsOf([OPEN, WRITTEN_OFF])).toBe(900);
    expect(openBalanceCentsOf([WRITTEN_OFF])).toBe(0);
  });


  it('auto-apply, a credit draw, a recorded payment and the repair pass all refuse it', () => {
    expect(collectableForAutoApply(WRITTEN_OFF)).toBe(false);
    expect(creditInvoiceRefusal(WRITTEN_OFF as never, [])).toBe('invoice_not_collectable');
    expect(refusedLifecycle(WRITTEN_OFF as never)).toMatch(/written off/);
    const plan = planApply({
      invoice: { invoiceId: 'inv1', doc: WRITTEN_OFF as never, existingPayments: [] },
      appliedCents: 900,
      kinfolkId: 'fam1',
      spendableCents: 900,
    });
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'apply_invoice_not_payable' } });
    // Part-paid, then written off: the payments do not cover the total, and the
    // repair pass must not read the zero balance as an understatement to undo.
    expect(repairPlanFor('inv1', { ...WRITTEN_OFF, total: 40, totalCents: 4000 }, [{ amountCents: 2500 }])).toEqual({
      skipped: 'written_off',
    });
  });

  it('a card payment from a checkout opened before the write-off lands as unapplied, for the owner to decide', () => {
    expect(
      duplicateCheckoutReason({
        invoice: { amountDueCents: 0, amountDue: 0, status: 'written_off' } as never,
        paymentIntentId: 'pi_1',
        eventRound: null,
      }),
    ).toBe('invoice-not-owed');
  });

  it('closes the checkouts the household left open', () => {
    const before = { ...OPEN, openCheckoutSessionIds: ['cs_1'] };
    const after = { ...WRITTEN_OFF, openCheckoutSessionIds: ['cs_1'] };
    expect(sessionsToClose(before, after)).toEqual(['cs_1']);
    expect(sessionsToClose(before, before)).toEqual([]);
  });
});
