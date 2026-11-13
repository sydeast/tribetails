import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2156, operator ruling 2026-11-13: a quote built from visits holds them from
 * the start. They leave the "not yet invoiced" list the moment the quote is
 * made, so no second invoice can claim them, and a Kinfolk decline puts them
 * back. An accept keeps them: the quote becomes the invoice that bills them.
 * Every move goes through lib/invoiceSessionLinks.ts, the helper #2160 built
 * for invoices.
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
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { archiveInvoiceHandler } from '../src/admin/archiveInvoice';
import { resendQuoteHandler } from '../src/admin/resendQuote';
import { acceptQuoteHandler, denyQuoteHandler } from '../src/portal/quoteDecision';
import { sessionIdsFrom } from '../src/portal/getMyInvoices';
import { isSessionBillable } from '../src/lib/sessionInvoicing';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

/** An admin call (createQuote, createInvoice, updateInvoice, resendQuote, ...). */
function admin(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** The Kinfolk PRIMARY answering in MyTribe (acceptQuote / denyQuote). */
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

const line = (sessionId: string | undefined, unitCents = 4500) => ({
  description: '30 Minute Quick Check',
  qty: 1,
  unitCents,
  ...(sessionId ? { sessionId } : {}),
});

/** What the composer sends in quote mode for a quote drawn from visits. */
const composerQuote = (sessionIds: string[], extra: Record<string, unknown> = {}) => {
  const lineItems = sessionIds.map((id) => line(id));
  const total = (lineItems.length * 4500) / 100;
  return {
    familyId: 'fam1',
    kinfolkName: 'Test Household',
    client: 'Test Household',
    date: '2026-06-10',
    terms: '',
    dueDate: '',
    total,
    amountDue: total,
    status: '',
    sessionIds,
    lineItems,
    ...extra,
  };
};

/** The same, for New invoice. */
const composerDraft = (sessionIds: string[], extra: Record<string, unknown> = {}) => ({
  ...composerQuote(sessionIds),
  status: 'draft',
  ...extra,
});

/** Every fixture a quote's whole life touches: the Kinfolk who answers, the settings the expiry check reads. */
function world(extra: Record<string, Record<string, unknown>> = {}) {
  const ctx = buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['fam1'] },
      'families/fam1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      'business_settings/business_settings': { timeZone: 'America/Chicago' },
      'counters/invoiceNumber': { nextPlain: 1040 },
      'kin_care_sessions/s1': visit(),
      'kin_care_sessions/s2': visit({ startTime: '2026-06-03T14:00:00.000Z' }),
      'kin_care_sessions/s3': visit({ startTime: '2026-06-04T14:00:00.000Z' }),
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

/** Firestore's guarantee for two transactions touching one document: one at a time, the second re-reading. */
function serializeTransactions(ctx: ReturnType<typeof buildDbMock>) {
  const inner = ctx.db.runTransaction;
  let chain: Promise<unknown> = Promise.resolve();
  ctx.db.runTransaction = (fn: any) => {
    const run = chain.then(() => inner(fn));
    chain = run.catch(() => undefined);
    return run;
  };
}

async function makeQuote(ctx: ReturnType<typeof buildDbMock>, sessionIds: string[], key = 'quot_1700000002156_a') {
  const { invoiceId } = await createQuoteHandler(admin({ ...composerQuote(sessionIds), idempotencyKey: key }));
  return invoiceId;
}

// ── create ──────────────────────────────────────────────────────────────────

describe('#2156 createQuote holds its visits from the start', () => {
  it('marks every visit as held by the quote, so it leaves the not-yet-invoiced list at once', async () => {
    const ctx = world();
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
    const quoteId = await makeQuote(ctx, ['s1', 's2']);

    for (const sid of ['s1', 's2']) {
      const v = await docOf(ctx, `kin_care_sessions/${sid}`);
      expect(v['invoiceId']).toBe(quoteId);
      expect(v['_attribution']).toBe('manual');
      expect(isSessionBillable(v)).toBe(false);
    }
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['status']).toBe('quote');
    expect(q['sessionIds']).toEqual(['s1', 's2']);
    // One transaction: the quote and its holds land together or not at all.
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry as any).mock.calls[0][0].payload.sessionsLinked).toEqual(['s1', 's2']);
  });

  it('a line bound to a visit the id list left out is held too, and joins the set', async () => {
    const ctx = world();
    const { invoiceId } = await createQuoteHandler(
      admin({ ...composerQuote(['s1']), sessionIds: [], idempotencyKey: 'quot_1700000002156_b' }),
    );
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(invoiceId);
    expect((await docOf(ctx, `invoices/${invoiceId}`))['sessionIds']).toEqual(['s1']);
  });

  it('refuses a visit another invoice already bills, naming it, and writes nothing at all', async () => {
    const ctx = world({
      'invoices/invA': { kinfolkId: 'fam1', invoiceNumber: '1024', status: 'open' },
      'kin_care_sessions/s2': visit({ invoiceId: 'invA' }),
    });
    const before = ctx.writes.length;
    await expect(createQuoteHandler(admin(composerQuote(['s1', 's2'])))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Already billed on another invoice: the visit on 2026-06-02 is on invoice 1024. Unlink it there first.',
      details: { code: 'session_on_other_invoice' },
    });
    expect(ctx.writes.length).toBe(before);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBeUndefined();
  });

  it('refuses a cancelled visit, and writes nothing', async () => {
    const ctx = world({ 'kin_care_sessions/s1': visit({ status: 'cancelled' }) });
    await expect(createQuoteHandler(admin(composerQuote(['s1'])))).rejects.toMatchObject({
      details: { code: 'session_cancelled' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('New invoice for a visit a quote holds is refused, and says it is on a quote', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    const number = (await docOf(ctx, `invoices/${quoteId}`))['invoiceNumber'];
    await expect(createInvoiceHandler(admin(composerDraft(['s1'])))).rejects.toMatchObject({
      message: `Already on another quote or invoice: the visit on 2026-06-02 is on quote ${String(number)}. Remove it there first.`,
      details: { code: 'session_on_other_invoice', conflicts: [{ sessionId: 's1', invoiceId: quoteId }] },
    });
  });

  it('a New invoice save and a quote for the same visit at once: one holds it, the other is refused and writes nothing', async () => {
    const ctx = world();
    serializeTransactions(ctx);
    const [q, inv] = await Promise.allSettled([
      createQuoteHandler(admin({ ...composerQuote(['s1']), idempotencyKey: 'quot_1700000002156_r' })),
      createInvoiceHandler(admin({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000002156_r' })),
    ]);
    const won = [q, inv].filter((o) => o.status === 'fulfilled');
    const lost = [q, inv].filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ details: { code: 'session_on_other_invoice' } });
    const owner = (await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId'];
    if (q.status === 'fulfilled') {
      expect(owner).toBe('quot_1700000002156_r');
      expect((await ctx.db.doc('invoices/inv_1700000002156_r').get()).exists).toBe(false);
    } else {
      expect(owner).toBe('inv_1700000002156_r');
      expect((await ctx.db.doc('invoices/quot_1700000002156_r').get()).exists).toBe(false);
    }
  });
});

// ── decline ─────────────────────────────────────────────────────────────────

describe('#2156 a Kinfolk decline puts the visits back on the list', () => {
  it('lets go of every visit the quote held, in the decline transaction', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    const res = await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    expect(res.status).toBe('quote');

    for (const sid of ['s1', 's2']) {
      const v = await docOf(ctx, `kin_care_sessions/${sid}`);
      expect(v['invoiceId']).toBe('');
      expect(v['_attribution']).toBe('manual_unlink');
      expect(isSessionBillable(v)).toBe(true);
    }
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['quoteDecision']).toBe('denied');
    expect(q['sessionIds']).toEqual([]);
    expect(q['releasedSessionIds']).toEqual(['s1', 's2']);
    // The lines stay: they are the record of what was quoted.
    expect((q['lineItems'] as unknown[]).length).toBe(2);
    const audit = (writeAuditEntry as any).mock.calls.find((c: any[]) => c[0].event === 'BILLING_QUOTE_DENIED');
    expect(audit?.[0].payload.sessionsReleased).toEqual(['s1', 's2']);
  });

  it('a released visit can go on a New invoice straight after', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const { invoiceId } = await createInvoiceHandler(admin(composerDraft(['s1'])));
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(invoiceId);
  });

  it('#2160 review gap: a visit line added to the quote in Edit is released by the decline too', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await updateInvoiceHandler(admin({ invoiceId: quoteId, patch: { lineItems: [line('s1'), line('s2')] } }));
    expect((await docOf(ctx, 'kin_care_sessions/s2'))['invoiceId']).toBe(quoteId);

    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    for (const sid of ['s1', 's2']) {
      expect(isSessionBillable(await docOf(ctx, `kin_care_sessions/${sid}`))).toBe(true);
    }
    expect((await docOf(ctx, `invoices/${quoteId}`))['releasedSessionIds']).toEqual(['s1', 's2']);
  });

  it('a visit another invoice took is left with that invoice', async () => {
    // A legacy quote (made before holds) naming a visit New invoice billed since.
    const ctx = world({
      'invoices/q1': { kinfolkId: 'fam1', invoiceNumber: '1050', status: 'quote', invoiceStatus: 'quote', total: 90, amountDue: 90, sessionIds: ['s1', 's2'], lineItems: [line('s1'), line('s2')] },
      'kin_care_sessions/s1': visit({ invoiceId: 'q1' }),
      'kin_care_sessions/s2': visit({ invoiceId: 'invOther' }),
    });
    await denyQuoteHandler(kinfolk({ invoiceId: 'q1' }));
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe('');
    expect((await docOf(ctx, 'kin_care_sessions/s2'))['invoiceId']).toBe('invOther');
  });

  it('MyTribe still lists what a declined quote with no lines was for', () => {
    const declined = { status: 'quote', quoteDecision: 'denied' };
    expect(sessionIdsFrom({ ...declined, sessionIds: [], releasedSessionIds: ['s1', 's2'] })).toEqual(['s1', 's2']);
    expect(sessionIdsFrom({ ...declined, sessionIds: ['s3'], releasedSessionIds: ['s1'] })).toEqual(['s3']);
    expect(sessionIdsFrom({})).toEqual([]);
  });

  it('an archived draft does not show the visits archiving let go of as its own', () => {
    expect(sessionIdsFrom({ status: 'draft', archivedAt: '__TS__', sessionIds: [], releasedSessionIds: ['s1'] })).toEqual([]);
  });
});

