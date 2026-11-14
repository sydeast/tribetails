import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * The life of a quote once it exists (#2087, #2088, #2195).
 *
 *   #2087 (operator ruling 2026-11-13): a quote saved with "Send to kinfolk
 *         now" off is a Draft only the office sees. MyTribe does not list,
 *         count or open it, and it cannot be accepted. It becomes a Quote when
 *         the office sends it, and the household is told once, after that.
 *   #2088 (operator ruling 2026-11-12): a quote is an invoice status with no
 *         expiry. Once it exists the office can send it, turn it into an
 *         invoice (it keeps its visits) or withdraw it (its visits go back on
 *         the list, as on a decline).
 *   #2195 (lead ruling 2026-11-13): archiving a quote works like archiving a
 *         draft. The household stops seeing it, it cannot be answered, its
 *         visits go back on the list; restoring it takes back only the free
 *         ones and says which it could not.
 *
 * Every check, claim and status flip is one transaction, so an Accept racing
 * an office change gives one winner. The harness is `quoteHoldsVisits.test.ts`'s.
 */

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
vi.mock('../src/lib/invoicePdf', () => ({ generateAndStoreInvoicePdf: vi.fn().mockResolvedValue('https://pdf.example/x') }));
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
    },
  };
});

import { createQuoteHandler } from '../src/admin/createQuote';
import { createInvoiceHandler } from '../src/admin/createInvoice';
import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
import { postInvoiceEventHandler } from '../src/admin/postInvoiceEvent';
import {
  convertQuoteToInvoiceHandler,
  withdrawQuoteHandler,
  quoteActionAlreadyDone,
  quoteActionRefusal,
} from '../src/admin/quoteActions';
import { archiveInvoiceHandler } from '../src/admin/archiveInvoice';
import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { unarchiveInvoiceHandler } from '../src/admin/unarchiveInvoice';
import { acceptQuoteHandler, denyQuoteHandler } from '../src/portal/quoteDecision';
import { getMyInvoicesHandler } from '../src/portal/getMyInvoices';
import { getMyInvoicePdfHandler } from '../src/portal/getMyInvoicePdf';
import { loadVisitExtras } from '../src/lib/portalVisitLinks';
import { hiddenFromHousehold } from '../src/lib/quoteDecision';
import { isSessionBillable } from '../src/lib/sessionInvoicing';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('u1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
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

const line = (sessionId: string) => ({ description: '30 Minute Quick Check', qty: 1, unitCents: 4500, sessionId });

const composerQuote = (sessionIds: string[], extra: Record<string, unknown> = {}) => {
  const lineItems = sessionIds.map(line);
  const total = (lineItems.length * 4500) / 100;
  return {
    familyId: 'fam1',
    kinfolkName: 'Test Household',
    client: 'Test Household',
    date: '2026-06-10',
    terms: '',
    // A due date long gone: a quote does not expire (#2088).
    dueDate: '2020-01-01',
    total,
    amountDue: total,
    status: '',
    sessionIds,
    lineItems,
    ...extra,
  };
};

function world(extra: Record<string, Record<string, unknown>> = {}) {
  const ctx = buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['fam1'] },
      'families/fam1': { displayName: 'Test Household' },
      'families/fam1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      'business_settings/business_settings': { timeZone: 'America/Chicago', householdNotificationsLive: true },
      'counters/invoiceNumber': { nextPlain: 1040 },
      'kin_care_sessions/s1': visit(),
      'kin_care_sessions/s2': visit({ startTime: '2026-06-03T14:00:00.000Z' }),
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

function serializeTransactions(ctx: ReturnType<typeof buildDbMock>) {
  const inner = ctx.db.runTransaction;
  let chain: Promise<unknown> = Promise.resolve();
  ctx.db.runTransaction = (fn: any) => {
    const run = chain.then(() => inner(fn));
    chain = run.catch(() => undefined);
    return run;
  };
}

let keyN = 0;
/** A quote saved with "Send to kinfolk now" off: a draft only the office sees. */
async function unsentQuote(sessionIds: string[] = ['s1']): Promise<string> {
  keyN += 1;
  const { invoiceId } = await createQuoteHandler(
    admin({ ...composerQuote(sessionIds), idempotencyKey: `quot_17000000020${String(keyN).padStart(2, '0')}_x` }),
  );
  return invoiceId;
}

/** A quote saved with the switch on: sent, so the household can answer it. */
async function sentQuote(sessionIds: string[] = ['s1']): Promise<string> {
  keyN += 1;
  const { invoiceId } = await createQuoteHandler(
    admin({
      ...composerQuote(sessionIds),
      idempotencyKey: `quot_17000000021${String(keyN).padStart(2, '0')}_y`,
      sendToKinfolk: true,
    }),
  );
  return invoiceId;
}

async function portalIds(): Promise<string[]> {
  const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
  return [...res.open, ...res.paid, ...res.credits].map((i) => i.id);
}

// ── #2087: an unsent quote is the office's alone ───────────────────────────

describe('#2087 a quote saved unsent is invisible to the Kinfolk everywhere', () => {
  it('is not listed or counted, does not open, has no PDF and no visit link', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(hiddenFromHousehold(await docOf(ctx, `invoices/${quoteId}`))).toBe(true);

    // List and every count are built from this one answer; the detail page
    // opens from it too, so a deep link to the id finds nothing.
    const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
    expect([...res.open, ...res.paid, ...res.credits]).toHaveLength(0);
    await expect(getMyInvoicePdfHandler(kinfolk({ invoiceId: quoteId, kinfolkId: 'fam1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    const extras = await loadVisitExtras(ctx.db as any, 'fam1', { wantLinks: true, billingAccess: true });
    expect(extras.invoiceBySession.get('s1')).toBeUndefined();
  });

  it('cannot be accepted or declined: it answers as a quote that does not exist, and nothing is written', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    const before = ctx.writes.length;
    for (const call of [acceptQuoteHandler, denyQuoteHandler]) {
      await expect(call(kinfolk({ invoiceId: quoteId }))).rejects.toMatchObject({
        code: 'not-found',
        message: 'Quote not found.',
        details: { code: 'quote_not_found' },
      });
    }
    expect(ctx.writes.length).toBe(before);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
  });

  it('Send makes it a Quote the household can see and answer, and tells them once, after it commits', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    let statusWhenTold: unknown;
    mocks.enqueue.mockImplementation(async () => {
      statusWhenTold = (await docOf(ctx, `invoices/${quoteId}`))['status'];
      return ['n1'];
    });
    await reviewAndSendDraftInvoiceHandler(admin({ invoiceId: quoteId }));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      key: 'invoice.new',
      data: { isQuote: true },
      dedupeKey: `quote:${quoteId}:send`,
    });
    expect(statusWhenTold).toBe('quote');
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['status']).toBe('quote');
    expect(q['quoteDraft']).toBeUndefined();
    // Still holding its visit, not billing it.
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
    expect(res.open.map((i) => [i.id, i.status])).toEqual([[quoteId, 'quote']]);

    // A second press is refused in a quote's words, and tells nobody again.
    await expect(reviewAndSendDraftInvoiceHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_already_sent' },
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    await expect(acceptQuoteHandler(kinfolk({ invoiceId: quoteId }))).resolves.toMatchObject({ status: 'open' });
  });

  it('a failed notice puts it back to the hidden draft it was, exactly', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    const before = await docOf(ctx, `invoices/${quoteId}`);
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    await expect(reviewAndSendDraftInvoiceHandler(admin({ invoiceId: quoteId }))).rejects.toThrow('dispatcher down');
    const after = await docOf(ctx, `invoices/${quoteId}`);
    for (const k of ['status', 'invoiceStatus', 'quoteDraft', 'editScope', 'sessionIds']) {
      expect(after[k]).toEqual(before[k]);
    }
    expect('quoteSentBy' in after).toBe(false);
    expect('quoteSentAt' in after).toBe(false);
    expect(await portalIds()).toEqual([]);
  });

  it('an older admin app sending it through postInvoiceEvent sends a quote, never a bill', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    await postInvoiceEventHandler(admin({ familyId: 'fam1', invoiceId: quoteId, payload: { status: 'sent' } }));
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['status']).toBe('quote');
    expect(q['quoteDecision']).toBeUndefined();
  });
});

