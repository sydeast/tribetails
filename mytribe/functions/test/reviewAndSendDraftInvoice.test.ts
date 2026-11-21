import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

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

function seed(invoice: Record<string, unknown> | null = {
  kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40,
}) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}

describe('reviewAndSendDraftInvoice happy path', () => {
  it('flips DRAFT -> open on both status fields and returns ok', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    // #1511: `appOnly: false` is the household's copy going out by a channel.
    expect(res).toEqual({ ok: true, invoiceId: 'inv1', appOnly: false });
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write?.data.status).toBe('open');
    expect(write?.data.invoiceStatus).toBe('open');
    expect(write?.data.sentBy).toBe('admin1');
    // The state stamp (ADR-0002) rides the same write: a just-sent invoice
    // with its full balance owed is open and fully editable.
    expect(write?.data.editScope).toBe('all');
  });

  it('enqueues invoice.new to the resolved kinfolk uid', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'kin-uid-1' }),
    );
  });

  it('writes a BILLING_DRAFT_INVOICE_SENT audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_DRAFT_INVOICE_SENT', targetUid: 'inv1', familyId: 'fam1' }),
    );
  });
});

describe('reviewAndSendDraftInvoice validation + sad paths', () => {
  it('rejects blank invoiceId (invalid-argument)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing invoice (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects a non-draft invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a draft with no total (failed-precondition, names what is missing)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 0 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('total'),
    });
  });

  it('rejects a draft with no household (failed-precondition)', async () => {
    const ctx = seed({ invoiceNumber: 'INV-9', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('household'),
    });
  });

  it('rejects a draft with no invoice number (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('invoice number'),
    });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails loud (does NOT swallow) when dispatch throws, and the invoice is the draft it was', async () => {
    const draft = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', invoiceStatus: 'draft', total: 40, amountDue: 40 };
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...draft } }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');
    // Every field the flip wrote is back to what the draft held, and a field
    // the draft never had (sentAt, sentBy, the state stamp) is gone again.
    const { updatedAt, ...after } = ((await ctx.db.doc('invoices/inv1').get()).data() ?? {}) as Record<string, unknown>;
    expect(updatedAt).toBe('__TS__');
    expect(after).toEqual(draft);
  });
});

/**
 * #2168 review: THE HOUSEHOLD IS TOLD ONLY ABOUT AN INVOICE IT CAN SEE. Drafts
 * are hidden from Kinfolk, so the notice goes out after the flip commits, never
 * before a check that could still keep the invoice a draft.
 */
describe('reviewAndSendDraftInvoice: the notice follows the flip', () => {
  const draft = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40 };

  it('the invoice is already open when invoice.new is dispatched', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...draft } }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const statusAtDispatch: unknown[] = [];
    mocks.enqueue.mockImplementation(async () => {
      statusAtDispatch.push((await ctx.db.doc('invoices/inv1').get()).data()?.status);
      return ['n1'];
    });
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(statusAtDispatch).toEqual(['open']);
  });

  it('two sends at once: one notice, and the second is refused before it dispatches', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...draft } }, writeThrough: true });
    // Firestore runs one transaction at a time on a contended doc and re-runs
    // the second against what the first committed.
    const inner = ctx.db.runTransaction;
    let chain: Promise<unknown> = Promise.resolve();
    ctx.db.runTransaction = (fn: any) => {
      const run = chain.then(() => inner(fn));
      chain = run.catch(() => undefined);
      return run;
    };
    mocks.dbFn.mockReturnValue(ctx.db);
    const [a, b] = await Promise.allSettled([
      reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' })),
      reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' })),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const refused = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'failed-precondition', message: 'Invoice is not a draft; nothing to send.' });
  });

  it('a notice that fails after a payment landed is not undone, and the error says the household was not told', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...draft } }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockImplementationOnce(async () => {
      await ctx.db.doc('invoices/inv1/payments/p1').set({ amountCents: 4000 });
      throw new Error('boom');
    });
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'internal',
      message: 'The invoice was sent, but the household could not be told about it. Use Send reminder to tell them.',
      details: { code: 'invoice_sent_not_announced' },
    });
    expect((await ctx.db.doc('invoices/inv1').get()).data()?.status).toBe('open');
  });
});

/**
 * ISSUE #409: the moment a draft becomes a bill is the moment its payment
 * options are frozen onto it.
 *
 * Operator ruling: turning a method off stops offering it on NEW invoices,
 * while invoices already issued keep working. That promise is kept by this
 * write and nothing else, so this is where it is tested.
 */
