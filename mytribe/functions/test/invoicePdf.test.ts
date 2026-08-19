import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdmin: vi.fn(),
  save: vi.fn(),
  resolveKinfolkAccess: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: mocks.getAdmin }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkAccess', () => ({ resolveKinfolkAccess: mocks.resolveKinfolkAccess }));

import { renderInvoicePdf, invoiceForPdf, winAnsiSafe, lineItemsForPdf, usdCents, formatQty, formatPaymentMethods, type InvoiceForPdf } from '../src/lib/invoicePdf';
import { generateInvoicePdfHandler } from '../src/admin/generateInvoicePdf';
import { getMyInvoicePdfHandler } from '../src/portal/getMyInvoicePdf';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.getAdmin.mockReset().mockReturnValue({
    storage: () => ({ bucket: () => ({ name: 'demo.appspot.com', file: () => ({ save: mocks.save }) }) }),
  });
  mocks.resolveKinfolkAccess.mockReset().mockResolvedValue({ kinfolkId: 'kf1', isOperator: false });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

const INV: Record<string, unknown> = {
  invoiceNumber: 'INV-1001', kinfolkName: 'Jane Doe', client: 'Jane (Buddy)', address: '1 Main St',
  date: 'Sep 1, 2025', dueDate: 'Sep 15, 2025', terms: 'Net 14', discount: '0.00',
  status: 'open', total: 120, amountDue: 120, paymentsHistory: 'Sep 5 - $50 card', kinfolkId: 'kf1',
};

describe('renderInvoicePdf (pure)', () => {
  it('produces a valid PDF byte stream', async () => {
    const inv: InvoiceForPdf = invoiceForPdf('i1', INV);
    const bytes = await renderInvoicePdf(inv);
    expect(bytes.length).toBeGreaterThan(500);
    // PDF magic header %PDF
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('%PDF');
  });

  it('invoiceForPdf maps fields + falls back to id for missing invoiceNumber', () => {
    const inv = invoiceForPdf('i9', { total: 5, amountDue: 5 });
    expect(inv.invoiceNumber).toBe('i9');
    expect(inv.total).toBe(5);
    expect(inv.client).toBe('');
  });

  it('renders without throwing for non-WinAnsi fields (CJK / Cyrillic / emoji)', async () => {
    // pdf-lib StandardFonts throw on non-cp1252 code points; winAnsiSafe must
    // prevent that so an international household can still get a PDF.
    const inv = invoiceForPdf('i2', {
      ...INV, client: '山田太郎 🐶', address: 'Иванов ул. — 5', kinfolkName: 'José Müller',
      paymentsHistory: 'Σεπ 5 — €50',
    });
    const bytes = await renderInvoicePdf(inv);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('%PDF');
  });

  it('winAnsiSafe keeps Latin-1 + cp1252 specials, maps the rest to ?', () => {
    expect(winAnsiSafe('José Müller — €')).toBe('José Müller — €');
    expect(winAnsiSafe('山田')).toBe('??');
    expect(winAnsiSafe('🐶')).toBe('?');
  });
});