// ── #2088: turn into an invoice, withdraw ──────────────────────────────────

describe('#2088 turning a quote into an invoice keeps its visits', () => {
  it('a sent quote becomes a draft invoice the household cannot see until it is sent, holding the same visits', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1', 's2']);
    mocks.enqueue.mockClear();
    const res = await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(res).toEqual({ ok: true, invoiceId: quoteId, status: 'draft' });
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const inv = await docOf(ctx, `invoices/${quoteId}`);
    expect(inv['status']).toBe('draft');
    expect(inv['invoiceStatus']).toBe('draft');
    expect(inv['quoteConvertedBy']).toBe('admin1');
    expect(inv['sessionIds']).toEqual(['s1', 's2']);
    for (const sid of ['s1', 's2']) expect((await docOf(ctx, `kin_care_sessions/${sid}`))['invoiceId']).toBe(quoteId);
    expect(await portalIds()).toEqual([]);
    await expect(acceptQuoteHandler(kinfolk({ invoiceId: quoteId }))).rejects.toMatchObject({ code: 'not-found' });
    expect((writeAuditEntry as any).mock.calls.some((c: any[]) => c[0].event === 'BILLING_QUOTE_CONVERTED')).toBe(true);

    // Money becomes owed only through the ordinary draft send, which tells the
    // household about an INVOICE.
    await reviewAndSendDraftInvoiceHandler(admin({ invoiceId: quoteId }));
    expect((await docOf(ctx, `invoices/${quoteId}`))['status']).toBe('open');
    expect(mocks.enqueue.mock.calls[0][0].data).not.toHaveProperty('isQuote');
    const portal = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }) as any);
    expect(portal.open.map((i) => [i.id, i.status])).toEqual([[quoteId, 'open']]);
  });

  it('a quote saved unsent turns into a plain draft invoice', async () => {
    const ctx = world();
    const quoteId = await unsentQuote();
    await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));
    const inv = await docOf(ctx, `invoices/${quoteId}`);
    expect(inv['status']).toBe('draft');
    expect(inv['quoteDraft']).toBeUndefined();
  });

  it('a declined quote takes its free visits back, and its answer is cleared', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);

    await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));
    const inv = await docOf(ctx, `invoices/${quoteId}`);
    expect(inv['quoteDecision']).toBeUndefined();
    expect(inv['sessionIds']).toEqual(['s1']);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
  });

  it('refuses, by the visit day and never an id, when a declined quote line is billed on another invoice since', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const { invoiceId: other } = await createInvoiceHandler(
      admin({ ...composerQuote(['s1'], { dueDate: '' }), status: 'draft', idempotencyKey: 'inv_1700000002088_c' }),
    );
    const number = (await docOf(ctx, `invoices/${other}`))['invoiceNumber'];
    const before = ctx.writes.length;
    const err = await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId })).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: 'quote_visits_not_billable' } });
    expect(err.message).toBe(
      `This quote cannot be turned into an invoice: the visit on 2026-06-02 is billed on invoice ${String(number)}. Remove its line in Edit, then try again.`,
    );
    expect(err.message).not.toContain(other);
    expect(ctx.writes.length).toBe(before);
  });

  it('refuses an accepted quote, which is an invoice already', async () => {
    world();
    const quoteId = await sentQuote();
    await acceptQuoteHandler(kinfolk({ invoiceId: quoteId }));
    await expect(convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_accepted_locked' },
    });
    await expect(withdrawQuoteHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_accepted_locked' },
    });
  });

  it('refuses an ordinary invoice', () => {
    expect(quoteActionRefusal({ status: 'open' }, 'convert')?.code).toBe('quote_not_a_quote');
    expect(quoteActionRefusal({ status: 'draft' }, 'withdraw')?.code).toBe('quote_not_a_quote');
    expect(quoteActionRefusal({ status: 'draft', quoteDraft: true }, 'withdraw')).toBeNull();
  });
});