describe('reviewAndSendDraftInvoice payment options snapshot (issue #409)', () => {
  it('freezes the live payment options onto the invoice, in the same write as the flip', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40 },
        'business_settings/business_settings': {
          venmoHandle: '@auntie',
          paymentOptions: { cashapp: { enabled: false }, cash: { enabled: true, instructions: 'Exact change please.' } },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write?.data.status).toBe('open');
    const snapshot = write?.data.payMethodSettingsSnapshot as any;
    expect(snapshot.venmoHandle).toBe('@auntie');
    expect(snapshot.paymentOptions.cashapp).toEqual({ enabled: false });
    expect(snapshot.paymentOptions.cash).toEqual({ enabled: true, instructions: 'Exact change please.' });
    expect(typeof snapshot.capturedAt).toBe('string');
  });

  it('sends the invoice anyway when the settings doc cannot be read', async () => {
    // The bill is the deliverable. A missing snapshot means the portal falls
    // back to live settings, which is what every invoice did before this
    // shipped, so there is nothing here worth failing a send over.
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1', appOnly: false });
  });
});

describe('#1511 reviewAndSendDraftInvoice says when the household got it in the app only', () => {
  it('every channel off for the household: appOnly true, and the draft still flips to open', async () => {
    mocks.appOnlyUids.mockReturnValue(['kin-uid-1']);
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1', appOnly: true });
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data.status).toBe('open');
  });

  it('the office copy having no channels is not the household copy having none', async () => {
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res.appOnly).toBe(false);
  });

  it('no portal account: only the office copy exists, so the answer omits appOnly', async () => {
    mocks.resolveUid.mockResolvedValue(null);
    // Even an office roster with every channel off must not read as the household's answer.
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1' });
  });

  it("a household copy the dispatcher held back has no delivery to describe, so appOnly is omitted", async () => {
    mocks.suppressed.mockReturnValue([{ recipientUid: 'kin-uid-1', reason: 'gate' }]);
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1' });
  });
});
/**
 * #2246: a draft made Monday and sent Thursday goes out dated Thursday and due
 * by its terms counted from Thursday, not already overdue.
 */
describe('#2246 the send dates the bill the day it goes out', () => {
  // 9 PM Thursday Nov 19 in Chicago, already Friday in UTC.
  const THURSDAY_EVENING = new Date('2026-11-20T03:00:00.000Z');
  const monday = {
    kinfolkId: 'fam1',
    invoiceNumber: 'INV-9',
    status: 'draft',
    total: 40,
    amountDue: 40,
    date: '2026-11-16',
    dueDate: '2026-11-16',
    termsCode: 'due_on_receipt',
    terms: 'Due on receipt',
  };
  const settings = { 'business_settings/business_settings': { timeZone: 'America/Chicago' } };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(THURSDAY_EVENING);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('due on receipt: dated and due Thursday on the business clock, in the same write as the flip', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...monday }, ...settings } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1')!;
    expect(write.data).toMatchObject({
      status: 'open',
      date: '2026-11-19',
      dueDate: '2026-11-19',
      termsCode: 'due_on_receipt',
      terms: 'Due on receipt',
    });
  });
  it('visit terms are counted from the visits it bills, and floored at the send day', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': {
          ...monday,
          termsCode: 'net_3_after_last_visit',
          sessionIds: ['s1'],
          lineItems: [{ description: 'Walk', qty: 1, unitCents: 4000, sessionId: 's2' }],
        },
        'kin_care_sessions/s1': { kinfolkId: 'fam1', invoiceId: 'inv1', status: 'COMPLETED', startTime: '2026-11-10T15:00:00Z' },
        'kin_care_sessions/s2': { kinfolkId: 'fam1', invoiceId: 'inv1', status: 'COMPLETED', startTime: '2026-11-18T15:00:00Z' },
        ...settings,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1')!;
    // The last visit is Nov 18, so 3 days on is Nov 21.
    expect(write.data).toMatchObject({ date: '2026-11-19', dueDate: '2026-11-21', termsCode: 'net_3_after_last_visit' });
  });
  it('a due date picked by hand that has passed refuses the send: nothing written, nobody told', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv1': { ...monday, termsCode: 'custom', dueDate: '2026-11-18' }, ...settings },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Change the due date in Edit, then send it.'),
      details: { code: 'invoice_due_before_send' },
    });
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('a due date picked by hand still ahead is kept; only the date moves', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv1': { ...monday, termsCode: 'custom', dueDate: '2026-11-30' }, ...settings },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1')!;
    expect(write.data['date']).toBe('2026-11-19');
    expect('dueDate' in write.data).toBe(false);
  });
  it('a failed notice puts the draft back with its own date, due date and terms', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...monday, termsCode: 'net_7', terms: 'Due 7 days after the invoice date', dueDate: '2026-11-23' }, ...settings }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');
    const back = (await ctx.db.doc('invoices/inv1').get()).data()!;
    expect(back).toMatchObject({
      status: 'draft',
      date: '2026-11-16',
      dueDate: '2026-11-23',
      termsCode: 'net_7',
      terms: 'Due 7 days after the invoice date',
    });
  });
  it('a quote saved unsent goes out as a quote with its own date untouched', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { ...monday, quoteDraft: true }, ...settings } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1')!;
    expect(write.data['status']).toBe('quote');
    expect('date' in write.data).toBe(false);
    expect('dueDate' in write.data).toBe(false);
  });
});
