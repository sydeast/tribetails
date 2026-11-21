/**
 * #2527: Review and send decides draft and quote by the state classifier
 * (`invoiceStateOf`): `status`, falling back to the older `invoiceStatus` only
 * when `status` is absent. Before, it read `status` alone, so a draft marked
 * only in the older field could not be sent while Record payment (#2517) told
 * the office to send it first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: async (args: unknown) => ({
    written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
    suppressed: [],
    unresolved: [],
    appOnly: [],
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } as any } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(fields: Record<string, unknown>) {
  return buildDbMock({
    docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', total: 40, amountDue: 40, ...fields } },
  });
}

function invoiceWrite(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find((w) => w.path === 'invoices/inv1');
}

describe('reviewAndSendDraftInvoice: a draft or quote marked only in the older field (#2527)', () => {
  it('sends a draft marked only in invoiceStatus, and writes both fields open', async () => {
    for (const invoiceStatus of ['draft', ' Draft ']) {
      const ctx = seed({ invoiceStatus });
      mocks.dbFn.mockReturnValue(ctx.db);
      const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
      expect(res, invoiceStatus).toMatchObject({ ok: true, invoiceId: 'inv1' });
      const write = invoiceWrite(ctx);
      expect(write?.data.status, invoiceStatus).toBe('open');
      expect(write?.data.invoiceStatus, invoiceStatus).toBe('open');
    }
  });

  it('tells the office a quote marked only in invoiceStatus has already gone out, and writes nothing', async () => {
    const ctx = seed({ invoiceStatus: 'quote' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'This quote has already been sent to the household.',
      details: { code: 'quote_already_sent' },
    });
    expect(invoiceWrite(ctx)).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a stored status wins over the older field when the two disagree', async () => {
    const sent = seed({ status: 'open', invoiceStatus: 'draft' });
    mocks.dbFn.mockReturnValue(sent.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Invoice is not a draft; nothing to send.',
    });
    expect(invoiceWrite(sent)).toBeUndefined();

    const draft = seed({ status: 'draft', invoiceStatus: 'open' });
    mocks.dbFn.mockReturnValue(draft.db);
    expect(await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).toMatchObject({ ok: true });
    expect(invoiceWrite(draft)?.data.status).toBe('open');
  });

  it('still refuses an invoice that is no draft in either field', async () => {
    const ctx = seed({ invoiceStatus: 'open' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Invoice is not a draft; nothing to send.',
    });
    expect(invoiceWrite(ctx)).toBeUndefined();
  });
});