describe('#2088 withdrawing a quote releases its visits like a decline', () => {
  it('cancels it, puts every visit back on the list, and the household can no longer see or answer it', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1', 's2']);
    mocks.enqueue.mockClear();
    const res = await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    expect(res).toEqual({ ok: true, invoiceId: quoteId, status: 'cancelled', releasedSessionIds: ['s1', 's2'] });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    for (const sid of ['s1', 's2']) expect(isSessionBillable(await docOf(ctx, `kin_care_sessions/${sid}`))).toBe(true);
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['status']).toBe('cancelled');
    expect(q['sessionIds']).toEqual([]);
    expect(q['releasedSessionIds']).toEqual(['s1', 's2']);
    expect(await portalIds()).toEqual([]);
    // Its PDF is no longer served either: a withdrawn quote is hidden like the
    // quote itself, so a link kept from before answers as a missing one, in
    // words with no id in them.
    expect(hiddenFromHousehold(q)).toBe(true);
    const pdfErr = await getMyInvoicePdfHandler(kinfolk({ invoiceId: quoteId, kinfolkId: 'fam1' })).catch((e) => e);
    expect(pdfErr).toMatchObject({ code: 'not-found', message: 'That invoice or quote is no longer available.' });
    const extras = await loadVisitExtras(ctx.db as any, 'fam1', { wantLinks: true, billingAccess: true });
    expect(extras.invoiceBySession.size).toBe(0);
    await expect(acceptQuoteHandler(kinfolk({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_withdrawn' },
    });
    // A released visit can go on a New invoice straight after.
    const { invoiceId } = await createInvoiceHandler(
      admin({ ...composerQuote(['s1'], { dueDate: '' }), status: 'draft', idempotencyKey: 'inv_1700000002088_w' }),
    );
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(invoiceId);
    // Withdrawn is final as a quote: it cannot be turned into an invoice.
    const err = await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId })).catch((e) => e);
    expect(err).toMatchObject({ details: { code: 'quote_not_a_quote' } });
    expect(err.message).toBe('This quote was withdrawn, so it cannot be turned into an invoice.');
  });

  it('a withdrawn quote takes no visit back: Link visits is refused, and Edit is closed', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    const before = ctx.writes.length;
    await expect(
      linkInvoiceSessionsHandler(admin({ invoiceId: quoteId, sessionIds: ['s1'] })),
    ).rejects.toMatchObject({ details: { code: 'quote_withdrawn_holds_no_visits' } });
    await expect(
      updateInvoiceHandler(admin({ invoiceId: quoteId, patch: { lineItems: [line('s1'), line('s2')] } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes.length).toBe(before);
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
  });
  it('a declined quote withdrawn loses its answer, so no client offers Revise and resend beside CANCELLED', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['status']).toBe('cancelled');
    expect(q['quoteDecision']).toBeUndefined();
    const audit = (writeAuditEntry as any).mock.calls.find((c: any[]) => c[0].event === 'BILLING_QUOTE_WITHDRAWN');
    expect(audit?.[0].payload.clearedDecision).toBe('denied');
  });
  it('a quote saved unsent is withdrawn the same way', async () => {
    const ctx = world();
    const quoteId = await unsentQuote(['s1']);
    await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
  });

  it('a withdrawn quote can be archived without the money-owed warning', async () => {
    world();
    const quoteId = await sentQuote();
    await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    await expect(archiveInvoiceHandler(admin({ invoiceId: quoteId }))).resolves.toMatchObject({ ok: true });
  });

  it('an archived quote is read-only: neither change is made until it is restored', async () => {
    world();
    const quoteId = await sentQuote();
    await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    for (const call of [convertQuoteToInvoiceHandler, withdrawQuoteHandler]) {
      await expect(call(admin({ invoiceId: quoteId }))).rejects.toMatchObject({ details: { code: 'invoice_archived' } });
    }
  });
});

