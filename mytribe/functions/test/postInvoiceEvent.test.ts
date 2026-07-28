import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('recipient-uid') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('postInvoiceEventHandler', () => {
  it('rejects invalid args', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    await expect(
      postInvoiceEventHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('writes to the FLAT invoices collection and stamps kinfolkId', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    const res = await postInvoiceEventHandler({
      data: { familyId: '3', invoiceId: 'inv-7', payload: { total: 40, amountDue: 40, status: 'open' } },
      auth: { uid: 'admin-uid' },
    } as any);
    expect(res).toEqual({ ok: true });

    // Must land in the flat top-level collection, NOT families/{id}/invoices.
    const w = ctx.writes.find((w) => w.path === 'invoices/inv-7');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    expect(w!.data.kinfolkId).toBe('3');
    expect(w!.data.total).toBe(40);
    expect(w!.data.status).toBe('open');
    expect(ctx.writes.some((w) => w.path.startsWith('families/'))).toBe(false);
  });

  it('persists the state stamp for whatever the merged doc classifies as', async () => {
    // This callable merges an ARBITRARY payload, so it is the writer that most
    // needs the stamp: any classifier input may be about to change. A payload
    // flipping a stored open invoice to cancelled stamps cancelled/none in the
    // same set.
    const ctx = buildDbMock({
      docs: { 'invoices/inv-7': { kinfolkId: '3', status: 'open', amountDue: 40, total: 40 } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    await postInvoiceEventHandler({
      data: { familyId: '3', invoiceId: 'inv-7', payload: { status: 'cancelled' } },
      auth: { uid: 'admin-uid' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'invoices/inv-7')!;
    expect(w.data.status).toBe('cancelled');
    expect(w.data.editScope).toBe('none');
  });

  it('canonicalizes a status label the classifier does not read: open with no amountDue stamps paid', async () => {
    // DELIBERATE, and worth its own test. The classifier reads 'open' from the
    // MONEY, not from the label, and a doc with a positive total and no
    // amountDue evidence is 'paid' (the admin and Android classifiers already
    // resolve it that way; only the portal's 5-state resolver said open). The
    // stamp persists the classifier's reading, which is the ADR-0002 point:
    // one derivation, on the server, instead of five that disagree.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    await postInvoiceEventHandler({
      data: { familyId: '3', invoiceId: 'inv-8', payload: { total: 40, status: 'open' } },
      auth: { uid: 'admin-uid' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'invoices/inv-8')!;
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
  });
});
