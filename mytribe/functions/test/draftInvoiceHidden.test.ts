import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1906 / #2159 (operator ruling 2026-11-11): an invoice the office has not
 * sent is not listed, counted or openable for the Kinfolk. #2225 hid the quote
 * drafts; this pins the rule for EVERY unsent draft, on every household read:
 *
 *   getMyInvoices      list, buckets, totals; the detail page and any deep
 *                      link open from this answer
 *   getMyHome          Balance due (`openBalanceCentsOf`)
 *   getMyInvoicePdf    the PDF
 *   payInvoice         no checkout for it
 *   redeemCredit       no credit taken from it
 *   acceptQuote/deny   answered as a quote that does not exist
 *   getMyBookings      a completed visit's invoice link (`loadVisitExtras`)
 *
 * The harness is `quoteLifecycle.test.ts`'s: the admin creates a real draft
 * through `createInvoice`, and sending it through `reviewAndSendDraftInvoice`
 * is what makes it the household's.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  checkoutCreate: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/invoicePdf', () => ({ generateAndStoreInvoicePdf: vi.fn().mockResolvedValue('https://pdf.example/x') }));
vi.mock('../src/lib/stripe', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.checkoutCreate,
        retrieve: vi.fn(async () => {
          throw new Error('No such checkout.session');
        }),
      },
    },
  }),
}));
vi.mock('../src/notifications/dispatcher', () => ({
  NOTIFICATION_DEDUPE_WINDOW_MS: 5 * 60 * 1000,
  lastDeliveredAtMs: vi.fn().mockResolvedValue(null),
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
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      delete: () => undefined,
      increment: (n: number) => n,
      arrayUnion: (...v: unknown[]) => v,
    },
  };
});

import { createInvoiceHandler } from '../src/admin/createInvoice';
import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
import { acceptQuoteHandler, denyQuoteHandler, quoteDecisionRefusal } from '../src/portal/quoteDecision';
import { getMyInvoicesHandler, openBalanceCentsOf } from '../src/portal/getMyInvoices';
import { getMyInvoicePdfHandler } from '../src/portal/getMyInvoicePdf';
import { payInvoiceHandler } from '../src/portal/payInvoice';
import { redeemCreditHandler } from '../src/portal/redeemCredit';
import { loadVisitExtras } from '../src/lib/portalVisitLinks';
import { hiddenFromHousehold } from '../src/lib/quoteDecision';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('u1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.checkoutCreate.mockReset().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.example/cs_1', client_secret: null });
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

function admin(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** The Kinfolk PRIMARY in MyTribe. */
function kinfolk(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'u1', token: {} } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const visit = (extra: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  status: 'COMPLETED',
  serviceType: '30Minute',
  startTime: '2026-06-02T14:00:00.000Z',
  ...extra,
});

function world(extra: Record<string, Record<string, unknown>> = {}) {
  const ctx = buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['fam1'] },
      'families/fam1': { displayName: 'Test Household', accountBalanceCents: 0 },
      'families/fam1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      'business_settings/business_settings': { timeZone: 'America/Chicago', householdNotificationsLive: true },
      'counters/invoiceNumber': { nextPlain: 1040 },
      'kin_care_sessions/s1': visit(),
      ...extra,
    },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

async function docOf(ctx: ReturnType<typeof buildDbMock>, path: string): Promise<Record<string, unknown>> {
  return ((await ctx.db.doc(path).get()).data() ?? {}) as Record<string, unknown>;
}

let keyN = 0;
/** "Save as draft" on the New invoice composer: $28.00 for visit s1, not sent. */
async function draftInvoice(): Promise<string> {
  keyN += 1;
  const { invoiceId } = await createInvoiceHandler(
    admin({
      familyId: 'fam1',
      kinfolkName: 'Test Household',
      client: 'Test Household',
      date: '2026-06-10',
      terms: '',
      dueDate: '2026-06-24',
      total: 28,
      amountDue: 28,
      status: 'draft',
      sessionIds: ['s1'],
      lineItems: [{ description: '30 Minute Quick Check', qty: 1, unitCents: 2800, sessionId: 's1' }],
      idempotencyKey: `inv_17000000019${String(keyN).padStart(2, '0')}_d`,
    }),
  );
  return invoiceId;
}

async function portalIds(): Promise<string[]> {
  const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
  return [...res.open, ...res.paid, ...res.credits].map((i) => i.id);
}

const payArgs = (invoiceId: string) => ({
  invoiceId,
  kinfolkId: 'fam1',
  successUrl: 'https://portal.example/invoices/x',
  cancelUrl: 'https://portal.example/invoices/x',
});