// ── accept ──────────────────────────────────────────────────────────────────

describe('#2156 an accept keeps the visits: the quote is the invoice that bills them', () => {
  it('every visit still names the quote, now an open bill, and stays off the list', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    const writesBefore = ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/')).length;
    const res = await acceptQuoteHandler(kinfolk({ invoiceId: quoteId }));
    expect(res.status).toBe('open');

    // Nothing to claim: it already held them.
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/')).length).toBe(writesBefore);
    for (const sid of ['s1', 's2']) {
      const v = await docOf(ctx, `kin_care_sessions/${sid}`);
      expect(v['invoiceId']).toBe(quoteId);
      expect(isSessionBillable(v)).toBe(false);
    }
    expect((await docOf(ctx, `invoices/${quoteId}`))['sessionIds']).toEqual(['s1', 's2']);
    await expect(createInvoiceHandler(admin(composerDraft(['s1'])))).rejects.toMatchObject({
      details: { code: 'session_on_other_invoice' },
    });
  });

  it('a quote made before quotes held visits claims its free visits when accepted', async () => {
    const ctx = world({
      'invoices/q1': { kinfolkId: 'fam1', invoiceNumber: '1051', status: 'quote', invoiceStatus: 'quote', total: 45, amountDue: 45, sessionIds: ['s1'], lineItems: [line('s1')] },
    });
    await acceptQuoteHandler(kinfolk({ invoiceId: 'q1' }));
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe('q1');
  });

  it('refuses, in the household’s words, when another invoice now bills a visit a line is for, and writes nothing', async () => {
    const ctx = world({
      'invoices/q1': { kinfolkId: 'fam1', invoiceNumber: '1052', status: 'quote', invoiceStatus: 'quote', total: 90, amountDue: 90, sessionIds: ['s1', 's2'], lineItems: [line('s1'), line('s2')] },
      'kin_care_sessions/s2': visit({ invoiceId: 'invOther' }),
    });
    await expect(acceptQuoteHandler(kinfolk({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message:
        'This quote can no longer be accepted, because some of the work on it has been billed on another invoice since it was sent. Ask your Auntie for an up-to-date quote.',
      details: { code: 'quote_visits_billed_elsewhere' },
    });
    expect(ctx.writes).toHaveLength(0);
  });
});

// ── edit ────────────────────────────────────────────────────────────────────

describe('#2156 Edit of a quote moves holds with its lines', () => {
  it('while waiting for an answer: an added line holds its visit, a removed one lets it go', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    await updateInvoiceHandler(admin({ invoiceId: quoteId, patch: { lineItems: [line('s1'), line('s3')] } }));
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    expect((await docOf(ctx, 'kin_care_sessions/s2'))['invoiceId']).toBe('');
    expect((await docOf(ctx, 'kin_care_sessions/s3'))['invoiceId']).toBe(quoteId);
    expect((await docOf(ctx, `invoices/${quoteId}`))['sessionIds']).toEqual(['s1', 's3']);
  });

  it('a declined quote holds nothing: Edit writes no visit, and records what its lines now name', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const visitWrites = () => ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/')).length;
    const before = visitWrites();

    await updateInvoiceHandler(admin({ invoiceId: quoteId, patch: { lineItems: [line('s1'), line('s3')] } }));

    expect(visitWrites()).toBe(before);
    for (const sid of ['s1', 's2', 's3']) {
      expect(isSessionBillable(await docOf(ctx, `kin_care_sessions/${sid}`))).toBe(true);
    }
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['sessionIds']).toEqual([]);
    expect(q['releasedSessionIds']).toEqual(['s1', 's3']);
  });

  it('Link visits on a declined quote is refused in plain words, and writes nothing', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const before = ctx.writes.length;
    await expect(linkInvoiceSessionsHandler(admin({ invoiceId: quoteId, sessionIds: ['s2'] }))).rejects.toMatchObject({
      message: 'This quote was declined, so it holds no visits for now. Send it back out first, then link visits to it.',
      details: { code: 'quote_declined_holds_no_visits' },
    });
    expect(ctx.writes.length).toBe(before);
  });

  // A visit linked to a quote before declines let go of visits (Link visits,
  // or a line added in Edit) still names a quote that was declined before
  // this shipped. Edit and Link visits are the office's two ways to free it.
  const declinedBeforeHolds = () =>
    world({
      'invoices/q1': {
        kinfolkId: 'fam1', invoiceNumber: '1060', status: 'quote', invoiceStatus: 'quote', quoteDecision: 'denied',
        total: 90, amountDue: 90, sessionIds: ['s1', 's2'], lineItems: [line('s1')],
      },
      'kin_care_sessions/s1': visit({ invoiceId: 'q1' }),
      'kin_care_sessions/s2': visit({ invoiceId: 'q1' }),
    });

  it('Edit of a declined quote that drops a line lets go of a visit still linked to it', async () => {
    const ctx = declinedBeforeHolds();
    await updateInvoiceHandler(admin({ invoiceId: 'q1', patch: { lineItems: [line('s3')] } }));
    const s1 = await docOf(ctx, 'kin_care_sessions/s1');
    expect(s1['invoiceId']).toBe('');
    expect(isSessionBillable(s1)).toBe(true);
    // The added line takes no hold: the quote is still declined.
    expect((await docOf(ctx, 'kin_care_sessions/s3'))['invoiceId']).toBeUndefined();
  });

  it('Link visits on a declined quote can still unlink a visit linked to it, but links nothing', async () => {
    const ctx = declinedBeforeHolds();
    await linkInvoiceSessionsHandler(admin({ invoiceId: 'q1', sessionIds: ['s1'] }));
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s2'))).toBe(true);
    expect((await docOf(ctx, 'invoices/q1'))['sessionIds']).toEqual(['s1']);
    await expect(linkInvoiceSessionsHandler(admin({ invoiceId: 'q1', sessionIds: ['s1', 's3'] }))).rejects.toMatchObject({
      details: { code: 'quote_declined_holds_no_visits' },
    });
  });
});

