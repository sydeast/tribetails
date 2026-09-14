import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), enqueue: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('recipient-uid') }));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return { contentDedupeKey: actual.contentDedupeKey, enqueueNotificationDetailed: mocks.enqueue };
});
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [] });
  mocks.logEvent.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function call(invoiceId: string, payload: Record<string, unknown>) {
  return { data: { familyId: '3', invoiceId, payload }, auth: { uid: 'admin-uid' } } as any;
}

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
    const res = await postInvoiceEventHandler(call('inv-7', { total: 40, amountDue: 40, status: 'open' }));
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
    await postInvoiceEventHandler(call('inv-7', { status: 'cancelled' }));
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
    await postInvoiceEventHandler(call('inv-8', { total: 40, status: 'open' }));
    const w = ctx.writes.find((w) => w.path === 'invoices/inv-8')!;
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
  });
});

describe('postInvoiceEvent: repeats never send, real edits always do (#832)', () => {
  it('a new invoice sends invoice.new with the plain invoice identity', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    await postInvoiceEventHandler(call('inv-7', { total: 40 }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const args = mocks.enqueue.mock.calls[0][0];
    expect(args.key).toBe('invoice.new');
    expect(args.dedupeKey).toBeUndefined();
  });

  it('a real change to an existing invoice sends invoice.updated named by its content', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'invoices/inv-7': { kinfolkId: '3', total: 40, amountDue: 40 } } }).db,
    );
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    await postInvoiceEventHandler(call('inv-7', { total: 55, amountDue: 55 }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.updated', dedupeKey: expect.stringMatching(/^invoice:inv-7:updated#/) }),
    );
  });

  it('a retried CREATE sends invoice.new once and never an invoice.updated about nothing', async () => {
    // The first attempt wrote the doc; the retry sees it existing. Without the
    // comparison the retry sends `invoice.updated`, a different key the
    // dispatcher's same-key dedupe cannot catch.
    const ctx = buildDbMock({ docs: {}, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    const payload = { total: 40, amountDue: 40, dueDate: '2026-10-01' };

    await postInvoiceEventHandler(call('inv-7', payload));
    await postInvoiceEventHandler(call('inv-7', payload));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ key: 'invoice.new' }));
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification.skipped', extra: expect.objectContaining({ reason: 'unchanged' }) }),
    );
  });

  it('two attempts at the same edit that both read before either wrote carry the SAME key', async () => {
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    for (let i = 0; i < 2; i += 1) {
      mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'invoices/inv-7': { kinfolkId: '3', total: 40 } } }).db);
      await postInvoiceEventHandler(call('inv-7', { total: 45 }));
    }
    const [a, b] = mocks.enqueue.mock.calls.map((c) => c[0].dedupeKey);
    expect(a).toBe(b);
  });

  it('two different edits carry DIFFERENT keys, and a field no template shows does not change the key', async () => {
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    const keyFor = async (payload: Record<string, unknown>) => {
      mocks.enqueue.mockClear();
      mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'invoices/inv-7': { kinfolkId: '3', total: 40 } } }).db);
      await postInvoiceEventHandler(call('inv-7', payload));
      return mocks.enqueue.mock.calls[0][0].dedupeKey as string;
    };
    const amount = await keyFor({ total: 45 });
    const due = await keyFor({ dueDate: '2026-11-01' });
    const amountPlusNote = await keyFor({ total: 45, internalNote: 'called them' });
    expect(amount).not.toBe(due);
    expect(amountPlusNote).toBe(amount);
  });

  it('logs a dispatcher dedupe as a dedupe, not as a failure, and still answers ok', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    mocks.enqueue.mockResolvedValue({
      written: [],
      suppressed: [{ recipientUid: 'recipient-uid', reason: 'duplicate', existingId: 'n0', lastAtMs: NOW - 1000 }],
    });
    const { postInvoiceEventHandler } = await import('../src/admin/postInvoiceEvent');
    const res = await postInvoiceEventHandler(call('inv-7', { total: 40 }));
    expect(res).toEqual({ ok: true });
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'notification.dispatch.deduped' }));
    expect(mocks.logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'notification.dispatch.failed' }));
  });
});