describe('#1906 an unsent draft invoice is the office\'s alone', () => {
  it('is stored as a draft and nobody is told', async () => {
    const ctx = world();
    const id = await draftInvoice();
    const doc = await docOf(ctx, `invoices/${id}`);
    expect(doc['status']).toBe('draft');
    expect(hiddenFromHousehold(doc)).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('is not listed, and is in no bucket, total or count', async () => {
    world();
    await draftInvoice();
    const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
    expect(res.open).toHaveLength(0);
    expect(res.paid).toHaveLength(0);
    expect(res.credits).toHaveLength(0);
  });

  it('has no PDF: it answers exactly as an invoice that does not exist', async () => {
    world();
    const id = await draftInvoice();
    const missing = await getMyInvoicePdfHandler(kinfolk({ invoiceId: 'no-such-invoice', kinfolkId: 'fam1' })).catch(
      (e: unknown) => e,
    );
    const hidden = await getMyInvoicePdfHandler(kinfolk({ invoiceId: id, kinfolkId: 'fam1' })).catch((e: unknown) => e);
    expect(hidden).toMatchObject({ code: 'not-found' });
    expect((missing as { code: string }).code).toBe((hidden as { code: string }).code);
  });

  it('takes no payment and opens no checkout, answering as a missing invoice', async () => {
    const ctx = world();
    const id = await draftInvoice();
    const before = ctx.writes.length;
    await expect(payInvoiceHandler(kinfolk(payArgs(id)))).rejects.toMatchObject({
      code: 'not-found',
      message: 'Invoice not found.',
    });
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(ctx.writes.length).toBe(before);
  });

  it('cannot be answered as a quote: it reads as a quote that does not exist', async () => {
    const ctx = world();
    const id = await draftInvoice();
    const before = ctx.writes.length;
    for (const call of [acceptQuoteHandler, denyQuoteHandler]) {
      await expect(call(kinfolk({ invoiceId: id }))).rejects.toMatchObject({
        code: 'not-found',
        details: { code: 'quote_not_found' },
      });
    }
    expect(ctx.writes.length).toBe(before);
  });

  it('#2159 gives its visit no invoice link', async () => {
    const ctx = world();
    await draftInvoice();
    const extras = await loadVisitExtras(ctx.db as any, 'fam1', { wantLinks: true, billingAccess: true });
    expect(extras.invoiceBySession.get('s1')).toBeUndefined();
  });

  it('once sent, is listed as open, payable, and linked from its visit', async () => {
    const ctx = world();
    const id = await draftInvoice();
    await reviewAndSendDraftInvoiceHandler(admin({ invoiceId: id }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
    expect(res.open.map((i) => [i.id, i.status])).toEqual([[id, 'open']]);
    const extras = await loadVisitExtras(ctx.db as any, 'fam1', { wantLinks: true, billingAccess: true });
    expect(extras.invoiceBySession.get('s1')).toBe(id);
    await expect(getMyInvoicePdfHandler(kinfolk({ invoiceId: id, kinfolkId: 'fam1' }))).resolves.toBeTruthy();
    await expect(payInvoiceHandler(kinfolk(payArgs(id)))).resolves.toMatchObject({ sessionId: 'cs_1' });
  });
});

describe('#1906 a draft carrying a credit cannot be redeemed', () => {
  it('answers as a missing invoice and moves no money', async () => {
    const ctx = world({
      'invoices/c-draft': { kinfolkId: 'fam1', status: 'draft', invoiceStatus: 'draft', amountDue: -25, total: -25 },
    });
    await expect(
      redeemCreditHandler(kinfolk({ invoiceId: 'c-draft', kinfolkId: 'fam1', target: 'accountBalance' }) as any),
    ).rejects.toMatchObject({ code: 'not-found', message: 'Invoice not found.' });
    expect(ctx.writes.find((w) => w.path === 'families/fam1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'invoices/c-draft')).toBeUndefined();
  });
});

describe('#1906 hiddenFromHousehold: the one rule', () => {
  it('hides every draft, in either status spelling, any case or spacing', () => {
    expect(hiddenFromHousehold({ status: 'draft' })).toBe(true);
    expect(hiddenFromHousehold({ invoiceStatus: 'draft' })).toBe(true);
    expect(hiddenFromHousehold({ status: ' DRAFT ' })).toBe(true);
    expect(hiddenFromHousehold({ status: 'draft', archivedAt: '__TS__' })).toBe(true);
    // The quote drafts #2225 hid stay hidden.
    expect(hiddenFromHousehold({ status: 'draft', quoteDraft: true })).toBe(true);
    expect(hiddenFromHousehold({ status: 'draft', quoteConvertedAt: '__TS__' })).toBe(true);
  });

  it('hides an archived quote, and nothing that has been sent', () => {
    expect(hiddenFromHousehold({ status: 'quote', archivedAt: '__TS__' })).toBe(true);
    for (const status of ['open', 'quote', 'paid', 'zero', 'credit', 'redeemed', 'cancelled']) {
      expect(hiddenFromHousehold({ status })).toBe(false);
    }
    // The canonical field wins, exactly as `statusFromStamp` reads it.
    expect(hiddenFromHousehold({ status: 'open', invoiceStatus: 'draft' })).toBe(false);
  });

  it('the quote answer reads any draft as missing', () => {
    expect(quoteDecisionRefusal({ status: 'draft' })?.code).toBe('quote_not_found');
    expect(quoteDecisionRefusal({ invoiceStatus: 'draft', archivedAt: '__TS__' })?.code).toBe('quote_not_found');
  });
});

describe('#1906 Home Balance due counts no draft', () => {
  it('counts only open invoices with something due', () => {
    expect(
      openBalanceCentsOf([
        { status: 'open', amountDueCents: 1950, total: 19.5 },
        { status: 'draft', amountDueCents: 2800, total: 28 },
        { invoiceStatus: 'draft', amountDue: 28, total: 28 },
      ]),
    ).toBe(1950);
  });
});

describe('#1906 a portal read sees what the household sees, with nothing else on the books', () => {
  it('lists the sent invoice and leaves the draft out', async () => {
    world({
      'invoices/sent': { kinfolkId: 'fam1', status: 'open', amountDue: 19.5, total: 19.5, dueDate: '2026-06-24' },
      'invoices/unsent': { kinfolkId: 'fam1', status: 'draft', amountDue: 28, total: 28, dueDate: '2026-06-24' },
    });
    expect(await portalIds()).toEqual(['sent']);
  });
});