describe('a retry of Turn into invoice or Withdraw that already succeeded answers success', () => {
  it('withdraw twice: the second answers ok with the same visits, and writes and records nothing', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1', 's2']);
    const first = await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    const writes = ctx.writes.length;
    (writeAuditEntry as any).mockClear();

    const again = await withdrawQuoteHandler(admin({ invoiceId: quoteId }));

    expect(again).toEqual(first);
    expect(again).toEqual({ ok: true, invoiceId: quoteId, status: 'cancelled', releasedSessionIds: ['s1', 's2'] });
    expect(ctx.writes.length).toBe(writes);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('convert twice: the second answers ok with the draft it became, and writes and records nothing', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    const first = await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));
    const writes = ctx.writes.length;
    (writeAuditEntry as any).mockClear();

    const again = await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));

    expect(again).toEqual(first);
    expect(again).toEqual({ ok: true, invoiceId: quoteId, status: 'draft' });
    expect(ctx.writes.length).toBe(writes);
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
  });

  it('a converted quote cannot be withdrawn, and says what it became', async () => {
    world();
    const quoteId = await sentQuote(['s1']);
    await convertQuoteToInvoiceHandler(admin({ invoiceId: quoteId }));
    const err = await withdrawQuoteHandler(admin({ invoiceId: quoteId })).catch((e) => e);
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: 'quote_not_a_quote' } });
    expect(err.message).toBe('This quote was turned into an invoice, so there is no quote left to withdraw.');
  });

  it('an invoice that was never a quote is still refused', () => {
    expect(quoteActionAlreadyDone({ status: 'draft' }, 'convert')).toBe(false);
    expect(quoteActionAlreadyDone({ status: 'cancelled' }, 'withdraw')).toBe(false);
    expect(quoteActionAlreadyDone({ status: 'draft', quoteConvertedAt: 'ts' }, 'convert')).toBe(true);
    expect(quoteActionAlreadyDone({ status: 'cancelled', quoteWithdrawnAt: 'ts' }, 'withdraw')).toBe(true);
  });
});

