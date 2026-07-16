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
      data: { familyId: '3', invoiceId: 'inv-7', payload: { total: 40, status: 'open' } },
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
});
