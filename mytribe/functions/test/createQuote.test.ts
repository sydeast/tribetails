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
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createQuoteHandler } from '../src/admin/createQuote';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const validPayload = {
  familyId: 'fam1',
  kinfolkName: 'Smith Household',
  invoiceNumber: 'QTE-001',
  client: 'Smith',
  address: '1 Main St',
  date: '2026-06-01',
  terms: 'Net 30',
  dueDate: '2026-07-01',
  discount: '0',
  total: 200,
  amountDue: 200,
  status: 'sent', // ignored on purpose
  sessionIds: ['s1'],
};

describe('createQuote zod validation', () => {
  it('accepts a full valid payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req(validPayload));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBeTruthy();
  });

  it('rejects blank invoiceNumber', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createQuoteHandler(req({ ...validPayload, invoiceNumber: '' }))).rejects.toThrow();
  });

  it('rejects negative total', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(createQuoteHandler(req({ ...validPayload, total: -5 }))).rejects.toThrow();
  });

  it('rejects missing familyId', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { familyId, ...noFamily } = validPayload;
    await expect(createQuoteHandler(req(noFamily))).rejects.toThrow();
  });
});

describe('createQuote handler effects', () => {
  it('forces quote status on both status fields regardless of caller status arg', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(write).toBeTruthy();
    // Lowercase since the state stamp (2026-07-28): the stored value is the
    // classifier's canonical vocabulary. The admin chip still reads 'QUOTE',
    // because it derives from the classifier, which lowercases before matching.
    expect(write!.data.status).toBe('quote');
    expect(write!.data.invoiceStatus).toBe('quote');
    expect(write!.data.kinfolkId).toBe('fam1');
    expect(write!.data.createdAt).toBe('__TS__');
  });

  it('persists the state stamp in the same write: a quote is fully editable', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    // What the classifier says about the doc as written is what the doc stores.
    expect(invoiceStateStampOf(write.data, 0)).toEqual({ status: 'quote', editScope: 'all' });
    expect(write.data.status).toBe('quote');
    expect(write.data.editScope).toBe('all');
  });

  it('writes a BILLING_QUOTE_CREATED audit entry', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_QUOTE_CREATED', familyId: 'fam1', actorUid: 'admin1' }),
    );
  });

  it('does NOT dispatch a notification when sendToKinfolk is omitted/false', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('dispatches invoice.new with invoice target ref when sendToKinfolk is true', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'invoice.new',
        recipientUid: 'kin-uid-1',
        targetType: 'invoice',
        targetId: res.invoiceId,
      }),
    );
  });

  it('still returns ok when notification dispatch fails (swallowed + logged)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(res.ok).toBe(true);
  });
});