describe('#2088 an Accept racing an office change: one winner', () => {
  for (const [name, change] of [
    ['withdraw', withdrawQuoteHandler],
    ['turn into an invoice', convertQuoteToInvoiceHandler],
    ['archive', archiveInvoiceHandler],
  ] as const) {
    it(`accept vs ${name}`, async () => {
      const ctx = world();
      const quoteId = await sentQuote(['s1']);
      serializeTransactions(ctx);
      const [accepted, changed] = await Promise.allSettled([
        acceptQuoteHandler(kinfolk({ invoiceId: quoteId })),
        change(admin({ invoiceId: quoteId })),
      ]);
      expect([accepted, changed].filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const q = await docOf(ctx, `invoices/${quoteId}`);
      const owner = (await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId'];
      if (accepted.status === 'fulfilled') {
        // The household's yes stands: an open bill that bills its visit.
        expect(q['status']).toBe('open');
        expect(q['quoteDecision']).toBe('accepted');
        expect(owner).toBe(quoteId);
      } else {
        expect(q['quoteDecision']).toBeUndefined();
        expect(q['status']).not.toBe('open');
      }
    });
  }

  it('with the Accept arriving first, the change is refused and the bill stands', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await acceptQuoteHandler(kinfolk({ invoiceId: quoteId }));
    await expect(withdrawQuoteHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_accepted_locked' },
    });
    // An accepted quote is an open invoice with money owed: the owed-invoice
    // archive rule applies (#2090), not the quote's.
    await expect(archiveInvoiceHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'invoice_still_owing' },
    });
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
  });

  it('with the change arriving first, the Accept is refused in household words and nothing is billed', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await withdrawQuoteHandler(admin({ invoiceId: quoteId }));
    const err = await acceptQuoteHandler(kinfolk({ invoiceId: quoteId })).catch((e) => e);
    expect(err.details).toMatchObject({ code: 'quote_withdrawn' });
    expect(err.message).toMatch(/^Your Auntie withdrew this quote/);
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
  });
});

