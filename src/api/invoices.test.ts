import { describe, it, expect } from 'vitest';
import { INVOICES_QUERY, normalizeInvoice, type InvoiceEntry } from './invoices';

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
