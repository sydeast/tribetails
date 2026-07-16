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

import { renderInvoicePdf, invoiceForPdf, winAnsiSafe, type InvoiceForPdf } from '../src/lib/invoicePdf';
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