// ── #2195: archive and restore ─────────────────────────────────────────────

describe('#2195 archiving a quote works like archiving a draft', () => {
  it('the household stops seeing it, it cannot be answered, and its visits go back on the list', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1', 's2']);
    expect(await portalIds()).toEqual([quoteId]);

    const res = await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(res.releasedSessionIds).toEqual(['s1', 's2']);
    for (const sid of ['s1', 's2']) expect(isSessionBillable(await docOf(ctx, `kin_care_sessions/${sid}`))).toBe(true);
    expect(await portalIds()).toEqual([]);
    await expect(getMyInvoicePdfHandler(kinfolk({ invoiceId: quoteId, kinfolkId: 'fam1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    for (const call of [acceptQuoteHandler, denyQuoteHandler]) {
      await expect(call(kinfolk({ invoiceId: quoteId }))).rejects.toMatchObject({
        details: { code: 'quote_archived' },
      });
    }
  });

  it('restoring takes back only the visits still free, names the rest by day and number, and shows it again', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1', 's2']);
    await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    const { invoiceId: other } = await createInvoiceHandler(
      admin({ ...composerQuote(['s2'], { dueDate: '' }), status: 'draft', idempotencyKey: 'inv_1700000002195_r' }),
    );
    const number = (await docOf(ctx, `invoices/${other}`))['invoiceNumber'];

    const res = await unarchiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(res.reclaimedSessionIds).toEqual(['s1']);
    expect(res.notReclaimed).toEqual([{ sessionId: 's2', reason: 'on_other_invoice', invoiceNumber: String(number) }]);
    expect(res.notice).toBe(
      `1 visit could not be taken back: the visit on 2026-06-03 is now on invoice ${String(number)}. Its line is still on this quote, so remove it in Edit.`,
    );
    expect(res.notice).not.toContain(other);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    expect((await docOf(ctx, 'kin_care_sessions/s2'))['invoiceId']).toBe(other);
    expect(await portalIds()).toContain(quoteId);
    // Accepting it now would bill s2 twice, so it is refused until the line goes.
    await expect(acceptQuoteHandler(kinfolk({ invoiceId: quoteId }))).rejects.toMatchObject({
      details: { code: 'quote_visits_billed_elsewhere' },
    });
  });

  it('a declined quote holds nothing: archiving and restoring it move no visit and keep its record of them', async () => {
    const ctx = world();
    const quoteId = await sentQuote(['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const archived = await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(archived.releasedSessionIds).toEqual([]);
    expect((await docOf(ctx, `invoices/${quoteId}`))['releasedSessionIds']).toEqual(['s1']);
    const restored = await unarchiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(restored.reclaimedSessionIds).toEqual([]);
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
    expect((await docOf(ctx, `invoices/${quoteId}`))['releasedSessionIds']).toEqual(['s1']);
  });

  it('a quote saved unsent is archived like any draft and stays hidden after a restore', async () => {
    const ctx = world();
    const quoteId = await unsentQuote(['s1']);
    const archived = await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(archived.releasedSessionIds).toEqual(['s1']);
    await unarchiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    expect(await portalIds()).toEqual([]);
  });
});
