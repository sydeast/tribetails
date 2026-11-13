import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  // #1511: what the dispatcher did to each recipient's copy (see recordPayment.test.ts).
  appOnlyUids: vi.fn<() => string[]>(),
  suppressed: vi.fn<() => Array<{ recipientUid: string; reason: 'duplicate' | 'prefs' | 'gate' }>>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
// #1511: the handler reads the detailed outcome. One counted mock answers both
// entry points, so every assertion below on `enqueue` still holds.
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: async (args: unknown) => ({
    written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
    suppressed: mocks.suppressed(),
    unresolved: [],
    appOnly: mocks.appOnlyUids(),
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => undefined } };
});

import { createQuoteHandler } from '../src/admin/createQuote';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.appOnlyUids.mockReset().mockReturnValue([]);
  mocks.suppressed.mockReset().mockReturnValue([]);
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
  // #2156: a quote now holds the visits it names, and a visit with no record is
  // refused, so the shared fixture names none. Suites about visits seed them.
  sessionIds: [] as string[],
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T18:00:00Z'));
    try {
      const ctx = buildDbMock({ docs: { 'counters/invoiceNumber': { nextPlain: 1027 } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const res = await createQuoteHandler(req({ ...validPayload, invoiceNumber: '' }));
      expect(res.ok).toBe(true);
      const written = ctx.writes.find((w) => w.path.startsWith('invoices/'));
      expect(written?.data.invoiceNumber).toBe('1027');
      expect(ctx.writes.find((w) => w.path === 'counters/invoiceNumber')?.data.nextPlain).toBe(1028);
    } finally {
      vi.useRealTimers();
    }
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
  // #2087 (operator ruling 2026-11-13): with "Send to kinfolk now" off the quote
  // is a Draft only the office sees. It becomes a Quote when it is sent.
  it('#2087 saves a quote made with the switch off as a draft carrying the quote mark, whatever status the caller sent', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'));
    expect(write).toBeTruthy();
    expect(write!.data.status).toBe('draft');
    expect(write!.data.invoiceStatus).toBe('draft');
    expect(write!.data.quoteDraft).toBe(true);
    expect(write!.data.kinfolkId).toBe('fam1');
    expect(write!.data.createdAt).toBe('__TS__');
  });

  it('persists the state stamp in the same write: a draft, fully editable', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(req(validPayload));
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    // What the classifier says about the doc as written is what the doc stores.
    expect(invoiceStateStampOf(write.data, 0)).toEqual({ status: 'draft', editScope: 'all' });
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
    const res = await createQuoteHandler(req(validPayload));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // #1511: nothing was sent, so there is no delivery to describe.
    expect(res).not.toHaveProperty('appOnly');
  });

  it('#2087 with the switch on: saved, then sent as a quote, and the household told once, after the quote is one', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    let statusWhenTold: unknown;
    mocks.enqueue.mockImplementation(async (args: { targetId: string }) => {
      statusWhenTold = (await ctx.db.doc(`invoices/${args.targetId}`).get()).data()?.status;
      return ['n1'];
    });
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'invoice.new',
        recipientUid: 'kin-uid-1',
        targetType: 'invoice',
        targetId: res.invoiceId,
        data: expect.objectContaining({ isQuote: true }),
        dedupeKey: `quote:${res.invoiceId}:send`,
      }),
    );
    // The notice went out only once the quote had committed as a quote.
    expect(statusWhenTold).toBe('quote');
    const doc = (await ctx.db.doc(`invoices/${res.invoiceId}`).get()).data()!;
    expect(doc.status).toBe('quote');
    expect(doc.invoiceStatus).toBe('quote');
    expect(doc.quoteDraft).toBeUndefined();
    expect(doc.quoteSentBy).toBe('admin1');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'BILLING_QUOTE_SENT' }));
    // #1511: a channel carried the household's copy.
    expect(res.appOnly).toBe(false);
  });

  it('#2087 a failed notice is not swallowed: the quote goes back to the hidden draft it was, and the admin is told how to send it', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const err = await createQuoteHandler(
      req({ ...validPayload, sendToKinfolk: true, idempotencyKey: 'quot_1700000002087_a' }),
    ).catch((e) => e);
    expect(err).toMatchObject({
      code: 'failed-precondition',
      details: { code: 'quote_saved_not_sent', invoiceId: 'quot_1700000002087_a' },
    });
    expect(err.message).toMatch(/saved as a draft, but it could not be sent/);
    const doc = (await ctx.db.doc('invoices/quot_1700000002087_a').get()).data()!;
    expect(doc.status).toBe('draft');
    expect(doc.invoiceStatus).toBe('draft');
    expect(doc.quoteDraft).toBe(true);
    expect(doc.quoteSentBy).toBeUndefined();
  });

  it('#2087 the retry of that same submission sends it, once, and makes no second quote', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const args = { ...validPayload, sendToKinfolk: true, idempotencyKey: 'quot_1700000002087_b' };
    await createQuoteHandler(req(args)).catch(() => undefined);
    const res = await createQuoteHandler(req(args));
    expect(res).toMatchObject({ ok: true, invoiceId: 'quot_1700000002087_b' });
    expect((await ctx.db.doc('invoices/quot_1700000002087_b').get()).data()!.status).toBe('quote');
    // One failed attempt, one that reached the household.
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(new Set(ctx.writes.filter((w) => w.path.startsWith('invoices/')).map((w) => w.path)).size).toBe(1);
    // A third press of the same submission sends nothing more.
    await createQuoteHandler(req(args));
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  // ── #1511: the quote that reached the household in the app only ────────────
  it('#1511 every channel off for the household: appOnly true', async () => {
    mocks.appOnlyUids.mockReturnValue(['kin-uid-1']);
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(res.ok).toBe(true);
    expect(res.appOnly).toBe(true);
  });

  it('#1511 the office copy having no channels is not the household copy having none', async () => {
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(res.appOnly).toBe(false);
  });

  it('#1511 no portal account: the office copy alone was written, so appOnly is omitted', async () => {
    mocks.resolveUid.mockResolvedValue(null);
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('appOnly');
  });

  it('#1511 a household copy the dispatcher held back has no delivery to describe', async () => {
    mocks.suppressed.mockReturnValue([{ recipientUid: 'kin-uid-1', reason: 'prefs' }]);
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createQuoteHandler(req({ ...validPayload, sendToKinfolk: true }));
    expect(res).not.toHaveProperty('appOnly');
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

  it('still saves a quote draft even when line items are present', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createQuoteHandler(
      req({ ...validPayload, total: 150, amountDue: 150, lineItems: twoLines }),
    );
    const write = ctx.writes.find((w) => w.path.startsWith('invoices/'))!;
    expect(write.data.status).toBe('draft');
    expect(write.data.invoiceStatus).toBe('draft');
    expect(write.data.quoteDraft).toBe(true);
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
