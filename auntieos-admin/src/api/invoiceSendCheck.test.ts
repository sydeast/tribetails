import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getDocFromServer, doc } = vi.hoisted(() => ({ getDocFromServer: vi.fn(), doc: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getDocFromServer, doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));
const { readInvoiceSendMarks } = await import('./invoiceSendCheck');
beforeEach(() => {
  getDocFromServer.mockReset();
  doc.mockReset().mockReturnValue('invoice-ref');
});
describe('readInvoiceSendMarks (#1567)', () => {
  it('reads the invoice from the server, not the cache', async () => {
    getDocFromServer.mockResolvedValue({ exists: () => true, data: () => ({ status: 'open' }) });
    await expect(readInvoiceSendMarks('inv-1')).resolves.toEqual({
      status: 'open',
      reminderNotifiedAtMs: null,
      receiptIssuedAtMs: null,
      quoteResentAtMs: null,
    });
    expect(doc).toHaveBeenCalledWith({}, 'invoices', 'inv-1');
    expect(getDocFromServer).toHaveBeenCalledWith('invoice-ref');
  });
  it('answers null, never a guess, when the read fails or the invoice is gone', async () => {
    getDocFromServer.mockRejectedValue(new Error('unavailable'));
    await expect(readInvoiceSendMarks('inv-1')).resolves.toBeNull();
    getDocFromServer.mockResolvedValue({ exists: () => false, data: () => undefined });
    await expect(readInvoiceSendMarks('inv-1')).resolves.toBeNull();
  });
});
