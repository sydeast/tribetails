import { describe, it, expect, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  createInvoice,
  createQuote,
  sendInvoiceReminder,
  generateReceipt,
  markInvoicePaid,
  reviewAndSendDraftInvoice,
  type NewInvoiceInput,
} from './invoicesWrite';

// NOTE: `call.mockReset()` runs at the top of EACH test body below, not in a
// shared `beforeEach`. That is deliberate, not a stylistic drift from the
// FormSchemas.test.ts / accountWrite.test.ts convention: isolated under this
// exact Node/Vitest combination, resetting a `vi.hoisted` mock of a
// `vi.mock`'d LOCAL module from inside a `beforeEach` hook, in a test whose
// body both configures `mockRejectedValue` AND awaits that rejection, made
// Vitest misreport a genuinely-caught rejection as an "Unhandled Error",
// failing the test despite the assertion itself being correct. Reproduced
// from scratch with a throwaway dummy module unrelated to this file to rule
// out a real bug in invoicesWrite.ts; moving the reset inline removes the
// trigger with no change in test isolation (every test sets its own
// mockResolvedValue/mockRejectedValue immediately after).

function invoiceInput(over: Partial<NewInvoiceInput> = {}): NewInvoiceInput {
  return {
    familyId: 'kf1',
    kinfolkName: 'The Whitfields',
    invoiceNumber: '1099',
    client: '',
    address: '',
    date: '',
    terms: '',
    dueDate: '',
    discount: '',
    total: 40,
    amountDue: 40,
    status: 'draft',
    sessionIds: [],
    ...over,
  };
}

describe('createInvoice', () => {
  it('calls the createInvoice callable with the exact input shape and unwraps invoiceId', async () => {
    call.mockReset();
    const input = invoiceInput();
    call.mockResolvedValue({ ok: true, invoiceId: 'inv-1' });
    const result = await createInvoice(input);
    expect(call).toHaveBeenCalledWith('createInvoice', input);
    expect(result).toEqual({ invoiceId: 'inv-1' });
  });

  it('propagates a rejection (fail loud, never swallowed)', async () => {
    call.mockReset();
    call.mockRejectedValue(new Error('invalid-argument'));
    await expect(createInvoice(invoiceInput())).rejects.toThrow('invalid-argument');
  });
});

describe('createQuote', () => {
  it('calls the createQuote callable with sendToKinfolk included', async () => {
    call.mockReset();
    const input = { ...invoiceInput({ status: '' }), sendToKinfolk: true };
    call.mockResolvedValue({ ok: true, invoiceId: 'inv-2' });
    const result = await createQuote(input);
    expect(call).toHaveBeenCalledWith('createQuote', input);
    expect(result).toEqual({ invoiceId: 'inv-2' });
  });
});

describe('sendInvoiceReminder', () => {
  it('sends only { invoiceId }, matching the backend contract', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, invoiceId: 'inv-3' });
    await sendInvoiceReminder('inv-3');
    expect(call).toHaveBeenCalledWith('sendInvoiceReminder', { invoiceId: 'inv-3' });
  });

  it('fails loud when the invoice is already paid', async () => {
    call.mockReset();
    call.mockRejectedValue(new Error('Invoice is already paid; nothing to remind.'));
    await expect(sendInvoiceReminder('inv-3')).rejects.toThrow('already paid');
  });
});

describe('generateReceipt', () => {
  it('sends only { invoiceId }', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true });
    await generateReceipt('inv-4');
    expect(call).toHaveBeenCalledWith('generateReceipt', { invoiceId: 'inv-4' });
  });
});

describe('markInvoicePaid', () => {
  it('routes through postInvoiceEvent with { status: "paid", amountDue: 0 }, not a dedicated markPaid callable', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true });
    await markInvoicePaid('inv-5', 'kf1');
    expect(call).toHaveBeenCalledWith('postInvoiceEvent', {
      familyId: 'kf1',
      invoiceId: 'inv-5',
      payload: { status: 'paid', amountDue: 0 },
    });
  });

  it('fails loud on rejection', async () => {
    call.mockReset();
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(markInvoicePaid('inv-5', 'kf1')).rejects.toThrow('permission-denied');
  });
});

describe('reviewAndSendDraftInvoice', () => {
  it('routes through postInvoiceEvent clearing status, not a dedicated reviewAndSendDraftInvoice callable', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true });
    await reviewAndSendDraftInvoice('inv-6', 'kf1');
    expect(call).toHaveBeenCalledWith('postInvoiceEvent', {
      familyId: 'kf1',
      invoiceId: 'inv-6',
      payload: { status: '' },
    });
  });
});
