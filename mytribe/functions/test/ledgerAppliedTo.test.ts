import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1971: THE PAYMENT HISTORY'S "APPLIED TO" COLUMN.
 *
 * The walk (2026-11-10) recorded $100.00 on a sent invoice, then $150.00
 * against the $117.00 left with a $3.00 fee. The Payment history then read
 * "not applied" on both rows, beside a Balance of $0.00, so neither row added
 * up by the table's own rule (amount = applied + tip + balance).
 *
 * Both handlers run for real against one write-through Firestore mock.
 */

const mocks = vi.hoisted(() => ({
  db: { current: null as unknown },
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => mocks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: async () => 'kin-uid-1' }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: vi.fn().mockResolvedValue({ written: [], suppressed: [], unresolved: [] }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => undefined,
    },
  };
});

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { getInvoiceLedgerHandler } from '../src/admin/getInvoiceLedger';
import { listPaymentsHandler } from '../src/admin/listPayments';
import { ledgerAppliedInvoiceOf } from '../src/lib/paymentMoney';

type Docs = Record<string, Record<string, unknown> | null>;
let docs: Docs;

beforeEach(() => {
  docs = {
    // A sent invoice of $217.00, nothing paid yet.
    'invoices/inv1': {
      kinfolkId: 'fam1',
      kinfolkName: 'The Wrens',
      client: 'Robin Wren',
      status: 'open',
      invoiceNumber: '1042',
      total: 217,
      totalCents: 21700,
      amountDue: 217,
      amountDueCents: 21700,
    },
  };
  mocks.db.current = buildDbMock({ docs, writeThrough: true }).db;
});

function adminReq(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const base = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Wrens',
  client: 'Robin Wren',
  date: '2026-11-10',
  paymentMethod: 'check',
  referenceNumber: 'CK-1',
  notes: '',
  sendConfirmationEmail: false,
  invoiceId: 'inv1',
  invoiceNumber: '1042',
};

async function ledgerRows() {
  const ledger = await getInvoiceLedgerHandler(adminReq({ invoiceId: 'inv1' }));
  return [...ledger.ledgerPayments].sort((a, b) => a.amountCents - b.amountCents);
}

describe('#1971 Payment history names the invoice a payment paid', () => {
  it('the walk, through today\'s one-call Record payment: both rows are applied to the invoice and add up', async () => {
    await recordPaymentHandler(
      adminReq({ ...base, amount: 100, apply: { invoiceId: 'inv1', invoiceNumber: '1042', amount: 100 }, idempotencyKey: 'pay_1763000000000_aaaaaa' }),
    );
    await recordPaymentHandler(
      adminReq({
        ...base,
        amount: 150,
        tip: 33,
        fee: 3,
        apply: { invoiceId: 'inv1', invoiceNumber: '1042', amount: 117 },
        idempotencyKey: 'pay_1763000000001_bbbbbb',
      }),
    );
    const [first, second] = await ledgerRows();
    expect(first).toMatchObject({ amountCents: 10000, appliedCents: 10000, tipCents: 0, unappliedCents: 0, appliedInvoiceId: 'inv1', appliedInvoiceNumber: '1042' });
    expect(second).toMatchObject({ amountCents: 15000, appliedCents: 11700, tipCents: 3300, feeCents: 300, unappliedCents: 0, appliedInvoiceId: 'inv1', appliedInvoiceNumber: '1042' });
    for (const row of [first!, second!]) {
      expect(row.amountCents).toBe(row.appliedCents + row.tipCents + row.unappliedCents);
    }
  });

  it('a payment recorded by the older two-step screens reads as applied to its invoice, not "not applied"', async () => {
    // The shape the walk saw: `markInvoicePaid` moved the balance, then
    // `recordPayment` wrote the history row with `settledByInvoicePaymentId`
    // and a blank `appliedInvoiceId`.
    const settled = await markInvoicePaidHandler(
      adminReq({ invoiceId: 'inv1', amount: 100, method: 'check', reference: 'CK-1', idempotencyKey: 'ipay_1763000000002_cccccc' }),
    );
    await recordPaymentHandler(
      adminReq({ ...base, amount: 100, settledByInvoicePaymentId: settled.paymentId, idempotencyKey: 'pay_1763000000002_cccccc' }),
    );
    const stored = Object.entries(docs).find(([k]) => k.startsWith('payments/'))![1]!;
    expect(stored['appliedInvoiceId']).toBe('');
    expect(stored['appliedCents']).toBe(10000);
    const [row] = await ledgerRows();
    expect(row).toMatchObject({ amountCents: 10000, appliedCents: 10000, unappliedCents: 0, appliedInvoiceId: 'inv1', appliedInvoiceNumber: '1042' });
    // The staff payment list reads the row the same way.
    const listed = await listPaymentsHandler(adminReq({}));
    expect(listed.payments.find((p) => p.invoiceId === 'inv1')).toMatchObject({ appliedInvoiceId: 'inv1', appliedInvoiceNumber: '1042' });
  });

  it('a row that applied nothing still says "not applied"', async () => {
    // A card payment held for a decision: it names the invoice and moved no balance.
    docs['payments/evt_1'] = {
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      amountCents: 4000,
      amount: 40,
      amountSource: 'stripe-event',
      paymentMethod: 'stripe',
      appliedToInvoice: false,
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      date: '2026-11-10',
    };
    const [row] = await ledgerRows();
    expect(row).toMatchObject({ appliedCents: 0, appliedInvoiceId: '', appliedInvoiceNumber: '' });
  });
});

describe('ledgerAppliedInvoiceOf (#1971)', () => {
  it('keeps a stored invoice, even one other than the row\'s link', () => {
    expect(
      ledgerAppliedInvoiceOf({ invoiceId: 'inv1', appliedInvoiceId: 'inv9', appliedInvoiceNumber: '1050' }, 500),
    ).toEqual({ appliedInvoiceId: 'inv9', appliedInvoiceNumber: '1050' });
  });
  it('reads a blank stored invoice with money applied as the linked invoice', () => {
    expect(
      ledgerAppliedInvoiceOf({ invoiceId: 'inv1', invoiceNumber: '1042', appliedInvoiceId: '' }, 500),
    ).toEqual({ appliedInvoiceId: 'inv1', appliedInvoiceNumber: '1042' });
    // Absent reads as blank, as on every row written before the field existed.
    expect(ledgerAppliedInvoiceOf({ invoiceId: 'inv1' }, 1)).toEqual({ appliedInvoiceId: 'inv1', appliedInvoiceNumber: '' });
  });
  it('leaves a row that applied nothing, or names no invoice, as not applied', () => {
    expect(ledgerAppliedInvoiceOf({ invoiceId: 'inv1', invoiceNumber: '1042' }, 0)).toEqual({
      appliedInvoiceId: '',
      appliedInvoiceNumber: '',
    });
    expect(ledgerAppliedInvoiceOf({ invoiceId: '' }, 500)).toEqual({ appliedInvoiceId: '', appliedInvoiceNumber: '' });
    expect(ledgerAppliedInvoiceOf({ invoiceId: 42 }, 500)).toEqual({ appliedInvoiceId: '', appliedInvoiceNumber: '' });
  });
});
