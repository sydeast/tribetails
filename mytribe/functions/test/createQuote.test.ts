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

  // #408: a quote follows createInvoice exactly here. A blank number means
  // "assign it", and it is drawn from the SAME sequence, so a quote and an
  // invoice can never be handed the same number.
  it('assigns a number when the caller sends a blank one, from the shared sequence', async () => {
    const ctx = buildDbMock({ docs: { 'counters/invoiceNumber': { next: 7 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, invoiceNumber: '' }));
    expect(res.ok).toBe(true);
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.invoiceNumber).toBe('INV-2026-0007');
    expect(ctx.writes.find((w) => w.path === 'counters/invoiceNumber')?.data.next).toBe(8);
  });
  it('keeps a number the caller did send', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.invoiceNumber).toBe('QTE-001');
  });
  it('resolves structured terms the same way an invoice does', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({ ...validPayload, sessionIds: [], termsCode: 'net_14', dueDate: '' }),
    );
    const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(written?.data.terms).toBe('Due 14 days after the invoice date');
    expect(written?.data.dueDate).toBe('2026-06-15');
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

  // A quote lands in the same flat `invoices` collection the admin list windows
  // and orders on, so free text here is the same sorting bug as in
  // createInvoice. See functions/src/lib/invoiceDay.ts.
  describe('date and dueDate are days, not free text', () => {
    for (const field of ['date', 'dueDate'] as const) {
      it(`rejects a month-name ${field}`, async () => {
        const ctx = buildDbMock({});
        mocks.dbFn.mockReturnValue(ctx.db);
        await expect(
          createQuoteHandler(req({ ...validPayload, [field]: 'Feb 12, 2026' })),
        ).rejects.toThrow();
      });

      it(`still accepts a blank ${field}, which is the documented default`, async () => {
        const ctx = buildDbMock({});
        mocks.dbFn.mockReturnValue(ctx.db);
        await expect(
          createQuoteHandler(req({ ...validPayload, [field]: '' })),
        ).resolves.toMatchObject({ ok: true });
      });
    }
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

/**
 * Itemized quotes (fix for issue #118).
 *
 * A quote now accepts `lineItems` and `invoiceDiscountCents` with the same
 * semantics as `createInvoice`: omit them and the caller's total is stored
 * verbatim; supply them and the server owns the money, refusing a disagreement
 * rather than silently dropping the lines.
 */
describe('createQuote line items', () => {
  const twoLines = [
    { description: 'Dog walk', qty: 3, unitCents: 2500 },
    { description: 'Overnight stay', qty: 1, unitCents: 8000, discountCents: 500 },
  ];
  // 3 x 2500 = 7500, plus 8000 - 500 = 7500 -> subtotal 15000
  const subtotalCents = 15000;

  it('writes NO cents fields at all for a legacy un-itemized payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data).not.toHaveProperty('lineItems');
    expect(write.data).not.toHaveProperty('totalCents');
    expect(write.data).not.toHaveProperty('subtotalCents');
    expect(write.data).not.toHaveProperty('amountDueCents');
    expect(write.data).not.toHaveProperty('invoiceDiscountCents');
    // And the caller's dollars are still stored verbatim.
    expect(write.data.total).toBe(200);
    expect(write.data.amountDue).toBe(200);
  });

  it('stores the lines and derives every cents figure from them', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.lineItems).toEqual(twoLines);
    expect(write.data.subtotalCents).toBe(subtotalCents);
    expect(write.data.totalCents).toBe(subtotalCents);
    expect(write.data.amountDueCents).toBe(subtotalCents);
    expect(write.data.invoiceDiscountCents).toBe(0);
  });

  it('still forces quote status even when line items are present', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('quote');
    expect(write.data.invoiceStatus).toBe('quote');
  });

  it('applies an invoice-level discount to the total but not the subtotal', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({
        ...validPayload,
        total: 130,
        amountDue: 130,
        lineItems: twoLines,
        invoiceDiscountCents: 2000,
      }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.subtotalCents).toBe(subtotalCents);
    expect(write.data.totalCents).toBe(subtotalCents - 2000);
    expect(write.data.total).toBe(130);
  });

  it('REFUSES a total that disagrees with the lines', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createQuoteHandler(req({ ...validPayload, total: 999, amountDue: 999, lineItems: twoLines })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_total_mismatch' },
    });
    expect(ctx.writes.find((w) => w.path.startsWith('invoices/'))).toBeUndefined();
  });

  it('REFUSES an amountDue that disagrees with the lines', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createQuoteHandler(req({ ...validPayload, total: 150, amountDue: 10, lineItems: twoLines })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_amount_due_mismatch' },
    });
  });

  it('refuses a discount larger than the line it is taken off', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createQuoteHandler(
        req({
          ...validPayload,
          total: 0,
          amountDue: 0,
          lineItems: [{ description: 'Dog walk', qty: 1, unitCents: 2500, discountCents: 9999 }],
        }),
      ),
    ).rejects.toMatchObject({ details: { code: 'invoice_money_invalid' } });
  });

  it('records itemized/lineCount in the audit payload', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ itemized: true, lineCount: 2 }) }),
    );
  });
});
