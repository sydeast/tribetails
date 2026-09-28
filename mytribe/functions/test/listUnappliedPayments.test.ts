import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  listUnappliedPaymentsHandler,
  Result,
  invoiceTakesDecision,
  openAmountDueCents,
} from '../src/admin/listUnappliedPayments';

/** #1003: the payments waiting for the admin's decision, and where one may go. */

function req(
  data: unknown,
  token: Record<string, unknown> = { admin: true },
  uid: string | null = 'owner1',
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const flagged = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  data: {
    kinfolkId: 'fam1',
    invoiceId: 'inv_paid',
    amountCents: 5000,
    amountResolved: true,
    feeCents: 175,
    referenceNumber: 'pi_2',
    needsAdminDecision: true,
    duplicateCheckoutReason: 'invoice-marked-paid',
    date: 1_790_000_000_000,
    ...over,
  },
});

function seed() {
  return buildDbMock({
    queryDocs: {
      payments: [
        flagged('evt_old', { date: 1_780_000_000_000, duplicateCheckoutReason: 'stale-round' }),
        flagged('evt_new'),
        flagged('evt_decided', { needsAdminDecision: false }),
        flagged('evt_other_house', { kinfolkId: 'fam2' }),
        flagged('evt_no_amount', { amountCents: null, amountResolved: false, date: 1_700_000_000_000 }),
        { id: 'pay_plain', data: { kinfolkId: 'fam1', amountCents: 1000 } },
      ],
      invoices: [
        { id: 'inv_paid', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-1', status: 'paid', totalCents: 5000, amountDueCents: 0 } },
        { id: 'inv_open_b', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-3', status: 'open', totalCents: 4000, amountDueCents: 1500, createdAt: 2000 } },
        { id: 'inv_open_a', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-2', status: 'open', totalCents: 3000, amountDueCents: 3000, createdAt: 1000 } },
        { id: 'inv_label_paid', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-4', status: 'open', paymentStatus: 'PAID', totalCents: 3000, amountDueCents: 3000 } },
        { id: 'inv_draft', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-5', status: 'draft', totalCents: 3000, amountDueCents: 3000 } },
        { id: 'inv_cancel', data: { kinfolkId: 'fam1', invoiceNumber: 'INV-6', status: 'cancelled', totalCents: 3000, amountDueCents: 3000 } },
        { id: 'inv_fam2', data: { kinfolkId: 'fam2', invoiceNumber: 'INV-7', status: 'open', totalCents: 3000, amountDueCents: 3000 } },
      ],
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('listUnappliedPayments', () => {
  it('lists the household’s flagged payments newest first, and its open invoices oldest first', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = Result.parse(await listUnappliedPaymentsHandler(req({ kinfolkId: 'fam1' })));

    expect(res.payments.map((p) => p.paymentId)).toEqual(['evt_new', 'evt_old', 'evt_no_amount']);
    expect(res.payments[0]).toEqual({
      paymentId: 'evt_new',
      kinfolkId: 'fam1',
      invoiceId: 'inv_paid',
      invoiceNumber: 'INV-1',
      amountCents: 5000,
      amountResolved: true,
      feeCents: 175,
      reason: 'the invoice was already marked paid',
      receivedAtMs: 1_790_000_000_000,
      referenceNumber: 'pi_2',
    });
    expect(res.payments[1].reason).toBe(
      'it was paid on a checkout opened before an earlier payment on this invoice',
    );
    expect(res.payments[2]).toMatchObject({ amountCents: 0, amountResolved: false });

    expect(res.openInvoices).toEqual([
      { invoiceId: 'inv_open_a', invoiceNumber: 'INV-2', amountDueCents: 3000 },
      { invoiceId: 'inv_open_b', invoiceNumber: 'INV-3', amountDueCents: 1500 },
    ]);
  });

  it('answers empty lists for a household with nothing waiting', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    const res = await listUnappliedPaymentsHandler(req({ kinfolkId: 'fam9' }));
    expect(res).toEqual({ ok: true, kinfolkId: 'fam9', payments: [], openInvoices: [] });
  });

  it('refuses an Auntie before any read, kinfolk, and a missing household id', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      listUnappliedPaymentsHandler(req({ kinfolkId: 'fam1' }, { staffRole: 'auntie', admin: true }, 'auntie1')),
    ).rejects.toMatchObject({ code: 'permission-denied', message: 'This is not available to caretaker accounts.' });
    expect(mocks.dbFn).not.toHaveBeenCalled();
    await expect(listUnappliedPaymentsHandler(req({ kinfolkId: 'fam1' }, {}, 'kin1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(listUnappliedPaymentsHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('keeps a sandbox admin inside their test tribe', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      listUnappliedPaymentsHandler(req({ kinfolkId: 'fam1' }, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('invoiceTakesDecision', () => {
  it('only a sent, unpaid invoice with something owed', () => {
    expect(invoiceTakesDecision({ status: 'open', totalCents: 100, amountDueCents: 100 })).toBe(true);
    expect(invoiceTakesDecision({ status: 'open', totalCents: 100, amountDueCents: 0 })).toBe(false);
    expect(invoiceTakesDecision({ status: 'paid', totalCents: 100, amountDueCents: 100 })).toBe(false);
    expect(invoiceTakesDecision({ status: 'open', paymentStatus: 'PAID', totalCents: 100, amountDueCents: 100 })).toBe(false);
    expect(invoiceTakesDecision({ status: 'quote', totalCents: 100, amountDueCents: 100 })).toBe(false);
    expect(invoiceTakesDecision({ status: 'credit', totalCents: -100, amountDueCents: -100 })).toBe(false);
    expect(invoiceTakesDecision({ status: 'open', archived: true, totalCents: 100, amountDueCents: 100 })).toBe(false);
  });

  it('reads the amount due from cents, then dollars, then the total', () => {
    expect(openAmountDueCents({ amountDueCents: 250, amountDue: 9 })).toBe(250);
    expect(openAmountDueCents({ amountDue: 12.5 })).toBe(1250);
    expect(openAmountDueCents({ totalCents: 700 })).toBe(700);
  });
});