// ── resend ──────────────────────────────────────────────────────────────────

describe('#2156 sending a declined quote back out takes its visits back', () => {
  it('re-holds exactly the visits its lines now name', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    await updateInvoiceHandler(admin({ invoiceId: quoteId, patch: { lineItems: [line('s1'), line('s3')] } }));

    const res = await resendQuoteHandler(admin({ invoiceId: quoteId }));
    expect(res.status).toBe('quote');

    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    expect((await docOf(ctx, 'kin_care_sessions/s3'))['invoiceId']).toBe(quoteId);
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s2'))).toBe(true);
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['sessionIds']).toEqual(['s1', 's3']);
    expect(q['releasedSessionIds']).toEqual([]);
  });

  it('is refused before the household is told when a line’s visit was billed in the meantime', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const { invoiceId: otherId } = await createInvoiceHandler(admin(composerDraft(['s1'])));
    const otherNumber = (await docOf(ctx, `invoices/${otherId}`))['invoiceNumber'];
    mocks.enqueue.mockClear();

    await expect(resendQuoteHandler(admin({ invoiceId: quoteId }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: `This quote cannot be sent back out: the visit on 2026-06-02 is billed on invoice ${String(otherNumber)}. Remove its line in Edit, then send it again.`,
      details: { code: 'quote_visits_not_billable' },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect((await docOf(ctx, `invoices/${quoteId}`))['quoteDecision']).toBe('denied');
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(otherId);
  });

  /** The household's resend notices, in the order they were asked for. */
  const resendNotices = () =>
    mocks.enqueue.mock.calls
      .map((c) => c[0] as { key: string; data?: { resent?: boolean }; dedupeKey?: string })
      .filter((a) => a.key === 'invoice.new' && a.data?.resent === true);

  it('the household is told only after the quote holds its visits again', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    let atNotice: Record<string, unknown> = {};
    mocks.enqueue.mockImplementationOnce(async () => {
      atNotice = await docOf(ctx, 'kin_care_sessions/s1');
      return ['n1'];
    });

    await resendQuoteHandler(admin({ invoiceId: quoteId }));

    // When the notice went out, the visit was already the quote's.
    expect(atNotice['invoiceId']).toBe(quoteId);
    expect(resendNotices()).toHaveLength(1);
  });

  it('a New invoice and a resend reaching for the same visit at once: one wins, and the household hears only if the quote did', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    mocks.enqueue.mockClear();
    serializeTransactions(ctx);

    const [resend, inv] = await Promise.allSettled([
      resendQuoteHandler(admin({ invoiceId: quoteId })),
      createInvoiceHandler(admin({ ...composerDraft(['s1']), idempotencyKey: 'inv_1700000002156_x' })),
    ]);
    const owner = (await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId'];
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect([resend.status, inv.status].sort()).toEqual(['fulfilled', 'rejected']);
    if (resend.status === 'fulfilled') {
      expect(owner).toBe(quoteId);
      expect(q['sessionIds']).toEqual(['s1']);
      expect((inv as PromiseRejectedResult).reason).toMatchObject({ details: { code: 'session_on_other_invoice' } });
      expect(resendNotices()).toHaveLength(1);
    } else {
      expect(owner).toBe('inv_1700000002156_x');
      expect(resend.reason).toMatchObject({ details: { code: 'quote_visits_not_billable' } });
      expect(q['quoteDecision']).toBe('denied');
      expect(resendNotices()).toHaveLength(0);
    }
  });

  it('a failed notice puts the quote back to declined and lets the visits it took go', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1', 's2']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    const declined = await docOf(ctx, `invoices/${quoteId}`);
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

    await expect(resendQuoteHandler(admin({ invoiceId: quoteId }))).rejects.toThrow('dispatcher down');

    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['quoteDecision']).toBe('denied');
    expect(q['sessionIds']).toEqual([]);
    expect(q['releasedSessionIds']).toEqual(declined['releasedSessionIds']);
    expect('quoteResendCount' in q).toBe(false);
    for (const sid of ['s1', 's2']) {
      const v = await docOf(ctx, `kin_care_sessions/${sid}`);
      expect(v['invoiceId']).toBe('');
      expect(isSessionBillable(v)).toBe(true);
    }
    // Back on the list, so New invoice can take one straight away.
    await createInvoiceHandler(admin(composerDraft(['s1'])));
  });

  it('a retry after a failed notice sends one notice, under the same resend number, and holds the visits', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    mocks.enqueue.mockClear();
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

    await expect(resendQuoteHandler(admin({ invoiceId: quoteId }))).rejects.toThrow('dispatcher down');
    const res = await resendQuoteHandler(admin({ invoiceId: quoteId }));

    expect(res.status).toBe('quote');
    const asked = resendNotices();
    expect(asked).toHaveLength(2);
    // The same identity both times: a notice the failed attempt did deliver
    // is a duplicate on the retry, not a second message.
    expect(asked.map((a) => a.dedupeKey)).toEqual([`quote:${quoteId}:resend:1`, `quote:${quoteId}:resend:1`]);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);
    const q = await docOf(ctx, `invoices/${quoteId}`);
    expect(q['quoteResendCount']).toBe(1);
    expect(q['sessionIds']).toEqual(['s1']);
  });
});

// ── archive ─────────────────────────────────────────────────────────────────

describe('#2156 archiving a quote keeps its visits held', () => {
  it('the Kinfolk can still answer it, so nothing goes back on the list until they decline', async () => {
    const ctx = world();
    const quoteId = await makeQuote(ctx, ['s1']);
    const archived = await archiveInvoiceHandler(admin({ invoiceId: quoteId }));
    expect(archived.releasedSessionIds).toEqual([]);
    expect((await docOf(ctx, 'kin_care_sessions/s1'))['invoiceId']).toBe(quoteId);

    await denyQuoteHandler(kinfolk({ invoiceId: quoteId }));
    expect(isSessionBillable(await docOf(ctx, 'kin_care_sessions/s1'))).toBe(true);
  });
});