describe('generateInvoicePdf (admin)', () => {
  it('renders, stores, returns a download-token URL, audits', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/i1': INV } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await generateInvoicePdfHandler(req({ invoiceId: 'i1' }));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBe('i1');
    expect(res.pdfUrl).toContain('firebasestorage.googleapis.com');
    expect(res.pdfUrl).toContain('demo.appspot.com');
    expect(res.pdfUrl).toContain('invoice_pdfs');
    expect(res.pdfUrl).toContain('alt=media&token=');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    // saved with the application/pdf content type + a download token
    const saveOpts = mocks.save.mock.calls[0][1];
    expect(saveOpts.contentType).toBe('application/pdf');
    expect(saveOpts.metadata.metadata.firebaseStorageDownloadTokens).toBeTruthy();
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'BILLING_INVOICE_PDF_GENERATED' }));
  });

  it('throws not-found for a missing invoice', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(generateInvoicePdfHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'invoices/i1': INV } }).db);
    await expect(generateInvoicePdfHandler(req({ invoiceId: 'i1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('getMyInvoicePdf (portal, IDOR-scoped)', () => {
  it('returns a URL for the caller own invoice', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/i1': INV } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getMyInvoicePdfHandler(req({ invoiceId: 'i1' }));
    expect(res.pdfUrl).toContain('firebasestorage.googleapis.com');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'BILLING_INVOICE_PDF_GENERATED', actorRole: 'PRIMARY' }));
  });

  it('refuses an invoice from another household (permission-denied, no render)', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/i2': { ...INV, kinfolkId: 'OTHER' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(getMyInvoicePdfHandler(req({ invoiceId: 'i2' }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('throws not-found for a missing invoice', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(getMyInvoicePdfHandler(req({ invoiceId: 'x' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});
/**
 * Task 5.1: the PDF renders REAL line items when the invoice has them.
 *
 * `lineItemsForPdf` is tested hard because it reads a RAW Firestore document,
 * not a validated payload. `firestore.rules` grants `allow update: if isAuntie()`
 * over the whole invoices collection and `postInvoiceEvent` merges an arbitrary
 * payload, so the malformed rows below are reachable states, not paranoia.
 */
describe('lineItemsForPdf (pure, defensive)', () => {
  it('returns an empty list for an un-itemized invoice', () => {
    expect(lineItemsForPdf(undefined)).toEqual([]);
    expect(lineItemsForPdf(null)).toEqual([]);
  });
  it('returns an empty list when the field is not an array at all', () => {
    expect(lineItemsForPdf('two dog walks')).toEqual([]);
    expect(lineItemsForPdf({ description: 'Dog walk' })).toEqual([]);
  });
  it('derives the line amount rather than trusting a stored one', () => {
    const [li] = lineItemsForPdf([{ description: 'Dog walk', qty: 3, unitCents: 2500, amountCents: 1 }]);
    expect(li!.amountCents).toBe(7500);
  });
  it('subtracts a per-line discount from the derived amount', () => {
    const [li] = lineItemsForPdf([{ description: 'Stay', qty: 1, unitCents: 8000, discountCents: 500 }]);
    expect(li!.amountCents).toBe(7500);
  });
  it('rounds a fractional quantity once, at the line', () => {
    const [li] = lineItemsForPdf([{ description: 'Hours', qty: 2.5, unitCents: 3333 }]);
    expect(li!.amountCents).toBe(8333); // 8332.5 rounds half-up
  });
  it('DROPS a malformed row instead of failing the whole document', () => {
    const rows = lineItemsForPdf([
      { description: 'Good', qty: 1, unitCents: 100 },
      { description: '', qty: 1, unitCents: 100 },
      { description: 'No qty', unitCents: 100 },
      { description: 'NaN qty', qty: Number.NaN, unitCents: 100 },
      { description: 'String price', qty: 1, unitCents: '100' },
      null,
      'not a row',
    ]);
    expect(rows.map((r) => r.description)).toEqual(['Good']);
  });
  it('treats a missing discountCents as zero, not as a broken row', () => {
    const [li] = lineItemsForPdf([{ description: 'Walk', qty: 1, unitCents: 2500 }]);
    expect(li!.discountCents).toBe(0);
    expect(li!.amountCents).toBe(2500);
  });
});
describe('invoiceForPdf line-item fields', () => {
  it('leaves an un-itemized invoice with no items and a zero subtotal', () => {
    const inv = invoiceForPdf('i1', INV);
    expect(inv.lineItems).toEqual([]);
    expect(inv.subtotalCents).toBe(0);
    expect(inv.invoiceDiscountCents).toBe(0);
  });
  it('sums the subtotal from the LINES, not from the stored subtotalCents', () => {
    // The stored figure is deliberately wrong here: firestore.rules and
    // postInvoiceEvent both bypass every callable, so the two can drift. What
    // the household receives must add up to what it lists.
    const inv = invoiceForPdf('i1', {
      ...INV,
      lineItems: [
        { description: 'Dog walk', qty: 3, unitCents: 2500 },
        { description: 'Stay', qty: 1, unitCents: 8000, discountCents: 500 },
      ],
      subtotalCents: 999_999,
    });
    expect(inv.subtotalCents).toBe(15000);
  });
  it('reads the invoice-level discount when present', () => {
    const inv = invoiceForPdf('i1', { ...INV, lineItems: [{ description: 'x', qty: 1, unitCents: 500 }], invoiceDiscountCents: 250 });
    expect(inv.invoiceDiscountCents).toBe(250);
  });
});
describe('usdCents / formatQty', () => {
  it('formats integer cents as dollars', () => {
    expect(usdCents(0)).toBe('$0.00');
    expect(usdCents(2500)).toBe('$25.00');
    expect(usdCents(8333)).toBe('$83.33');
    expect(usdCents(-1250)).toBe('-$12.50');
  });
  it('reads a non-finite figure as zero rather than printing $NaN on an invoice', () => {
    expect(usdCents(Number.NaN)).toBe('$0.00');
  });
  it('prints a whole quantity without money-style decimals', () => {
    expect(formatQty(3)).toBe('3');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(Number.NaN)).toBe('0');
  });
});
describe('renderInvoicePdf with line items', () => {
  const itemized: Record<string, unknown> = {
    ...INV,
    lineItems: [
      { description: 'Dog walk', qty: 3, unitCents: 2500 },
      { description: 'Overnight stay', qty: 1, unitCents: 8000, discountCents: 500 },
    ],
    invoiceDiscountCents: 1000,
  };
  it('still produces a valid PDF for an itemized invoice', async () => {
    const bytes = await renderInvoicePdf(invoiceForPdf('i1', itemized));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(500);
  });
  it('renders MORE bytes than the same invoice without items (the table is really drawn)', async () => {
    const withItems = await renderInvoicePdf(invoiceForPdf('i1', itemized));
    const without = await renderInvoicePdf(invoiceForPdf('i1', INV));
    expect(withItems.length).toBeGreaterThan(without.length);
  });
  it('does not throw on a description carrying characters Helvetica cannot encode', async () => {
    const bytes = await renderInvoicePdf(
      invoiceForPdf('i1', { ...INV, lineItems: [{ description: '狗狗散步 🐕', qty: 1, unitCents: 2500 }] }),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });
  it('renders an invoice with a 100-line itemization without blowing up', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ description: `Visit ${String(i)}`, qty: 1, unitCents: 2500 }));
    const bytes = await renderInvoicePdf(invoiceForPdf('i1', { ...INV, lineItems: many }));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });
});

/**
 * ISSUE #409: the printed "How to pay" line follows the same toggles the
 * portal does.
 *
 * The paper bill and the screen offering different things is worse than
 * either being wrong on its own, because the household cannot tell which one
 * to believe. Both are driven off `METHOD_SPECS` now, so they cannot differ.
 */
describe('formatPaymentMethods (issue #409)', () => {
  it('prints exactly what it always printed for a settings doc with no toggles', () => {
    // Every existing org, on the day this deploys.
    expect(
      formatPaymentMethods({ venmoHandle: '@auntie', paypalHandle: 'tribetails', cashappHandle: '$auntie' }),
    ).toBe('Venmo: @auntie    •    PayPal: tribetails    •    Cash App: $auntie');
  });

  it('stops printing a method the operator has switched off', () => {
    expect(
      formatPaymentMethods({
        venmoHandle: '@auntie',
        paypalHandle: 'tribetails',
        paymentOptions: { paypal: { enabled: false } },
      }),
    ).toBe('Venmo: @auntie');
  });

  it("prints the operator's own instructions for a method that has no handle", () => {
    expect(
      formatPaymentMethods({
        paymentOptions: { zelle: { enabled: true, instructions: 'Zelle to 805-555-0104' } },
      }),
    ).toBe('Zelle: Zelle to 805-555-0104');
  });

  it('prints nothing for an enabled method with nothing written under it', () => {
    expect(formatPaymentMethods({ paymentOptions: { check: { enabled: true } } })).toBe('');
  });

  it('never prints the card, which is paid through the portal rather than off the page', () => {
    expect(formatPaymentMethods({})).toBe('');
  });
});
